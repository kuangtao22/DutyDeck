import type { CapabilityRun, CapabilityRunReview, CapabilityScene } from '../types/capability-factory'
import { isPromptOnlyOptimization, stableCapabilityValueKey as optimizationKey } from '../types/capability-factory'

export { isPromptOnlyOptimization, optimizationKey }

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

/** 是否仍为被测试的那份草案；主进程采纳时还需复核所有运行证据。 */
export function canAdoptOptimization(candidate: CapabilityRun, scene: CapabilityScene): boolean {
  return candidate.definitionTarget === 'draft' && candidate.sceneId === scene.id
    && candidate.sceneVersion === scene.currentVersion && Boolean(scene.draft)
    && candidate.draftCreatedAt === scene.draft?.createdAt && Boolean(candidate.definitionSnapshot)
    && optimizationKey(candidate.definitionSnapshot) === optimizationKey(scene.draft?.definition)
}

/** 从已保存的运行恢复成对结果；普通历史不自动猜配。 */
export function groupOptimizationRuns(runs: readonly CapabilityRun[]): OptimizationPair[] {
  const groups = new Map<string, { baseline?: CapabilityRun; candidate?: CapabilityRun }>()
  for (const run of runs) {
    if (!run.comparisonId || !run.comparisonRole) continue
    const group = groups.get(run.comparisonId) ?? {}
    if (!group[run.comparisonRole]) group[run.comparisonRole] = run
    groups.set(run.comparisonId, group)
  }
  return [...groups.entries()]
    .flatMap(([id, group]) => group.baseline ? [{ id, baseline: group.baseline, candidate: group.candidate }] : [])
    .sort((left, right) => right.baseline.startedAt - left.baseline.startedAt)
}

/** 对比结论只基于双方明确完成的同口径判断，不合成质量分数。 */
export function compareOptimizationPair(baseline: CapabilityRun, candidate: CapabilityRun): {
  comparable: boolean
  reasons: string[]
  fixed: string[]
  regressed: string[]
  unknown: string[]
  candidatePassed: boolean
} {
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
        const before = beforeReview.criteria.find((item) => item.criterion === criterion)
        const after = afterReview?.criteria.find((item) => item.criterion === criterion)
        const label = stepId === '__scene__' ? criterion : `${stepId}：${criterion}`
        if (typeof before?.passed !== 'boolean' || typeof after?.passed !== 'boolean') {
          unknown.push(`判据：${label}`)
          continue
        }
        if (!before.passed && after.passed) fixed.push(label)
        if (before.passed && !after.passed) regressed.push(label)
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
  return {
    comparable: reasons.length === 0,
    reasons,
    fixed,
    regressed,
    unknown,
    candidatePassed: !candidate.evidenceIssues?.length && candidate.review?.passed === true
      && candidateReviews.every(([, review]) => review.passed === true),
  }
}

/** 只有候选明确通过、至少修复一项且没有退化，才允许进入采纳入口。 */
export function isAdoptableOptimizationComparison(comparison: ReturnType<typeof compareOptimizationPair>): boolean {
  return isAdoptableOptimizationBatch([comparison])
}

/** 整批同口径通过、无未知或退化且至少有一项改善，才允许采纳。 */
export function isAdoptableOptimizationBatch(
  comparisons: readonly ReturnType<typeof compareOptimizationPair>[],
): boolean {
  return comparisons.length > 0
    && comparisons.every((comparison) => comparison.comparable && comparison.candidatePassed
      && comparison.regressed.length === 0 && comparison.unknown.length === 0)
    && comparisons.some((comparison) => comparison.fixed.length > 0)
}
