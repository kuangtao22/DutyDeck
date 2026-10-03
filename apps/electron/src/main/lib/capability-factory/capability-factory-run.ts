/**
 * 「运行」这一段的适配器：场景定义 → 能力包 → 参考 runner → 运行记录。
 *
 * 三个刻意的判断：
 * ① **用 `buildCapabilityPackage` 构建**，而不是把场景定义直接塞给 runner ——
 *    工厂里跑的和交给消费方的必须是同一个形状，否则"工厂里通过 ≠ 产品里通过"；
 *    定义不合法时在这里就会失败（并且失败会记进运行历史，而不是只弹个错）。
 * ② **桩只从虚拟接入表里取**：某个能力没绑桩时**不注入绑定**，让它按 runner 的规则明确失败；
 *    不自动造占位值 —— 那会让工厂里全绿而真实接入全部返工。
 * ③ 运行记录里带上**模型绑定**与**完整轨迹**，因为"这一次跑出了什么"才是观察的对象。
 */
import {
  buildCapabilityPackage,
  type CapabilityPackage,
  type CapabilityRun,
  type CapabilityRunModelBinding,
  type CapabilityScene,
  type CapabilitySceneDefinition,
  type CapabilityRunReview,
  type SceneAcceptance,
  getStepAcceptance,
  getReviewSteps,
  isPromptOnlyOptimization,
} from '@proma/shared'
import type { CapabilityBinding, CapabilityStepProgress, RunResult } from '@proma/capability-runner'
import { createCapabilityRunner } from '@proma/capability-runner'
import { randomUUID } from 'node:crypto'
import {
  CapabilityFactoryError, stableCapabilityValueKey, type CapabilityFactoryService,
} from './capability-factory-service'
import type { CapabilityFactoryModelCall } from './capability-factory-model-call'
import type { CapabilityFactoryModelResolution } from './capability-factory-model-call'
import { reviewCapabilityRun } from './capability-factory-review'
import { validateCapabilityEvidence } from './capability-factory-evidence'

/** 运行适配器依赖：全部注入，离线可测。 */
export interface CapabilityFactoryRunDeps {
  service: CapabilityFactoryService
  /** 模型端口；已在外部完成"声明模型 → 实际渠道"的解析。 */
  callModel: CapabilityFactoryModelCall
  /**
   * 解析模型绑定。传函数而不是结果：解析要读当前渠道与会话，属于宿主事实，
   * 每次运行都该重新取一次（用户可能刚在设置里加了渠道）。
   */
  resolveModels: (definition: CapabilitySceneDefinition) => CapabilityFactoryModelResolution
  now?: () => number
  createId?: () => string
  /** 整次运行的超时；缺省 5 分钟，避免某一步卡死把界面吊住。 */
  timeoutMs?: number
  /** 内容评审独立超时，不占用已经结束的执行阶段超时预算。 */
  reviewTimeoutMs?: number
  /** 执行过程的内存快照及已落盘的评测中记录；只发给对应请求的窗口。 */
  onProgress?: (run: CapabilityRun) => void
}

/** 整链运行的内部选项；批量评测关闭任务保存，避免数据集污染用户提交历史。 */
export interface CapabilityFactoryRunOptions {
  saveTask?: boolean
  /** 运行当前生效定义或待采纳草案。 */
  target?: 'current' | 'draft'
  /** 对比基线版本锁；版本变化时停止，不混合运行。 */
  expectedVersion?: number
  /** 候选草案锁；草案被覆盖或采纳后旧请求失效。 */
  expectedDraftCreatedAt?: number
  /** 候选草案内容锁；补足同一毫秒内被覆盖的小概率窗口。 */
  expectedDraftDefinition?: CapabilitySceneDefinition
  comparisonId?: string
  comparisonRole?: 'baseline' | 'candidate'
}

/** runner 的结果映射成运行状态：完整性轴，与约束轴（valid）分开。 */
function mapStatus(result: RunResult): CapabilityRun['status'] {
  if (result.status === 'succeeded') return 'succeeded'
  if (result.status === 'partial') return 'partial'
  return 'failed'
}

