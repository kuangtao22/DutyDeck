import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getConfigDir, resolveWorkspaceFilesDir } from './config-paths'
import { acquireWorkspaceWriteLease, getWorkspaceOperationBlockReason } from './workspace-operation-lock'
import { isWorkspaceSlug } from './workspace-slug'
import { createProjectKnowledgeService } from './project-knowledge/service'
import type { KnowledgeScanGuard } from './project-knowledge/service'
import { isOrdinaryTopLevelAgentSession } from '@proma/shared'
import type { KnowledgeExecution, KnowledgeExecutionStartInput, KnowledgeImportMode, KnowledgeSnapshot } from '@proma/shared'
import type { ProjectKnowledgeIpcService } from './project-knowledge-ipc'
import type { ResolvedKnowledgeProject } from './project-knowledge/types'
import { getAgentSessionMeta, getLatestPersistedUserEvidence, getPersistedAgentMessageReceipt, isAgentSessionDeleting, readPersistedAgentEvidence } from './agent-session-manager'
import { createProjectKnowledgeAgentMaintenance } from './project-knowledge-agent-maintenance'
import type { ProjectKnowledgeAgentMaintenance } from './project-knowledge-agent-maintenance'
import type { ProjectKnowledgeSources } from './project-knowledge-sources'
import { previewKnowledgeMemory } from './project-knowledge-memory-preview'
import { createKnowledgeExecutionController, isKnowledgeControlPrompt } from './project-knowledge-execution'
import type { KnowledgeExecutionRun } from './project-knowledge-execution'

/** 每个数据根独立的服务实例，避免数据根切换后误用旧索引。 */
const services = new Map<string, ProjectKnowledgeRuntime>()
/** Canvas 依赖在 IPC 组合完成后注入，检索服务始终通过已授权业务服务读取。 */
let controlledSources: ProjectKnowledgeSources | undefined
/** 应用启动时注册普通会话队列与状态通知，运行时不依赖 Electron。 */
let executionHost: {
  enqueue(sessionId: string, prompt: string, dispatchId: string, model: KnowledgeExecution['model']): Promise<void>
  cancel?(sessionId: string, dispatchId: string): Promise<void>
  changed(workspaceId: string, generation: number): void
} | undefined

/** 路径只由 Electron 宿主的原生选择器提供，不进入模型工具参数。 */
let importSelector: ((mode: KnowledgeImportMode) => Promise<string[]>) | undefined
/** 由主进程注入与面板共用的选择器；运行时不直接依赖 Electron。 */
export function registerKnowledgeImportSelector(select: NonNullable<typeof importSelector>): void {
  importSelector = select
}

/** 只中断本轮等待，不取消共享后台扫描或关闭用户已打开的系统对话框。 */
async function awaitKnowledgeSourceOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  signal.throwIfAborted()
  /** 移除监听器避免长期运行的会话累积取消处理器。 */
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('知识来源操作已取消'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
}

/** 绑定宿主已有会话队列，禁止另建后台模型执行器。 */
export function registerKnowledgeExecutionHost(host: NonNullable<typeof executionHost>): void {
  executionHost = host
}

/** 绑定由宿主持有的 Canvas/API 服务，不暴露可替换文件路径。 */
export function registerProjectKnowledgeSources(sources: ProjectKnowledgeSources): void {
  controlledSources = sources
}

