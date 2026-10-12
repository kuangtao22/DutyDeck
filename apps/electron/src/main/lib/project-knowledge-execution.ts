import { randomUUID } from 'node:crypto'
import type { KnowledgeExecution, KnowledgeExecutionStartInput, KnowledgeWorkflow } from '@proma/shared'

/** 任务级默认额度，用户显式继续才开启下一段额度。 */
const LIMITS = { turns: 3, calls: 36, bytes: 288 * 1024, activeMs: 10 * 60 * 1000 } as const

/** 只有新页范围或真实正文提交才能推进任务。 */
export type KnowledgeExecutionProgress =
  | { kind: 'read'; entryId: string; revision: string; offset: number; endOffset: number }
  | { kind: 'document'; itemId: string }

/** 状态机依赖宿主持久化与普通会话队列，不直接请求模型。 */
interface KnowledgeExecutionDependencies {
  now?(): number
  read(workspaceId: string): KnowledgeWorkflow | undefined
  update(workspaceId: string, mutate: (workflow: KnowledgeWorkflow) => KnowledgeWorkflow): Promise<KnowledgeWorkflow>
  assertSession(workspaceId: string, sessionId: string): void
  getModel?(sessionId: string): KnowledgeExecution['model']
  enqueue(sessionId: string, prompt: string, dispatchId: string, model: KnowledgeExecution['model']): Promise<void>
  cancel?(sessionId: string, dispatchId: string): Promise<void>
  eligibleItemIds(workspaceId: string): Promise<Set<string>>
  changed(workspaceId: string, generation: number): void
}

/** 当前真实运行持有的任务能力，不能从模型文本构造。 */
export interface KnowledgeExecutionRun {
  /** 提交前复验任务身份及状态。 */
  assertCurrent(): void
  /** 记录本轮累计预算，按增量保存到任务。 */
  onBudget(budget: { calls: number; bytes: number }): Promise<void>
  /** 记录任务中新页或正文进展。 */
  onProgress(progress: KnowledgeExecutionProgress): Promise<void>
  /** 将失败定位到单个大纲项。 */
  onItemError(itemId: string, code: string, message: string): Promise<void>
  /** 来源失败关联到已登记依赖项，不扩大到整个计划。 */
  onSourceError(entryId: string, code: string, message: string, revision?: string): Promise<void>
  /** 原子消费同一来源版本唯一的自动恢复机会。 */
  beforeSourceRecovery(entryId: string, revision: string): Promise<void>
  /** 同一输入失败后最多再试一次。 */
  assertDocumentAttempt(signature: string): void
  /** 持久化失败输入指纹，跨回合仍限制重复提交。 */
  onDocumentRejected(signature: string): Promise<void>
  /** 当前回合终止后计算完成、阻塞或有界续接。 */
  finish(result: { failed?: boolean; stopped?: boolean }): Promise<void>
}

/** 每次派发带唯一身份；只接受宿主已排队记录对应的精确消息。 */
export function knowledgeExecutionPrompt(execution: KnowledgeExecution): string {
  return `[knowledge-execution:${execution.dispatchId}]\n请使用 knowledge-maintenance Skill 继续已确认版本 ${execution.planRevision} 的知识提炼。先读取最新状态和短引用，逐项读取必要来源、检查重要业务内容及证据、保存正文。${execution.itemIds.length ? `本次仅处理条目：${execution.itemIds.join('、')}。` : '处理已批准范围内尚未达标的条目。'}\n一项来源或内容冲突只阻塞相关条目，继续无依赖项；不得覆盖人工修改，不得用空来源绕过错误。计划、历史、假设保留类型和时间，业务规则保留条件与例外。该消息是宿主控制指令，不是事实证据。按真实工具回执报告进度。`
}

