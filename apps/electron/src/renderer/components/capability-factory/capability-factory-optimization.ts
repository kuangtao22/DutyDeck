/** 优化试跑的配对与可比性判断，不把模型评审异常当成提示词质量差。 */
import { stableCapabilityValueKey as optimizationKey, isPromptOnlyOptimization } from '@proma/shared'
import type { CapabilityFactoryApi, CapabilityRun, CapabilityRunReview, CapabilitySavedTask, CapabilityScene } from '@proma/shared'
export { stableCapabilityValueKey as optimizationKey, isPromptOnlyOptimization } from '@proma/shared'

/** 一条任务的两版结果；候选尚未执行或失败退出时仍保留基线。 */
export interface OptimizationPair {
  id: string
  baseline: CapabilityRun
  candidate?: CapabilityRun
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
  comparable: boolean; reasons: string[]; fixed: string[]; regressed: string[]; unknown: string[]; candidatePassed: boolean
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
  const unknown: string[] = []
  if (reasons.length === 0) {
    if (baseline.evidenceIssues?.length && !candidate.evidenceIssues?.length) fixed.push('证据引用：已修复全部原文回溯问题')
    if (!baseline.evidenceIssues?.length && candidate.evidenceIssues?.length) regressed.push('证据引用：出现原文回溯问题')
    if (candidate.evidenceIssues?.length) unknown.push('候选证据引用仍无法逐字回溯')
    for (const [stepId, beforeReview] of baselineReviews) {
      const afterReview = candidateReviews.find(([candidateStepId]) => candidateStepId === stepId)?.[1]
      for (const criterion of beforeReview.acceptance.criteria) {
        /** 对照冻结标准逐项检查，缺项或 null 不能靠其它判据的改善掩盖。 */
        const before = beforeReview.criteria.find((item) => item.criterion === criterion)
        const after = afterReview?.criteria.find((item) => item.criterion === criterion)
        const label = stepId === '__scene__' ? criterion : `${stepId}：${criterion}`
        if (typeof before?.passed !== 'boolean' || typeof after?.passed !== 'boolean') {
          unknown.push(`判据：${label}`)
          continue
        }
        if (before.passed === false && after?.passed === true) fixed.push(label)
        if (before.passed === true && after?.passed === false) regressed.push(label)
      }
      for (const beforeMetric of beforeReview.acceptance.metrics) {
        const beforeValue = beforeReview.metrics.find((item) => item.name === beforeMetric.name)?.value
        const afterValue = afterReview?.metrics.find((item) => item.name === beforeMetric.name)?.value
        const label = stepId === '__scene__' ? beforeMetric.name : `${stepId}：${beforeMetric.name}`
        if (typeof beforeValue !== 'number' || typeof afterValue !== 'number'
          || !Number.isFinite(beforeValue) || !Number.isFinite(afterValue)) {
          unknown.push(`指标：${label}`)
          continue
        }
        if (beforeValue === afterValue) continue
        const improved = beforeMetric.direction === 'positive' ? afterValue > beforeValue : afterValue < beforeValue
        if (improved) fixed.push(`指标：${label}`)
        else regressed.push(`指标：${label}`)
      }
    }
  }
  return { comparable: reasons.length === 0, reasons, fixed, regressed, unknown,
    candidatePassed: !candidate.evidenceIssues?.length && candidate.review?.passed === true
      && candidateReviews.every(([, review]) => review.passed === true) }
}

/** 只有候选明确通过、至少修复一项且没有退化，才允许进入采纳入口。 */
export function isAdoptableOptimizationComparison(comparison: ReturnType<typeof compareOptimizationPair>): boolean {
  return isAdoptableOptimizationBatch([comparison])
}

/**
 * 只有整批选中任务都完成同口径验证、候选全部通过且没有未知/退化时，才允许采纳。
 * 至少一条任务出现明确改善即可，其他任务可以保持不变，但不能用一条好结果掩盖同批失败。
 */
export function isAdoptableOptimizationBatch(
  comparisons: readonly ReturnType<typeof compareOptimizationPair>[],
): boolean {
  return comparisons.length > 0
    && comparisons.every((comparison) => comparison.comparable && comparison.candidatePassed
      && comparison.regressed.length === 0 && comparison.unknown.length === 0)
    && comparisons.some((comparison) => comparison.fixed.length > 0)
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
  if (!isPromptOnlyOptimization(scene.definition, scene.draft.definition)) {
    throw new Error('草案包含流程或契约改动。提示词优化对比只允许修改模型步骤提示词。')
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
    if (baseline.status !== 'succeeded' || baseline.sceneVersion !== scene.currentVersion || !baseline.valid) throw new Error(baseline.error ?? '基线执行或格式校验失败，对比已停止。')
    if (baseline.review?.status !== 'succeeded') throw new Error('基线评审未完成，请先处理评审异常，再优化业务提示词。')
    const candidate = await api.invoke('runScene', {
      sessionId, sceneId: scene.id, input: task.input, target: 'draft', expectedVersion: scene.currentVersion,
      expectedDraftCreatedAt: scene.draft.createdAt, comparisonId, comparisonRole: 'candidate',
      expectedDraftDefinition: scene.draft.definition,
    })
    if (!isActive()) return
    onPair({ id: comparisonId, baseline, candidate })
    if (candidate.status !== 'succeeded' || candidate.sceneVersion !== scene.currentVersion || !candidate.valid) throw new Error(candidate.error ?? '候选执行或格式校验失败，对比已停止。')
    if (candidate.review?.status !== 'succeeded') throw new Error('候选评审未完成，结果已保留，请先处理评审异常。')
  }
}