/** 运行时公开已授权的读写端口，底层 store 仅供宿主内部调用。 */
interface ProjectKnowledgeRuntime extends ProjectKnowledgeIpcService {
  startExecution(input: KnowledgeExecutionStartInput): Promise<KnowledgeSnapshot>
  claimExecution(sessionId: string, message: string, runGeneration: number, abort: () => void): Promise<KnowledgeExecutionRun | undefined>
  recoverExecution(workspaceId: string): Promise<void>
  discardExecutionDispatch(workspaceId: string, sessionId: string, dispatchId: string, reason: 'queue_cancelled' | 'dispatch_failed'): Promise<void>
  getTaskUserEvidence(sessionId: string): Array<{ id: string; text: string }>
  /** 扫描后台完成句柄。 */
  waitForScan(workspaceId: string): Promise<void>
  /** 当前 Agent 的受控写入端口，模型和 Skill 由当前回合负责。 */
  createAgentMaintenance(input: AgentKnowledgeMaintenanceInput): ProjectKnowledgeAgentMaintenance
  /** 退役旧独立模型队列，不丢弃已有知识与排除记录。 */
  retireLegacyMaintenance(workspaceId: string): Promise<void>
}

/** 固定当前用户回合及其动态权限，不允许模型指定会话身份。 */
interface AgentKnowledgeMaintenanceInput {
  sessionId: string
  userMessageId: string
  assertRunActive(): void
  canMutate(): boolean
  /** 已由宿主派发并领取的任务能力。 */
  execution?: KnowledgeExecutionRun
}

/** 验证项目归属；返回指纹供异步 IPC 前后复核。 */
export function getProjectKnowledgeBinding(workspaceId: string): string {
  /** 仅使用权威工作区索引，拒绝调用方传入 slug 或任意路径。 */
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace || workspace.id !== workspaceId || !isWorkspaceSlug(workspace.slug)) throw new Error('项目不存在或知识库归属无效')
  return `${getConfigDir()}\0${workspace.id}\0${workspace.slug}\0${workspace.projectRootPath ?? resolveWorkspaceFilesDir(workspace.slug)}`
}