/**
 * 创建运行适配器。
 *
 * @param deps 服务、模型端口与模型解析
 * @returns `run(sceneId, input)`：跑完并落盘，返回带轨迹的运行记录
 */
export function createCapabilityFactoryRunner(deps: CapabilityFactoryRunDeps) {
  const now = deps.now ?? (() => Date.now())
  const createId = deps.createId ?? (() => randomUUID())
  const timeoutMs = deps.timeoutMs ?? 5 * 60 * 1000

  /** 执行结果先落盘，再自动评审；评审异常不丢输出，不改场景或版本。 */
  const finish = async (run: CapabilityRun, definition: CapabilitySceneDefinition): Promise<CapabilityRun> => {
    /** 同一步在并行组内可执行多次；按定义 ID 汇集全部轨迹，不能让最后一项覆盖前面的证据。 */
    const reviewSteps = getReviewSteps(definition.steps).filter((step) => run.steps.some((trace) => trace.stepId === step.id))
    const acceptances = new Map(reviewSteps.map((step) => [step.id, getStepAcceptance(definition, step.id)]))
    const configured = [...acceptances].filter((entry): entry is [string, SceneAcceptance] => entry[1] !== null)
    const aggregateAcceptance: SceneAcceptance = configured.length === 1
      ? structuredClone(configured[0]![1])
      : { criteria: configured.flatMap(([stepId, acceptance]) => acceptance.criteria.map((criterion) => `[${stepId}] ${criterion}`)), judgePrompt: '', metrics: configured.flatMap(([stepId, acceptance]) => acceptance.metrics.map((metric) => ({ ...metric, name: `[${stepId}] ${metric.name}` }))) }
    const snapshot = structuredClone(aggregateAcceptance)
    const base: CapabilityRunReview = {
      status: 'skipped', passed: null, summary: '', acceptance: snapshot,
      criteria: [], metrics: [], suggestions: [], startedAt: now(), finishedAt: now(),
    }
    /** 优先复用当前步骤的执行模型，整链采用本轮已解析的第一个模型。 */
    const currentModel = run.kind === 'step' ? run.steps[0]?.model : undefined
    const binding = run.modelBindings?.find((item) => item.modelId === currentModel) ?? run.modelBindings?.[0]
    const reason = (run.placeholderCapabilities?.length ?? 0) > 0
        ? '本轮含空占位数据，不能据此评定内容质量。'
        : configured.length === 0
          ? '没有流程步骤评审标准，请为每个模型步骤补充后再运行。'
          : !binding ? '未找到可用评审模型，本轮输出已保留。' : null
    if (reason || !binding) return deps.service.recordRun({ ...run, review: { ...base, summary: reason ?? '未找到评审模型' } })

    const pending = deps.service.recordRun({ ...run, review: {
      ...base, status: 'running', summary: '运行已完成，正在评测内容。', modelBinding: binding, finishedAt: null,
    } })
    // 窗口已关闭等展示异常不能中断已经写盘的评审任务。
    try { deps.onProgress?.(pending) } catch { /* 宿主负责发送边界，结果仍落盘供之后读取。 */ }
    const stepReviews: NonNullable<CapabilityRun['stepReviews']> = {}
    /** 步骤评审中间态只用于展示，汇总终态仍一次性原子更新历史。 */
    const publishReviewProgress = (summary: string): void => {
      try {
        deps.onProgress?.({ ...pending, stepReviews: { ...stepReviews }, review: { ...pending.review!, summary } })
      } catch { /* 窗口断开不影响评审落盘。 */ }
    }
    for (const step of reviewSteps) {
      const acceptance = acceptances.get(step.id)
      if (!acceptance) continue
      /** 按声明槽位选模型，避免不同渠道同名模型时误选；评审只带当前步骤材料。 */
      const stepBinding = run.modelBindings?.find((item) => item.slotId === step.modelSlot) ?? binding
      const traces = run.steps.filter((trace) => trace.stepId === step.id)
      if (traces.some((trace) => trace.status !== 'succeeded')) {
        stepReviews[step.id] = { ...base, acceptance: structuredClone(acceptance),
          summary: '该步骤执行或格式校验未通过，未进行内容评审。' }
        publishReviewProgress(`「${step.title}」未满足评审条件，已跳过。`)
        continue
      }
      stepReviews[step.id] = { ...base, acceptance: structuredClone(acceptance), status: 'running',
        summary: `正在评审「${step.title}」`, modelBinding: stepBinding, startedAt: now(), finishedAt: null }
      publishReviewProgress(`正在评审「${step.title}」`)
      const stepRun: CapabilityRun = { ...pending, kind: 'step', stepId: step.id, steps: traces,
        outputs: { output: traces.map((trace) => trace.parsedOutput ?? trace.rawOutput) }, modelBindings: [stepBinding] }
      stepReviews[step.id] = await reviewCapabilityRun({
        run: stepRun, acceptance: structuredClone(acceptance), binding: stepBinding, callModel: deps.callModel, now,
        timeoutMs: deps.reviewTimeoutMs,
      })
      publishReviewProgress(`已处理 ${Object.keys(stepReviews).length} / ${configured.length} 个步骤的评审。`)
    }
    const results = Object.values(stepReviews)
    const reviewedStepIds = Object.keys(stepReviews)
    /** 多步骤汇总时给判据加步骤前缀，批量评测与优化对比才能区分同名标准。 */
    const aggregateCriteria = results.length === 1
      ? results.flatMap((item) => item.criteria)
      : results.flatMap((item, index) => {
        const stepId = reviewedStepIds[index] ?? `step-${index + 1}`
        return item.criteria.map((criterion) => ({ ...criterion, criterion: `[${stepId}] ${criterion.criterion}` }))
      })
    const aggregateMetrics = results.length === 1
      ? results.flatMap((item) => item.metrics)
      : results.flatMap((item, index) => {
        const stepId = reviewedStepIds[index] ?? `step-${index + 1}`
        return item.metrics.map((metric) => ({ ...metric, name: `[${stepId}] ${metric.name}` }))
      })
    const aggregateReview: CapabilityRunReview = {
      ...base,
      status: results.some((item) => item.status === 'failed') ? 'failed'
        : results.every((item) => item.status === 'skipped') ? 'skipped' : 'succeeded',
      passed: results.some((item) => item.passed === false) ? false
        : run.status === 'succeeded' && run.valid && results.length > 0 && results.every((item) => item.passed === true) ? true : null,
      summary: results.length === 1 ? results[0]!.summary : `已评审 ${results.length} 个流程步骤：${results.filter((item) => item.passed === true).length} 个通过。`,
      acceptance: snapshot,
      criteria: aggregateCriteria, metrics: aggregateMetrics, suggestions: results.flatMap((item) => item.suggestions),
      modelBinding: binding, finishedAt: now(),
      ...(results.some((item) => item.error) ? { error: results.flatMap((item) => item.error ? [item.error] : []).join('；') } : {}),
    }
    return deps.service.finishRunReview(run.sceneId, run.id, aggregateReview, stepReviews)
  }

  /**
   * 整链运行与单步试跑共用的准备阶段：模型解析 → 构建能力包 → 绑桩 → 建 runner。
   *
   * @param sceneId 场景 id
   * @param definitionOverride 临时定义（人在弹窗里改到一半的提示词可以先试再存）；缺省用生效定义
   * @returns 失败时给一句可读原因，成功时给出可以直接跑的东西
   */
  const prepare = (
    scene: CapabilityScene,
    definitionOverride?: CapabilitySceneDefinition,
    /** 单步试跑只要求目标步骤标准完整，不被其他未配置步骤阻断。 */
    targetStepId?: string,
    /** 运行中的步骤观察回调，不参与执行结果。 */
    onStepProgress?: (event: CapabilityStepProgress) => void,
  ): { failure: string } | {
    scene: CapabilityScene
    pkg: CapabilityPackage
    runner: ReturnType<typeof createCapabilityRunner>
    bindings: CapabilityRunModelBinding[]
    placeholders: string[]
    acceptances: Record<string, SceneAcceptance>
  } => {
    const definition = structuredClone(definitionOverride ?? scene.definition)

    const resolution = deps.resolveModels(definition)
    if (resolution.error) return { failure: resolution.error }

    const acceptances: Record<string, SceneAcceptance> = {}
    for (const step of getReviewSteps(definition.steps)) {
      const acceptance = getStepAcceptance(definition, step.id)
      if (acceptance && (step.type === 'llm' || step.type === 'extract')) acceptances[step.id] = structuredClone(acceptance)
    }
    const reviewable = getReviewSteps(definition.steps).filter((step) => targetStepId === undefined || step.id === targetStepId)
    if (reviewable.some((step) => !acceptances[step.id]?.criteria.length && !acceptances[step.id]?.judgePrompt.trim())) {
      return { failure: '每个模型流程步骤都必须设置独立的内容评审标准。' }
    }

    let pkg: CapabilityPackage
    try {
      /** 包版本只用于本地执行（不会落进导出记录）：工厂内跑的就是消费方会拿到的形状。 */
      pkg = buildCapabilityPackage(definition, { packageVersion: 'run-local', exportedAt: now() })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { failure: `场景定义还不合法，无法运行：${reason}` }
    }

    /** 桩表 → runner 的能力绑定；没有桩的能力**刻意不绑定**。 */
    const stubById = new Map(deps.service.listStubs().map((stub) => [stub.capabilityId, stub]))
    const capabilities: Record<string, CapabilityBinding> = {}
    /** 占位桩要单独记下来：这些值只能证明流程通了，证明不了质量。 */
    const placeholders: string[] = []
    for (const declaration of definition.capabilities) {
      const stub = stubById.get(declaration.id)
      if (!stub) continue
      capabilities[declaration.id] = { call: () => stub.payload }
      if (stub.source === 'placeholder') placeholders.push(declaration.id)
    }

    const signal = AbortSignal.timeout(timeoutMs)
    /**
     * runner 传给模型端口的只有**声明值**（`slot.model`），而声明值可能只是模板默认值。
     * 这里按 `resolveModels` 的结果把它翻成实际渠道 + 模型，端口才找得到东西。
     */
    const bindingByDeclared = new Map(resolution.bindings.map((binding) => [binding.declaredModel, binding]))
    const runner = createCapabilityRunner({
      callModel: (request) => {
        const binding = bindingByDeclared.get(request.model)
        if (!binding) throw new Error(`模型槽位声明的模型「${request.model}」没有被解析到任何渠道`)
        return deps.callModel({
          stepId: request.stepId, model: request.model,
          channelId: binding.channelId, modelId: binding.modelId,
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
          prompt: request.prompt,
          ...(request.formatInstruction === undefined ? {} : { formatInstruction: request.formatInstruction }),
          signal,
        })
      },
      capabilities,
      ...(onStepProgress ? { onStepProgress } : {}),
    })

    return { scene, pkg, runner, bindings: resolution.bindings, placeholders, acceptances }
  }

  return {
    /**
     * 执行一次场景运行。
     *
     * 失败不会抛给调用方，而是**记一条 status=failed 的运行**：
     * "为什么没跑起来"同样属于用户要观察的过程，丢进异常里就看不见了。
     */
    async run(
      sceneId: string,
      input: Record<string, unknown>,
      options: CapabilityFactoryRunOptions = {},
    ): Promise<CapabilityRun> {
      const runId = createId()
      const startedAt = now()
      const scene = deps.service.getScene(sceneId)
      if (!scene) throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
      const target = options.target ?? 'current'
      const draft = target === 'draft' ? scene.draft : null
      const selectedDefinition = target === 'draft' ? draft?.definition : scene.definition
      const definition = selectedDefinition ? structuredClone(selectedDefinition) : undefined
      const taskSaved = options.saveTask !== false && options.comparisonId === undefined && target === 'current'
      /** 所有终态（包括乐观锁失败）都带回同一组身份字段，便于界面还原对比。 */
      const identity = {
        definitionTarget: target,
        ...(definition ? { definitionSnapshot: definition } : {}),
        ...(draft ? { draftCreatedAt: draft.createdAt } : {}),
        ...(options.comparisonId === undefined ? {} : { comparisonId: options.comparisonId }),
        ...(options.comparisonRole === undefined ? {} : { comparisonRole: options.comparisonRole }),
      } as const
      /** 提交即保存；持久化失败时必须在解析模型或调用模型前停止，不能制造不可复现的运行。 */
      if (taskSaved) deps.service.saveTask(sceneId, input)
      /** 失败也落盘：历史里能看到"这一次为什么没跑起来"。 */
      const record = (partial: Omit<CapabilityRun, 'id' | 'sceneId' | 'sceneVersion' | 'startedAt'>): CapabilityRun =>
        deps.service.recordRun({
          id: runId, sceneId, sceneVersion: scene.currentVersion, kind: 'full',
          taskSaved, startedAt, ...identity, ...partial,
        })

      if (options.expectedVersion !== undefined && options.expectedVersion !== scene.currentVersion) {
        return record({
          status: 'failed', valid: false, input, outputs: null, steps: [],
          error: `对比基线版本已变化：预期 v${options.expectedVersion}，当前为 v${scene.currentVersion}，请重新开始对比。`,
          finishedAt: now(),
        })
      }
      if (options.comparisonId !== undefined) {
        const expectedTarget = options.comparisonRole === 'candidate' ? 'draft' : 'current'
        if (!options.comparisonRole || target !== expectedTarget) {
          return record({
            status: 'failed', valid: false, input, outputs: null, steps: [],
            error: '对比身份与定义来源不一致，请重新开始对比。', finishedAt: now(),
          })
        }
      }
      if (target === 'draft') {
        if (!draft) {
          return record({
            status: 'failed', valid: false, input, outputs: null, steps: [],
            error: '待运行的候选草案已不存在，可能已被采纳或放弃，请重新开始对比。', finishedAt: now(),
          })
        }
        if (options.expectedVersion === undefined) {
          return record({
            status: 'failed', valid: false, input, outputs: null, steps: [],
            error: '候选运行缺少基线版本锁，请重新开始对比。', finishedAt: now(),
          })
        }
        if (options.expectedDraftCreatedAt === undefined
          || options.expectedDraftCreatedAt !== draft.createdAt) {
          return record({
            status: 'failed', valid: false, input, outputs: null, steps: [],
            error: '候选草案已变化，为避免运行到未确认的内容，请重新开始对比。', finishedAt: now(),
          })
        }
        if (options.expectedDraftDefinition === undefined
          || stableCapabilityValueKey(options.expectedDraftDefinition) !== stableCapabilityValueKey(draft.definition)) {
          return record({
            status: 'failed', valid: false, input, outputs: null, steps: [],
            error: '候选草案已变化，为避免运行到未确认的内容，请重新开始对比。', finishedAt: now(),
          })
        }
        if (options.comparisonId !== undefined
          && stableCapabilityValueKey(draft.definition.stepAcceptances ?? draft.definition.acceptance)
            !== stableCapabilityValueKey(scene.definition.stepAcceptances ?? scene.definition.acceptance)) {
          return record({
            status: 'failed', valid: false, input, outputs: null, steps: [],
            error: '候选草案与当前版本的评审标准不一致，不能直接比较。请先单独审核标准变更。',
            finishedAt: now(),
          })
        }
        if (options.comparisonId !== undefined
          && stableCapabilityValueKey(draft.definition.modelSlots)
            !== stableCapabilityValueKey(scene.definition.modelSlots)) {
          return record({
            status: 'failed', valid: false, input, outputs: null, steps: [],
            error: '候选草案与当前版本的模型绑定不一致，不能当作提示词优化直接比较。',
            finishedAt: now(),
          })
        }
        if (options.comparisonId !== undefined && !isPromptOnlyOptimization(scene.definition, draft.definition)) {
          return record({
            status: 'failed', valid: false, input, outputs: null, steps: [],
            error: '候选草案含提示词以外的执行结构或契约改动，不能当作提示词优化直接比较。',
            finishedAt: now(),
          })
        }
      }

      /** 步骤回调只发观察快照，不提前写入历史；最终记录仍由 finish 统一落盘。 */
      let progressBindings: CapabilityRunModelBinding[] = []
      let progressPlaceholders: string[] = []
      /** 同一个步骤可同时处理多个并行项；最后一项完成才停止动画。 */
      const activeStepCounts = new Map<string, number>()
      const emitStepProgress = (event: CapabilityStepProgress): void => {
        if (!deps.onProgress) return
        /** 开始递增、完成递减，父并行组保持活跃到整个组扇入完成。 */
        const count = (activeStepCounts.get(event.step.id) ?? 0) + (event.phase === 'started' ? 1 : -1)
        if (count > 0) activeStepCounts.set(event.step.id, count)
        else activeStepCounts.delete(event.step.id)
        const progress: CapabilityRun = {
          id: runId, sceneId, sceneVersion: scene.currentVersion, kind: 'full', taskSaved,
          startedAt, ...identity,
          status: 'running', valid: false, input, outputs: null, steps: [...event.traces],
          modelBindings: progressBindings,
          ...(progressPlaceholders.length === 0 ? {} : { placeholderCapabilities: progressPlaceholders }),
          activeStepIds: [...activeStepCounts.keys()],
          finishedAt: null,
        }
        try { deps.onProgress(progress) } catch { /* 观察端断开不影响运行。 */ }
      }
      const prepared = prepare(scene, definition, undefined, deps.onProgress ? emitStepProgress : undefined)
      if ('failure' in prepared) {
        return record({
          status: 'failed', valid: false, input, outputs: null, steps: [],
          error: prepared.failure, finishedAt: now(),
        })
      }
      const { pkg, runner, bindings, placeholders } = prepared
      progressBindings = bindings
      progressPlaceholders = placeholders

      let result: RunResult
      try {
        result = await runner.run(pkg, input)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return record({
          status: 'failed', valid: false, input, outputs: null, steps: [],
          error: `运行中止：${reason}`, finishedAt: now(),
        })
      }

      const inputErrors = result.inputErrors ?? []
      const failureText = inputErrors.length > 0
        ? `输入不满足输入契约：${inputErrors.join('；')}`
        : result.error
      /** map 内子步骤也在扁平轨迹里；仅用户输入与成功工具返回可作为原文来源。 */
      const evidenceSource = { input, tools: result.steps
        .filter((step) => step.type === 'tool' && step.status === 'succeeded')
        .map((step) => step.parsedOutput) }
      /** 检查所有模型步骤，避免最终输出映射隐藏中间引用错误；不把模型输出并入来源。 */
      const evidenceIssues = validateCapabilityEvidence(evidenceSource, {
        outputs: result.outputs,
        modelSteps: result.steps.flatMap((step, index) => step.type === 'llm' || step.type === 'extract'
          ? [{ [step.stepId]: { traceIndex: index, output: step.parsedOutput ?? step.rawOutput } }] : []),
      })
      return finish({
        id: runId, sceneId, sceneVersion: scene.currentVersion, kind: 'full',
        taskSaved, startedAt, ...identity,
        status: mapStatus(result),
        valid: result.valid,
        input,
        outputs: result.outputs,
        steps: result.steps,
        modelBindings: bindings,
        ...(placeholders.length === 0 ? {} : { placeholderCapabilities: placeholders }),
        ...(evidenceIssues.length === 0 ? {} : { evidenceIssues }),
        ...(failureText === undefined ? {} : { error: failureText }),
        finishedAt: result.finishedAt,
      }, definition!)
    },

    /**
     * **单步试跑**：训练一个提示词不需要整条链可跑。
     *
     * 与整链运行共享准备阶段（同一套严格解析与模型解析），但只执行目标步骤，
     * 输入完全来自调用方 —— 上游是"读库/调接口"时也不用先把它搭起来。
     * 记录标 `kind: 'step'` 并附带**提示词模板原文**：对比两次尝试时 diff 的就是它。
     *
     * @param sceneId 场景 id
     * @param stepId 目标步骤（顶层 llm / extract）
     * @param input 该步骤输入槽的值
     * @param definitionOverride 可选：用这份临时定义跑（弹窗里改到一半的提示词先试再存）
     */
    async runStep(
      sceneId: string,
      stepId: string,
      input: Record<string, unknown>,
      definitionOverride?: CapabilitySceneDefinition,
    ): Promise<CapabilityRun> {
      const runId = createId()
      const startedAt = now()
      const scene = deps.service.getScene(sceneId)
      if (!scene) throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
      const definition = structuredClone(definitionOverride ?? scene.definition)
      const record = (partial: Omit<CapabilityRun, 'id' | 'sceneId' | 'sceneVersion' | 'startedAt'>): CapabilityRun =>
        deps.service.recordRun({
          id: runId, sceneId, sceneVersion: scene.currentVersion, kind: 'step', stepId, startedAt, ...partial,
        })

      /** 单步训练也回传真实步骤进度，和整链运行保持同一观察协议。 */
      let progressBindings: CapabilityRunModelBinding[] = []
      const emitStepProgress = (event: CapabilityStepProgress): void => {
        if (!deps.onProgress) return
        const active = event.phase === 'started'
        const progress: CapabilityRun = {
          id: runId, sceneId, sceneVersion: scene.currentVersion, kind: 'step', stepId,
          startedAt, definitionSnapshot: definition,
          status: 'running', valid: false, input, outputs: null, steps: [...event.traces],
          modelBindings: progressBindings,
          activeStepIds: active ? [event.step.id] : [],
          finishedAt: null,
        }
        try { deps.onProgress(progress) } catch { /* 观察端断开不影响运行。 */ }
      }
      const prepared = prepare(scene, definition, stepId, deps.onProgress ? emitStepProgress : undefined)
      if ('failure' in prepared) {
        return record({
          status: 'failed', valid: false, input, outputs: null, steps: [],
          error: prepared.failure, finishedAt: now(),
        })
      }
      const { pkg, runner, bindings } = prepared
      progressBindings = bindings
      const target = pkg.steps.find((step) => step.id === stepId)
      const stepPrompt = target && 'prompt' in target ? target.prompt : undefined

      let outcome: Awaited<ReturnType<typeof runner.runSingleStep>>
      try {
        outcome = await runner.runSingleStep(pkg, stepId, input)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return record({
          status: 'failed', valid: false, input, outputs: null, steps: [],
          ...(stepPrompt === undefined ? {} : { stepPrompt }),
          error: `运行中止：${reason}`, finishedAt: now(),
        })
      }

      if ('error' in outcome) {
        return record({
          status: 'failed', valid: false, input, outputs: null, steps: [],
          ...(stepPrompt === undefined ? {} : { stepPrompt }),
          error: outcome.error, finishedAt: now(),
        })
      }

      /** 单步输出同样可能带段落证据，按调用方传入的材料做局部回溯。 */
      const evidenceIssues = validateCapabilityEvidence(input, outcome.step.parsedOutput)
      return finish({
        id: runId, sceneId, sceneVersion: scene.currentVersion, kind: 'step', stepId, startedAt,
        status: outcome.valid ? 'succeeded' : 'failed',
        valid: outcome.valid,
        input,
        outputs: null,
        steps: [outcome.step],
        ...(stepPrompt === undefined ? {} : { stepPrompt }),
        modelBindings: bindings,
        ...(evidenceIssues.length === 0 ? {} : { evidenceIssues }),
        // 单步输入完全来自调用方，没有执行其他步骤的占位桩，不能继承整链占位标签。
        finishedAt: outcome.step.finishedAt,
      }, definition!)
    },
  }
}

export type CapabilityFactoryRunner = ReturnType<typeof createCapabilityFactoryRunner>