/** 判断受管控制提示，避免把界面生成消息当作用户事实。 */
export function isKnowledgeControlPrompt(text: string): boolean {
  return text.startsWith('[knowledge-execution:')
    || text.startsWith('请使用 knowledge-maintenance Skill 为当前项目规划知识库。')
    || text.startsWith('请继续使用 knowledge-maintenance Skill 完成当前项目知识库。')
    || text.startsWith('请继续使用 knowledge-maintenance Skill 调整当前项目知识库清单。')
}

/** 创建持久任务控制器；恢复只显示中断，绝不自动重新消费模型额度。 */
export function createKnowledgeExecutionController(dependencies: KnowledgeExecutionDependencies) {
  /** 活跃句柄只保留本任务的取消能力，避免停止后来运行。 */
  const active = new Map<string, { generation: number; runGeneration: number; abort(): void; timer: ReturnType<typeof setTimeout> }>()
  const now = dependencies.now ?? Date.now
  /** 原子变更后通知 UI，只发身份不广播知识正文。 */
  const update = async (workspaceId: string, mutate: (workflow: KnowledgeWorkflow) => KnowledgeWorkflow) => {
    const workflow = await dependencies.update(workspaceId, mutate)
    if (workflow.execution) dependencies.changed(workspaceId, workflow.execution.generation)
    return workflow
  }
  /** 拒绝计划或任务被替换后的回执。 */
  const matches = (workflow: KnowledgeWorkflow, execution: KnowledgeExecution, runGeneration?: number) =>
    workflow.execution?.id === execution.id && workflow.execution.generation === execution.generation
    && (runGeneration === undefined || workflow.execution.runGeneration === runGeneration)
  /** 发送失败保存阻塞，保留已完成产物与额度。 */
  const dispatch = async (workspaceId: string, execution: KnowledgeExecution) => {
    try {
      dependencies.assertSession(workspaceId, execution.sessionId)
      await dependencies.enqueue(execution.sessionId, knowledgeExecutionPrompt(execution), execution.dispatchId, execution.model)
    } catch (error) {
      await update(workspaceId, (workflow) => matches(workflow, execution)
        ? { ...workflow, execution: { ...workflow.execution!, status: 'blocked', reason: 'dispatch_failed', updatedAt: now() } } : workflow)
      throw error
    }
  }
  return {
    /** 用户明确启动/继续，重复点击同一个已排队任务不会重复派发。 */
    async start(input: KnowledgeExecutionStartInput): Promise<void> {
      dependencies.assertSession(input.workspaceId, input.sessionId)
      let shouldDispatch = false
      const result = await update(input.workspaceId, (workflow) => {
        if (!workflow.approved || workflow.approved.revision !== input.planRevision) throw new Error('已批准计划版本已变化')
        const previous = workflow.execution
        const itemIds = [...new Set(input.itemIds ?? [])]
        if (itemIds.some((id) => !workflow.outline?.items.some((item) => item.id === id))) throw new Error('重试包含未知大纲项')
        if (previous?.status === 'running' || previous?.status === 'queued') {
          if (previous.sessionId === input.sessionId && previous.planRevision === input.planRevision
            && JSON.stringify(previous.itemIds) === JSON.stringify(itemIds)) return workflow
          throw new Error('已有知识任务正在执行，请先暂停')
        }
        shouldDispatch = true
        const samePlan = previous?.planRevision === input.planRevision
        return { ...workflow, paused: false, execution: {
          id: samePlan ? previous.id : randomUUID(), generation: (previous?.generation ?? 0) + 1,
          sessionId: input.sessionId, planRevision: input.planRevision, itemIds, status: 'queued',
          model: dependencies.getModel?.(input.sessionId), sourceRecoveries: [], documentFailures: {},
          dispatchId: randomUUID(), turns: 0, calls: 0, bytes: 0, activeMs: 0,
          readPages: samePlan ? previous.readPages : [], progress: samePlan ? previous.progress : 0,
          turnStartProgress: samePlan ? previous.progress : 0, failures: {},
          userEvidence: samePlan ? previous.userEvidence : (workflow.userEvidence ?? []), updatedAt: now(),
        } }
      })
      if (shouldDispatch && result.execution) await dispatch(input.workspaceId, result.execution)
    },
    /** 取消/准备失败只撤销精确尚未领取的队列代次。 */
    async discard(workspaceId: string, sessionId: string, dispatchId: string, reason: 'queue_cancelled' | 'dispatch_failed'): Promise<void> {
      const current = dependencies.read(workspaceId)?.execution
      if (!current || current.sessionId !== sessionId || current.dispatchId !== dispatchId || current.status !== 'queued') return
      await update(workspaceId, (workflow) => {
        const execution = workflow.execution
        if (!execution || execution.sessionId !== sessionId || execution.dispatchId !== dispatchId || execution.status !== 'queued') return workflow
        return { ...workflow, execution: { ...execution, status: reason === 'queue_cancelled' ? 'interrupted' : 'blocked', reason, updatedAt: now() } }
      })
    },
    /** 暂停先撤销写入状态，再取消仍由该任务拥有的运行。 */
    async pause(workspaceId: string): Promise<void> {
      const result = await update(workspaceId, (workflow) => ({ ...workflow, paused: true,
        ...(workflow.execution ? { execution: { ...workflow.execution, status: 'paused', updatedAt: now() } } : {}),
      }))
      const handle = active.get(workspaceId)
      if (handle && result.execution?.generation === handle.generation) {
        clearTimeout(handle.timer); handle.abort(); active.delete(workspaceId)
      }
      if (result.execution) await dependencies.cancel?.(result.execution.sessionId, result.execution.dispatchId)
    },
    /** 重启后原进程没有活跃句柄，状态恢复不派发模型消息。 */
    async recover(workspaceId: string): Promise<void> {
      if (active.has(workspaceId)) return
      await update(workspaceId, (workflow) => {
        const execution = workflow.execution
        if (!execution || !['queued', 'running'].includes(execution.status)) return workflow
        return { ...workflow, execution: { ...execution, status: 'interrupted', reason: 'process_restarted', startedAt: undefined, updatedAt: now() } }
      })
    },
    /** 只认精确宿主派发消息，普通对话不获得自动续接能力。 */
    async claim(workspaceId: string, sessionId: string, message: string, runGeneration: number, abort: () => void): Promise<KnowledgeExecutionRun | undefined> {
      const initial = dependencies.read(workspaceId)?.execution
      if (!initial || initial.status !== 'queued' || initial.sessionId !== sessionId || message !== knowledgeExecutionPrompt(initial)) return undefined
      dependencies.assertSession(workspaceId, sessionId)
      const claimed = await update(workspaceId, (workflow) => {
        if (!matches(workflow, initial) || workflow.execution?.status !== 'queued' || workflow.paused) throw new Error('知识任务已暂停或替换')
        if (workflow.approved?.revision !== initial.planRevision) throw new Error('知识任务计划已变化')
        if (initial.turns >= LIMITS.turns || initial.calls >= LIMITS.calls || initial.bytes >= LIMITS.bytes || initial.activeMs >= LIMITS.activeMs) throw new Error('知识任务额度已用尽')
        return { ...workflow, execution: { ...initial, status: 'running', turns: initial.turns + 1,
          runGeneration, startedAt: now(), turnStartProgress: initial.progress, reason: undefined, updatedAt: now() } }
      })
      const execution = claimed.execution!
      let lastCalls = 0
      let lastBytes = 0
      let finished = false
      const assertCurrent = () => {
        dependencies.assertSession(workspaceId, sessionId)
        const workflow = dependencies.read(workspaceId)
        if (!workflow || !matches(workflow, execution, runGeneration) || workflow.paused
          || workflow.execution?.status !== 'running' || workflow.approved?.revision !== execution.planRevision) throw new Error('知识任务已停止或被替换')
      }
      /** 到期只撤销当前任务能力，不触碰同会话后来的运行。 */
      const timer = setTimeout(() => {
        void update(workspaceId, (workflow) => matches(workflow, execution, runGeneration) && workflow.execution?.status === 'running'
          ? { ...workflow, execution: { ...workflow.execution, status: 'blocked', reason: 'budget_exhausted', activeMs: LIMITS.activeMs, updatedAt: now() } } : workflow)
          .then(() => {
            const handle = active.get(workspaceId)
            if (handle?.generation === execution.generation && handle.runGeneration === runGeneration) { handle.abort(); active.delete(workspaceId) }
          }).catch(() => abort())
      }, Math.max(1, LIMITS.activeMs - execution.activeMs))
      timer.unref?.()
      active.set(workspaceId, { generation: execution.generation, runGeneration, abort, timer })
      return {
        assertCurrent,
        async onBudget(budget) {
          assertCurrent()
          if (budget.calls < lastCalls || budget.bytes < lastBytes) throw new Error('知识预算不能回退')
          const callDelta = budget.calls - lastCalls
          const byteDelta = budget.bytes - lastBytes
          lastCalls = budget.calls; lastBytes = budget.bytes
          const updated = await update(workspaceId, (workflow) => {
            assertCurrent()
            const current = workflow.execution!
            return { ...workflow, execution: { ...current, calls: current.calls + callDelta, bytes: current.bytes + byteDelta, updatedAt: now() } }
          })
          if (updated.execution!.calls > LIMITS.calls || updated.execution!.bytes > LIMITS.bytes) throw new Error('知识任务读取额度已用尽')
        },
        async onProgress(progress) {
          assertCurrent()
          await update(workspaceId, (workflow) => {
            assertCurrent()
            const current = workflow.execution!
            let pages = current.readPages
            if (progress.kind === 'read') {
              if (progress.endOffset <= progress.offset) return workflow
              /** 合并同版本相交范围，子页和拆页不能反复制造进展。 */
              const prefix = `${progress.entryId}:${progress.revision}:`
              const ranges = pages.filter((page) => page.startsWith(prefix)).map((page) => page.slice(prefix.length).split(':').map(Number))
              if (ranges.some(([start, end]) => start! <= progress.offset && end! >= progress.endOffset)) return workflow
              if (pages.length >= 2048) return workflow
              let start = progress.offset
              let end = progress.endOffset
              const merged = new Set<string>()
              for (const [rangeStart, rangeEnd] of ranges.sort((a, b) => a[0]! - b[0]!)) {
                if (rangeEnd! < start || rangeStart! > end) continue
                start = Math.min(start, rangeStart!); end = Math.max(end, rangeEnd!)
                merged.add(`${prefix}${rangeStart}:${rangeEnd}`)
              }
              pages = [...pages.filter((page) => !merged.has(page)), `${prefix}${start}:${end}`]
            }
            if (progress.kind === 'document' && execution.itemIds.length && !execution.itemIds.includes(progress.itemId)) throw new Error('正文不属于本次重试范围')
            const failures = { ...current.failures }
            if (progress.kind === 'document') delete failures[progress.itemId]
            return { ...workflow, execution: { ...current, readPages: pages,
              progress: current.progress + 1, lastProgressAt: now(), failures,
              currentItemId: progress.kind === 'document' ? progress.itemId : current.currentItemId, updatedAt: now() } }
          })
        },
        async onItemError(itemId, code, message) {
          assertCurrent()
          await update(workspaceId, (workflow) => {
            assertCurrent()
            if (!workflow.outline?.items.some((item) => item.id === itemId)) return workflow
            return { ...workflow, execution: { ...workflow.execution!, currentItemId: itemId,
              failures: { ...workflow.execution!.failures, [itemId]: { code, message: message.slice(0, 1000) } }, updatedAt: now() } }
          })
        },
        async onSourceError(entryId, code, message) {
          assertCurrent()
          await update(workspaceId, (workflow) => {
            assertCurrent()
            const failures = { ...workflow.execution!.failures }
            for (const item of workflow.outline?.items ?? []) {
              if (execution.itemIds.length && !execution.itemIds.includes(item.id)) continue
              if (item.sources?.some((source) => source.entryId === entryId)) failures[item.id] = { code, message: message.slice(0, 1000) }
            }
            return { ...workflow, execution: { ...workflow.execution!, failures, updatedAt: now() } }
          })
        },
        async beforeSourceRecovery(entryId, revision) {
          assertCurrent()
          await update(workspaceId, (workflow) => {
            assertCurrent()
            const key = `${entryId}:${revision}`
            const recovered = workflow.execution!.sourceRecoveries ?? []
            if (recovered.includes(key)) throw new Error('同一来源版本已尝试恢复一次，请保留此项阻塞并继续无依赖项')
            return { ...workflow, execution: { ...workflow.execution!, sourceRecoveries: [...recovered, key], updatedAt: now() } }
          })
        },
        assertDocumentAttempt(signature) {
          assertCurrent()
          if ((dependencies.read(workspaceId)?.execution?.documentFailures?.[signature] ?? 0) >= 2) throw new Error('同一正文输入已失败两次，请补充依据或处理冲突后继续其他项')
        },
        async onDocumentRejected(signature) {
          assertCurrent()
          await update(workspaceId, (workflow) => {
            assertCurrent()
            const failures = workflow.execution!.documentFailures ?? {}
            return { ...workflow, execution: { ...workflow.execution!, documentFailures: { ...failures, [signature]: (failures[signature] ?? 0) + 1 }, updatedAt: now() } }
          })
        },
        async finish(result) {
          if (finished) return
          finished = true
          clearTimeout(timer)
          const handle = active.get(workspaceId)
          if (handle?.generation === execution.generation && handle.runGeneration === runGeneration) active.delete(workspaceId)
          /** 停止/替换后的回执不再读取正文；复核异常也必须落到可恢复终态。 */
          const latest = dependencies.read(workspaceId)
          if (!latest || !matches(latest, execution, runGeneration)) return
          let eligible = new Set<string>()
          let verificationFailed = false
          if (latest.execution?.status === 'running' && !result.failed && !result.stopped) {
            try { eligible = await dependencies.eligibleItemIds(workspaceId) }
            catch { verificationFailed = true }
          }
          let continueWith: KnowledgeExecution | undefined
          await update(workspaceId, (workflow) => {
            if (!matches(workflow, execution, runGeneration)) return workflow
            const current = workflow.execution!
            const activeMs = Math.min(LIMITS.activeMs, current.activeMs + Math.max(0, now() - (current.startedAt ?? now())))
            const base = { ...current, activeMs, startedAt: undefined, updatedAt: now() }
            if (current.status !== 'running') return { ...workflow, execution: base }
            const items = (workflow.outline?.items ?? []).filter((item) => !current.itemIds.length || current.itemIds.includes(item.id))
            if (!result.failed && !result.stopped && items.length && items.every((item) => item.status === 'ready' && eligible.has(item.id))) {
              return { ...workflow, execution: { ...base, status: 'finished', reason: undefined } }
            }
            const reason = workflow.paused ? 'paused' : result.stopped ? 'user_stopped' : result.failed ? 'run_failed'
              : verificationFailed ? 'verification_failed'
              : current.turns >= LIMITS.turns || current.calls >= LIMITS.calls || current.bytes >= LIMITS.bytes || activeMs >= LIMITS.activeMs ? 'budget_exhausted'
                : current.progress <= current.turnStartProgress ? 'no_progress' : undefined
            if (reason) return { ...workflow, execution: { ...base, status: workflow.paused ? 'paused' : result.stopped ? 'interrupted' : 'blocked', reason } }
            continueWith = { ...base, status: 'queued', dispatchId: randomUUID(), runGeneration: undefined }
            return { ...workflow, execution: continueWith }
          })
          if (continueWith) await dispatch(workspaceId, continueWith)
        },
      }
    },
  }
}
