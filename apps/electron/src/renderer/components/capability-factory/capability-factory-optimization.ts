/** 优化试跑的配对与可比性判断，不把模型评审异常当成提示词质量差。 */
import type { CapabilityFactoryApi, CapabilityRun, CapabilityRunReview, CapabilitySavedTask, CapabilityScene } from '@proma/shared'

/** 一条任务的两版结果；候选尚未执行或失败退出时仍保留基线。 */
export interface OptimizationPair {
  id: string
  baseline: CapabilityRun
  candidate?: CapabilityRun
}

/** JSON 语义比较：忽略对象键顺序，保留数组顺序、空值和正文空白。 */
export function optimizationKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(optimizationKey).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${optimizationKey(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** 场景评审标准的稳定快照：新场景按步骤比较，旧场景按顶层标准兼容。 */
export function sceneStandardsKey(scene: CapabilityScene): string {
  return optimizationKey(scene.definition.stepAcceptances ?? scene.definition.acceptance)
}

/** 运行评审按步骤读取；旧记录没有 stepReviews 时回退到聚合评审。 */
function reviewEntries(run: CapabilityRun): Array<[string, CapabilityRunReview]> {
  const entries = Object.entries(run.stepReviews ?? {})
  if (entries.length > 0) return entries.sort(([left], [right]) => left.localeCompare(right))
  return run.review ? [['__scene__', run.review]] : []
}

/** 固定运行时的每步骤评审规则，避免用聚合文本掩盖某一步口径变化。 */
function runStandardsKey(run: CapabilityRun): string {
  return optimizationKey(Object.fromEntries(reviewEntries(run).map(([stepId, review]) => [stepId, review.acceptance])))
}

/** 是否仍为被测试的那份草案；只用于展示，主进程采纳时还需原子复核。 */
export function canAdoptOptimization(candidate: CapabilityRun, scene: CapabilityScene): boolean {
  return candidate.definitionTarget === 'draft' && candidate.sceneId === scene.id
    && candidate.sceneVersion === scene.currentVersion && Boolean(scene.draft)
    && candidate.draftCreatedAt === scene.draft?.createdAt && Boolean(candidate.definitionSnapshot)
    && optimizationKey(candidate.definitionSnapshot) === optimizationKey(scene.draft?.definition)
}

/** 从已保存的运行恢复成对结果；普通历史不自动猜配。 */
export function groupOptimizationRuns(runs: readonly CapabilityRun[]): OptimizationPair[] {
  /** 按显式对比身份分组，最新记录优先，不让旧进度覆盖终态。 */
  const groups = new Map<string, { baseline?: CapabilityRun; candidate?: CapabilityRun }>()
  for (const run of runs) {
    if (!run.comparisonId || !run.comparisonRole) continue
    const group = groups.get(run.comparisonId) ?? {}
    if (!group[run.comparisonRole]) group[run.comparisonRole] = run
    groups.set(run.comparisonId, group)
  }
  return [...groups.entries()].flatMap(([id, group]) => group.baseline ? [{ id, baseline: group.baseline, candidate: group.candidate }] : [])
    .sort((left, right) => right.baseline.startedAt - left.baseline.startedAt)
}

/** 对比结论只基于双方明确完成的同口径判断，不合成质量分数。 */
export function compareOptimizationPair(baseline: CapabilityRun, candidate: CapabilityRun): {
  comparable: boolean; reasons: string[]; fixed: string[]; regressed: string[]
} {
  /** 每个原因都独立可解释，帮助用户修正比较条件。 */
  const reasons: string[] = []
  if (baseline.sceneId !== candidate.sceneId || baseline.sceneVersion !== candidate.sceneVersion) reasons.push('场景或基线版本不同')
  if (optimizationKey(baseline.input) !== optimizationKey(candidate.input)) reasons.push('任务输入不同')
  const baselineReviews = reviewEntries(baseline)
  const candidateReviews = reviewEntries(candidate)
  if (!baseline.review || !candidate.review || baseline.review.status !== 'succeeded' || candidate.review.status !== 'succeeded'
    || baselineReviews.some(([, review]) => review.status !== 'succeeded')
    || candidateReviews.some(([, review]) => review.status !== 'succeeded')) reasons.push('评审未完成，先处理评审异常')
  if (!baselineReviews.length || !candidateReviews.length || runStandardsKey(baseline) !== runStandardsKey(candidate)) reasons.push('评审标准不同或缺少快照')
  if (!baseline.modelBindings?.length || !candidate.modelBindings?.length
    || optimizationKey(baseline.modelBindings) !== optimizationKey(candidate.modelBindings)
    || optimizationKey(baseline.definitionSnapshot?.modelSlots) !== optimizationKey(candidate.definitionSnapshot?.modelSlots)
    || optimizationKey(baselineReviews.map(([id, review]) => [id, review.modelBinding])) !== optimizationKey(candidateReviews.map(([id, review]) => [id, review.modelBinding]))
    || optimizationKey(baseline.review?.modelBinding) !== optimizationKey(candidate.review?.modelBinding)) reasons.push('实际模型、模型参数不同或未记录')
  if (baseline.placeholderCapabilities?.length || candidate.placeholderCapabilities?.length) reasons.push('使用了占位数据')
  if (baseline.status !== 'succeeded' || candidate.status !== 'succeeded' || !baseline.valid || !candidate.valid) reasons.push('执行或格式约束未通过，只能先比较错误与输出')
  /** 修复/退化只统计明确 true/false；null 不能算改善。 */
  const fixed: string[] = []
  const regressed: string[] = []
  if (reasons.length === 0) {
    for (const [stepId, beforeReview] of baselineReviews) {
      const afterReview = candidateReviews.find(([candidateStepId]) => candidateStepId === stepId)?.[1]
      for (const before of beforeReview.criteria) {
        const after = afterReview?.criteria.find((item) => item.criterion === before.criterion)
        const label = stepId === '__scene__' ? before.criterion : `${stepId}：${before.criterion}`
        if (before.passed === false && after?.passed === true) fixed.push(label)
        if (before.passed === true && after?.passed === false) regressed.push(label)
      }
    }
  }
  return { comparable: reasons.length === 0, reasons, fixed, regressed }
}

/** 顺序执行两版，降低并发调用开销；页面离开后不启动剩余任务。 */
export async function runOptimizationBatch(options: {
  api: CapabilityFactoryApi; sessionId: string; scene: CapabilityScene; tasks: CapabilitySavedTask[]
  onPair: (pair: OptimizationPair) => void; isActive: () => boolean
}): Promise<void> {
  /** 固定点击时的定义、版本和任务，异步期间不随轮询更新。 */
  const { api, sessionId, onPair, isActive } = options
  const scene = structuredClone(options.scene)
  const tasks = structuredClone(options.tasks)
  if (!scene.draft) throw new Error('先在当前会话中让 Agent 提出优化草案。')
  if (sceneStandardsKey(scene) !== optimizationKey(scene.draft.definition.stepAcceptances ?? scene.draft.definition.acceptance)) {
    throw new Error('草案修改了评审标准。请先单独确认标准，再按同一标准重新验证两版；本次不作优化比较。')
  }
  if (optimizationKey(scene.definition.modelSlots) !== optimizationKey(scene.draft.definition.modelSlots)) {
    throw new Error('草案修改了模型配置。提示词优化对比需保持两版模型配置一致。')
  }
  if (!tasks.length || tasks.length > 10 || tasks.some((task) => task.sceneId !== scene.id)) throw new Error('请选择当前场景的 1–10 条任务。')
  for (const task of tasks) {
    if (!isActive()) return
    /** 每对拥有独立身份，终态通过运行记录保留，刷新后仍可配对。 */
    const comparisonId = crypto.randomUUID()
    const baseline = await api.invoke('runScene', {
      sessionId, sceneId: scene.id, input: task.input, target: 'current', expectedVersion: scene.currentVersion,
      comparisonId, comparisonRole: 'baseline',
    })
    if (!isActive()) return
    onPair({ id: comparisonId, baseline })
    if (baseline.status === 'failed' || baseline.sceneVersion !== scene.currentVersion) throw new Error(baseline.error ?? '基线运行失败，对比已停止。')
    if (baseline.review?.status === 'failed' || baseline.review?.status === 'running') throw new Error('基线评审未完成，请先处理评审异常，再优化业务提示词。')
    const candidate = await api.invoke('runScene', {
      sessionId, sceneId: scene.id, input: task.input, target: 'draft', expectedVersion: scene.currentVersion,
      expectedDraftCreatedAt: scene.draft.createdAt, comparisonId, comparisonRole: 'candidate',
      expectedDraftDefinition: scene.draft.definition,
    })
    if (!isActive()) return
    onPair({ id: comparisonId, baseline, candidate })
    if (candidate.status === 'failed' || candidate.sceneVersion !== scene.currentVersion) throw new Error(candidate.error ?? '候选运行失败，对比已停止。')
    if (candidate.review?.status === 'failed' || candidate.review?.status === 'running') throw new Error('候选评审未完成，结果已保留，请先处理评审异常。')
  }
}