/** 创建或取得当前数据根的知识服务；此过程不扫描、不创建资料。 */
export function getProjectKnowledgeService(): ProjectKnowledgeRuntime {
  /** 数据根随配置迁移变化，不能在模块加载时固定。 */
  const configRoot = getConfigDir()
  const existing = services.get(configRoot)
  if (existing) return existing
  /** 底层服务每次操作均重新读取工作区绑定。 */
  const resolveProject = (workspaceId: string): ResolvedKnowledgeProject => {
      getProjectKnowledgeBinding(workspaceId)
      if (getConfigDir() !== configRoot) throw new Error('数据目录已变化，请重新打开知识库')
      const workspace = getAgentWorkspace(workspaceId)
      if (!workspace) throw new Error('项目不存在')
      return {
        projectId: workspace.id,
        projectRoot: workspace.projectRootPath ?? resolveWorkspaceFilesDir(workspace.slug),
        memoryRoot: join(configRoot, 'agent-workspaces', workspace.slug, 'memory'),
        cacheRoot: join(configRoot, 'knowledge-cache', workspace.id),
      }
    }
  const service = createProjectKnowledgeService({
    resolveProject,
    revalidateUserEvidence: async (workspaceId, evidence) => {
      /** 仅精确重读已登记原消息；不检索或扫描会话历史。 */
      const owner = getAgentSessionMeta(evidence.sessionId)
      if (!isOrdinaryTopLevelAgentSession(owner) || owner.workspaceId !== workspaceId || owner.archived
        || isAgentSessionDeleting(evidence.sessionId)) return 'unavailable'
      const receipt = getPersistedAgentMessageReceipt(evidence.sessionId, evidence.messageId)
      if (!receipt) return 'unavailable'
      const message = readPersistedAgentEvidence(evidence.sessionId, [receipt]).records.find((record) => record.uuid === evidence.messageId)
      if (!message || message.role !== 'user' || isKnowledgeControlPrompt(message.text)) return 'unavailable'
      const fingerprint = createHash('sha256').update(message.text, 'utf8').digest('hex')
      return fingerprint === evidence.sha256 && message.text.includes(evidence.quote) ? 'current' : 'changed'
    },
    controlledSources: {
      list: async (projectId) => {
        getProjectKnowledgeBinding(projectId)
        return controlledSources?.list(projectId) ?? { sources: [], total: 0, truncated: false, skipped: 0 }
      },
      read: async (input) => {
        getProjectKnowledgeBinding(input.projectId)
        return controlledSources?.read(input) ?? { status: 'unavailable', content: '', truncated: false }
      },
    },
    assertWritable: (workspaceId) => {
      getProjectKnowledgeBinding(workspaceId)
      const reason = getWorkspaceOperationBlockReason(workspaceId)
      if (reason) throw new Error(reason)
    },
  })
  /** 每次派发/续接均复核会话归属和模式。 */
  const assertExecutionSession = (workspaceId: string, sessionId: string): void => {
    const session = getAgentSessionMeta(sessionId)
    if (!isOrdinaryTopLevelAgentSession(session) || session.archived || session.workspaceId !== workspaceId
      || session.explorationParentSessionId || (session.toolMode ?? 'standard') !== 'standard'
      || session.permissionMode === 'plan' || isAgentSessionDeleting(sessionId)) throw new Error('知识整理会话已失效或当前只允许规划')
    getProjectKnowledgeBinding(workspaceId)
  }
  /** 状态事务复用原写租约与 manifest 原子写，不另建任务数据库。 */
  const execution = createKnowledgeExecutionController({
    read: (workspaceId) => service.store.readManifest(resolveProject(workspaceId))?.workflow,
    update: async (workspaceId, mutate) => {
      const release = acquireWorkspaceWriteLease(workspaceId)
      try {
        const manifest = await service.store.transact(resolveProject(workspaceId), workspaceId, ({ manifest }) => {
          const previous = manifest.workflow ?? { paused: false }
          const next = mutate(previous)
          return next === previous ? {} : { workflow: next }
        })
        return manifest.workflow ?? { paused: false }
      } finally { release() }
    },
    assertSession: assertExecutionSession,
    getModel: (sessionId) => {
      const session = getAgentSessionMeta(sessionId)
      return { channelId: session?.channelId, modelId: session?.modelId }
    },
    enqueue: async (sessionId, prompt, dispatchId, model) => {
      if (!executionHost) throw new Error('普通会话队列尚未就绪')
      await executionHost.enqueue(sessionId, prompt, dispatchId, model)
    },
    cancel: async (sessionId, dispatchId) => { await executionHost?.cancel?.(sessionId, dispatchId) },
    eligibleItemIds: async (workspaceId) => {
      const workflow = service.store.readManifest(resolveProject(workspaceId))?.workflow
      const task = workflow?.execution
      const items = (workflow?.outline?.items ?? []).filter((item) => item.status === 'ready' && item.entryId
        && (!task?.itemIds.length || task.itemIds.includes(item.id)))
      const eligible = new Set<string>()
      /** 最多四份并行复验，不能从最多200条的目录快照推断全部正文。 */
      for (let offset = 0; offset < items.length; offset += 4) {
        const results = await Promise.allSettled(items.slice(offset, offset + 4).map(async (item) => {
          const result = await service.read({ workspaceId, entryId: item.entryId!, offset: 0 })
          if (result.status === 'readable' && result.entry.admission?.status === 'eligible') eligible.add(item.id)
        }))
        for (const result of results) if (result.status === 'rejected') console.warn('[知识任务] 正文准入复核失败:', result.reason)
      }
      return eligible
    },
    changed: (workspaceId, generation) => executionHost?.changed(workspaceId, generation),
  })
  /** 按任务登记身份重读原文；内容变化、删除、跨工作区或控制提示均失效。 */
  const resolveTaskEvidence = (sessionId: string, id: string) => {
    const session = getAgentSessionMeta(sessionId)
    if (!session?.workspaceId) return undefined
    assertExecutionSession(session.workspaceId, sessionId)
    const task = service.store.readManifest(resolveProject(session.workspaceId))?.workflow?.execution
    if (task?.sessionId !== sessionId || task.status !== 'running') return undefined
    const identity = task.userEvidence.find((candidate) => candidate.id === id)
    if (!identity) return undefined
    const owner = getAgentSessionMeta(identity.sessionId)
    if (!isOrdinaryTopLevelAgentSession(owner) || owner.workspaceId !== session.workspaceId || owner.archived) return undefined
    const receipt = getPersistedAgentMessageReceipt(identity.sessionId, identity.messageId)
    if (!receipt) return undefined
    const message = readPersistedAgentEvidence(identity.sessionId, [receipt]).records.find((candidate) => candidate.uuid === identity.messageId)
    if (!message || message.role !== 'user' || message.sha256 !== identity.sha256 || isKnowledgeControlPrompt(message.text)) return undefined
    return { sessionId: identity.sessionId, message }
  }
  /** 每次扫描持有迁移租约直到后台任务结束，IPC 返回 running 不释放租约。 */
  const startScan = service.startScan.bind(service)
  service.startScan = async (workspaceId: string, guard?: KnowledgeScanGuard): Promise<KnowledgeSnapshot> => {
    /** 租约从初始化前开始持有；同步失败与后台完成都必须释放。 */
    const release = acquireWorkspaceWriteLease(workspaceId)
    try {
      /** 只有本次真正启动的后台任务才持有额外租约，共享等待不新增长期租约。 */
      let ownsScan = false
      const snapshot = await startScan(workspaceId, guard, () => { ownsScan = true })
      if (ownsScan) void service.waitForScan(workspaceId).catch(() => undefined).finally(release)
      else release()
      return snapshot
    } catch (error) {
      release()
      throw error
    }
  }
  /** 所有 Agent 发布都持有迁移租约，证据校验由同一当前回合闭包提供。 */
  const createAgentMaintenance = (input: AgentKnowledgeMaintenanceInput): ProjectKnowledgeAgentMaintenance => {
    /** 只允许当前普通顶层会话，不接受调用方指定项目。 */
    const initial = getAgentSessionMeta(input.sessionId)
    if (!isOrdinaryTopLevelAgentSession(initial) || !initial.workspaceId) throw new Error('当前会话不能维护项目知识')
    const workspaceId = initial.workspaceId
    const binding = getProjectKnowledgeBinding(workspaceId)
    /** 每次读取及事务发布重新校验归属和运行代次。 */
    const assertCurrent = (): void => {
      input.assertRunActive()
      input.execution?.assertCurrent()
      const current = getAgentSessionMeta(input.sessionId)
      if (getConfigDir() !== configRoot || isAgentSessionDeleting(input.sessionId)
        || !isOrdinaryTopLevelAgentSession(current) || current.archived
        || current.explorationParentSessionId !== undefined || current.workspaceId !== workspaceId
        || (current.toolMode ?? 'standard') !== 'standard'
        || getProjectKnowledgeBinding(workspaceId) !== binding) throw new Error('知识维护会话或项目归属已变化')
    }
    assertCurrent()
    /** 当前会话补充提示是控制消息；把证据锚定到它之前最近一条用户消息，且只读尾部 512 KiB。 */
    let maintenanceUserMessageId = input.userMessageId
    const controlReceipt = getPersistedAgentMessageReceipt(input.sessionId, input.userMessageId)
    const controlMessage = controlReceipt ? readPersistedAgentEvidence(input.sessionId, [controlReceipt]).records
      .find((record) => record.uuid === input.userMessageId && record.role === 'user') : undefined
    if (controlMessage?.text.startsWith('[knowledge-supplement:conversation]')
      || controlMessage?.text.startsWith('[knowledge-supplement:entry]')) {
      const previous = getLatestPersistedUserEvidence(input.sessionId, input.userMessageId)
      if (previous) maintenanceUserMessageId = previous.uuid
    }
    /** 同一断言在调用入口与事务真正提交时执行，阻止等待期间撤权的旧写入。 */
    const assertMutable = (): void => {
      assertCurrent()
      const task = service.store.readManifest(resolveProject(workspaceId))?.workflow?.execution
      if (!input.canMutate() || (!input.execution && task && ['queued', 'running'].includes(task.status))) throw new Error('当前模式没有项目知识写入权限')
    }
    /** 来源扫描逐步与提交前复核本轮身份，取消只影响该轮新建扫描。 */
    const scanSources = async (signal?: AbortSignal) => {
      /** 工具取消与整轮撤权都不能继续发现或发布来源。 */
      const assertScanCurrent = (): void => { signal?.throwIfAborted(); assertMutable() }
      assertScanCurrent()
      await awaitKnowledgeSourceOperation(service.startScan(workspaceId, {
        assertCurrent: assertScanCurrent,
        isCancelled: () => {
          try { signal?.throwIfAborted(); input.assertRunActive(); return false }
          catch { return true }
        },
      }), signal)
      assertScanCurrent()
      await awaitKnowledgeSourceOperation(service.waitForScan(workspaceId), signal)
      assertScanCurrent()
      const snapshot = await service.getSnapshot(workspaceId)
      assertScanCurrent()
      return { initialized: snapshot.initialized, scan: { ...snapshot.scan, message: snapshot.scan.message?.slice(0, 320) } }
    }
    return createProjectKnowledgeAgentMaintenance({
      workspaceId, sessionId: input.sessionId, userMessageId: maintenanceUserMessageId,
      store: service.store, resolveProject, readSource: service.read,
      assertCurrent,
      canMutate: () => {
        if (!input.canMutate()) return false
        /** 活跃任务期间只允许持有其能力的执行者写入，普通聊天仍可读取。 */
        const task = service.store.readManifest(resolveProject(workspaceId))?.workflow?.execution
        return Boolean(input.execution) || !task || !['queued', 'running'].includes(task.status)
      },
      readUserEvidence: () => {
        assertCurrent()
        const receipt = getPersistedAgentMessageReceipt(input.sessionId, maintenanceUserMessageId)
        const evidence = receipt ? readPersistedAgentEvidence(input.sessionId, [receipt]).records
          .find((record) => record.uuid === maintenanceUserMessageId && record.role === 'user') : undefined
        return evidence && !isKnowledgeControlPrompt(evidence.text) ? evidence : undefined
      },
      resolveTaskUserEvidence: (id) => {
        assertCurrent()
        return input.execution ? resolveTaskEvidence(input.sessionId, id) : undefined
      },
      runWorkspaceWrite: async (effect) => {
        assertCurrent()
        const release = acquireWorkspaceWriteLease(workspaceId)
        try { return await effect() }
        finally { release() }
      },
      workflow: {
        scanSources: (_workspaceId, signal) => scanSources(signal),
        importSources: async (_workspaceId, mode, signal) => {
          /** 所有异步边界使用相同的运行与动态权限检查。 */
          const assertImportCurrent = (): void => { signal?.throwIfAborted(); assertMutable() }
          assertImportCurrent()
          if (mode !== 'files' && mode !== 'folder') throw new Error('知识库导入模式无效')
          if (!importSelector) throw new Error('原生知识库导入选择器尚未就绪')
          const paths = await awaitKnowledgeSourceOperation(importSelector(mode), signal)
          assertImportCurrent()
          if (paths.length === 0) return { cancelled: true, imported: 0, unchanged: 0, skippedCount: 0, skipped: [], truncated: false }
          const imported = await service.importSources(workspaceId, paths, assertImportCurrent)
          assertImportCurrent()
          /** 等待可能早于导入开始的扫描结束，再发起新的发现，避免旧扫描漏掉刚导入文件。 */
          if (imported.files.length) {
            await awaitKnowledgeSourceOperation(service.waitForScan(workspaceId), signal)
            assertImportCurrent()
          }
          const scanned = imported.files.length ? await scanSources(signal) : undefined
          assertImportCurrent()
          return { cancelled: false, imported: imported.imported, unchanged: imported.unchanged,
            rootRelativePath: imported.rootRelativePath, skippedCount: imported.skipped.length,
            skipped: imported.skipped.slice(0, 12).map((item) => ({ path: basename(item.path).slice(0, 240), reason: item.reason.slice(0, 160) })),
            truncated: imported.skipped.length > 12, scan: scanned?.scan }
        },
        getSnapshot: service.getSnapshot,
        proposePlan: async (proposal) => {
          await service.proposePlan(proposal, assertMutable)
          const receipt = getPersistedAgentMessageReceipt(input.sessionId, maintenanceUserMessageId)
          const evidence = receipt ? readPersistedAgentEvidence(input.sessionId, [receipt]).records
            .find((record) => record.uuid === maintenanceUserMessageId && record.role === 'user') : undefined
          if (evidence && !isKnowledgeControlPrompt(evidence.text)) {
            assertCurrent()
            await service.store.transact(resolveProject(workspaceId), workspaceId, ({ manifest }) => {
              assertMutable()
              const workflow = manifest.workflow ?? { paused: false }
              const identity = { id: evidence.uuid, sessionId: input.sessionId, messageId: evidence.uuid, sha256: evidence.sha256 }
              const previous = (workflow.userEvidence ?? []).filter((entry) => entry.id !== identity.id)
              return { workflow: { ...workflow, userEvidence: [...previous, identity].slice(-8) } }
            })
          }
          return service.getSnapshot(workspaceId)
        },
        saveOutline: (outline) => service.saveOutline(outline, assertMutable),
        writeDocument: async (document) => {
          if (input.execution) {
            const task = service.store.readManifest(resolveProject(workspaceId))?.workflow?.execution
            if (task?.itemIds.length && !task.itemIds.includes(document.itemId)) throw new Error('文档不属于本次重试范围')
          }
          /** 忽略运行短引用，以持久正文/证据版本识别同一失败输入。 */
          const signature = createHash('sha256').update(JSON.stringify({ itemId: document.itemId,
            expectedRevision: document.expectedRevision, content: document.content, evidence: document.evidence,
            userEvidence: document.userEvidence, admission: document.admission })).digest('hex')
          input.execution?.assertDocumentAttempt(signature)
          try { return await service.writeDocument(document, assertMutable) }
          catch (error) { await input.execution?.onDocumentRejected(signature); throw error }
        },
        copyAsset: service.copyAsset,
        refreshSources: (projectId, sources) => service.refreshSources(projectId, sources, assertMutable),
      },
    })
  }
  /** 所有用户写操作持有迁移租约直到完成，避免检查与写之间迁移。 */
  const mutate = async (workspaceId: string, operation: () => Promise<unknown>): Promise<KnowledgeSnapshot> => {
    const release = acquireWorkspaceWriteLease(workspaceId)
    try { await operation(); return await runtime.getSnapshot(workspaceId) }
    finally { release() }
  }
  /** 对导入与索引恢复等返回专用结果的写操作复用同一工作区租约。 */
  const mutateResult = async <T>(workspaceId: string, operation: () => Promise<T>): Promise<T> => {
    const release = acquireWorkspaceWriteLease(workspaceId)
    try { return await operation() }
    finally { release() }
  }
  const runtime: ProjectKnowledgeRuntime = {
    ...service,
    getSnapshot: async (workspaceId) => {
      const snapshot = await service.getSnapshot(workspaceId)
      /** 旧设置保留在磁盘作历史兼容，不能在新版显示为仍运行的后台服务。 */
      return { ...snapshot, pendingTurns: 0, maintenanceStatus: undefined,
        maintenance: { ...snapshot.maintenance, enabled: false, channelId: undefined, modelId: undefined } }
    },
    createAgentMaintenance,
    startExecution: async (input) => { await execution.start(input); return runtime.getSnapshot(input.workspaceId) },
    claimExecution: async (sessionId, message, runGeneration, abort) => {
      const session = getAgentSessionMeta(sessionId)
      return session?.workspaceId ? execution.claim(session.workspaceId, sessionId, message, runGeneration, abort) : undefined
    },
    recoverExecution: execution.recover,
    discardExecutionDispatch: execution.discard,
    getTaskUserEvidence: (sessionId) => {
      const session = getAgentSessionMeta(sessionId)
      const task = session?.workspaceId ? service.store.readManifest(resolveProject(session.workspaceId))?.workflow?.execution : undefined
      if (!task || task.sessionId !== sessionId) return []
      return task.userEvidence.flatMap((identity) => {
        const evidence = resolveTaskEvidence(sessionId, identity.id)
        return evidence && evidence.message.text.length <= 4000 ? [{ id: identity.id, text: evidence.message.text }] : []
      })
    },
    retireLegacyMaintenance: async (workspaceId) => {
      const project = resolveProject(workspaceId)
      const previous = service.store.readManifest(project)?.maintenance
      if (!previous || (!previous.settings.enabled && !previous.jobs.some((job) => job.status === 'running' || job.status === 'pending'))) return
      await mutate(workspaceId, () => service.store.transact(project, workspaceId, ({ manifest }) => {
        const state = manifest.maintenance ? structuredClone(manifest.maintenance) : undefined
        if (!state) return {}
        state.settings = { ...state.settings, enabled: false, generation: state.settings.generation + 1 }
        for (const job of state.jobs) if (job.status === 'pending' || job.status === 'running') {
          job.status = 'excluded'
          job.message = '知识提炼已迁移至当前 Agent 的 knowledge-maintenance Skill'
        }
        return { maintenance: state }
      }))
    },
    updateMaintenance: async () => { throw new Error('知识提炼由当前 Agent 调用 Skill 执行，无需独立模型设置') },
    retryMaintenance: async () => { throw new Error('请通过更新知识库在 Agent 中重新执行知识维护 Skill') },
    reviewEntry: (input) => mutate(input.workspaceId, () => service.reviewEntry(input)),
    confirmPlan: (input) => mutate(input.workspaceId, () => service.confirmPlan(input)),
    pauseWorkflow: (input) => mutate(input.workspaceId, async () => {
      if (input.paused) await execution.pause(input.workspaceId)
      else await service.pauseWorkflow(input)
    }),
    organize: (workspaceId) => mutate(workspaceId, () => service.organize(workspaceId)),
    undo: (workspaceId, operationId) => mutate(workspaceId, () => service.undo(workspaceId, operationId)),
    importSources: (workspaceId, paths) => mutateResult(workspaceId, () => service.importSources(workspaceId, paths, () => {
      /** 导入目录扫描期间持续复核项目绑定和迁移写守卫。 */
      getProjectKnowledgeBinding(workspaceId)
      const reason = getWorkspaceOperationBlockReason(workspaceId)
      if (reason) throw new Error(reason)
    })),
    previewIndex: (workspaceId) => service.previewIndex(workspaceId),
    rebuildIndex: (input) => mutateResult(input.workspaceId, () => service.rebuildIndex(input)),
    excludeSession: async () => { throw new Error('当前知识提炼仅使用当前用户回合，不再扫描历史会话队列') },
    previewMemory: (workspaceId) => previewKnowledgeMemory(workspaceId, service),
  }
  services.set(configRoot, runtime)
  return runtime
}

/** 启动时仅退役已有旧队列，不重放历史会话或发起模型调用。 */
export async function recoverProjectKnowledge(workspaceId: string): Promise<void> {
  const service = getProjectKnowledgeService()
  if (!(await service.getSnapshot(workspaceId)).initialized) return
  await service.retireLegacyMaintenance(workspaceId)
  await service.recoverExecution(workspaceId)
}
