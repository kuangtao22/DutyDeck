/**
 * 评测这一段的展示逻辑（纯函数）。
 *
 * 评测页最容易做成"一个孤零零的百分比"，那样等于没评测 —— 百分比只有**跟谁比**才有意义：
 * 跟同一数据集的上一次比（提示词改了有没有进步），以及说清哪几次不可比。
 */
import type { CapabilityEvaluation, CapabilityJudgeResult } from '@proma/shared'

/** 合规率的展示：百分比 + 有效样本数（分母也要给人看，否则 1/1 和 20/20 看起来一样）。 */
export function describeCompliance(evaluation: CapabilityEvaluation): { percent: string; detail: string } {
  const total = evaluation.totalSamples
  const percent = total === 0 ? '—' : `${Math.round(evaluation.constraintCompliance * 100)}%`
  return { percent, detail: `有效样本 ${evaluation.validSamples}/${total}` }
}

/** 内容质量展示：通过数始终以全部用例为分母，并额外说明实际完成了多少评审。 */
export function describeQuality(evaluation: CapabilityEvaluation): { status: string; detail: string } {
  if (evaluation.reviewedSamples === undefined || evaluation.passedReviewSamples === undefined) {
    return { status: '未评审', detail: '这条历史记录没有内容评审结果' }
  }
  const total = evaluation.totalSamples
  if (total === 0) return { status: '未评审', detail: '没有可评审的样本' }
  const passed = evaluation.passedReviewSamples
  const reviewed = evaluation.reviewedSamples
  const status = passed === total ? '全部通过' : passed === 0 ? '未通过' : '部分通过'
  return { status, detail: `质量通过 ${passed}/${total} · 已完成评审 ${reviewed}/${total}` }
}

/** 判据聚合只描述已判断项，避免把评审失败或无法判断当成判据失败。 */
export function describeJudgeResult(result: CapabilityJudgeResult): string {
  return `${result.passed}/${result.total} 已判断通过`
}

/**
 * 与上一条同数据集的评测对比。
 *
 * 只在数据集版本相同时才给数字结论 —— 换了一批用例，分数自然不可比，
 * 这种情况必须说出来，而不是照样算出"+12%"。
 *
 * @param current 这一次评测
 * @param previous 同数据集的上一条评测；没有则传 null
 * @returns 一句可直接显示的结论
 */
export function describeEvaluationComparison(
  current: CapabilityEvaluation,
  previous: CapabilityEvaluation | null,
): string {
  if (!previous) return '这是这份数据集的第一次评测，还没有可对比的基线。'
  if (previous.datasetVersion !== current.datasetVersion) {
    return `数据集从 v${previous.datasetVersion} 变成了 v${current.datasetVersion}：用例集不一样，分数不能直接比。`
  }
  const delta = current.constraintCompliance - previous.constraintCompliance
  const points = Math.round(Math.abs(delta) * 100)
  if (points === 0) {
    return `与上一次相同（场景 v${previous.sceneVersion} → v${current.sceneVersion}）：合规率没有变化。`
  }
  const direction = delta > 0 ? `提高 ${points} 个百分点` : `下降 ${points} 个百分点`
  return `比上一次（场景 v${previous.sceneVersion}）${direction}：`
    + `v${previous.sceneVersion} 是 ${Math.round(previous.constraintCompliance * 100)}%，`
    + `v${current.sceneVersion} 是 ${Math.round(current.constraintCompliance * 100)}%。`
}

/** 数据集默认名：评测要能区分"这一组是什么输入"。 */
export function suggestedDatasetName(sceneName: string): string {
  const trimmed = sceneName.trim()
  return trimmed.length === 0 ? '真实输入集' : `${trimmed} · 真实输入集`
}
