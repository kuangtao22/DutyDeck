import { getReviewSteps, getStepAcceptance, stableCapabilityValueKey } from '../types/capability-factory'
import type { CapabilityRun } from '../types/capability-factory'
import type { CapabilityRunDiagnosis } from '../types/capability-factory-review-retry'

/** 根据保存的执行与评审证据生成诊断；不调用模型、不改写运行记录。 */
export function diagnoseCapabilityRun(run: CapabilityRun): CapabilityRunDiagnosis {
  /** 所有问题均保留，主分类只决定建议的优先处理顺序。 */
  const issues: CapabilityRunDiagnosis['issues'] = []
  const retryableStepIds: string[] = []
  /** 输出一致的用户建议，避免把执行失败与评审异常混为一谈。 */
  const result = (category: CapabilityRunDiagnosis['category'], summary: string, nextAction: string): CapabilityRunDiagnosis =>
    ({ category, summary, nextAction, retryableStepIds, issues })
  if (run.status === 'running' || run.review?.status === 'running') {
    return result('in-progress', '执行或评审仍在进行。', '等待当前任务结束，避免重复发送。')
  }
  if (run.status !== 'succeeded') {
    issues.push({ kind: 'execution-failed', message: run.error ?? '执行未完整成功。' })
    return result('execution-failed', '执行未完整成功，不能仅补评。', '检查失败步骤及其输入，修复后重新验证执行。')
  }
  if (!run.valid || run.evidenceIssues?.length || run.steps.some((step) => step.constraintErrors?.length)) {
    for (const message of run.evidenceIssues ?? []) issues.push({ kind: 'evidence-invalid', message })
    for (const step of run.steps) for (const message of step.constraintErrors ?? []) issues.push({ stepId: step.stepId, kind: 'invalid-output', message })
    return result('invalid-output', '输出约束或证据引用未通过。', '先修复输出结构或引用来源，补评不会修复已有输出。')
  }
  if (run.placeholderCapabilities?.length) {
    issues.push({ kind: 'placeholder', message: '含占位桩，无法形成真实质量证据。' })
    return result('review-incomplete', '当前材料包含占位数据。', '用真实材料替换占位数据后重新验证。')
  }
  /** 只接受逐步骤记录；历史聚合报告仍可诊断，但不猜测其对应步骤。 */
  const entries = Object.entries(run.stepReviews ?? {})
  const reports = entries.length ? entries : run.review ? [[undefined, run.review] as const] : []
  const definition = run.definitionSnapshot
  const modelSteps = definition ? getReviewSteps(definition.steps) : []
  /** 单步只要求当前步骤的标准；整链要求所有模型步骤均有评审标准。 */
  const expectedSteps = modelSteps.filter((step) => run.kind !== 'step' || run.stepId === step.id)
  for (const step of expectedSteps) {
    if (definition && !getStepAcceptance(definition, step.id)) {
      issues.push({ stepId: step.id, kind: 'missing-acceptance', message: '该模型步骤缺少评审标准，不能宣称内容已完整通过。' })
    }
  }
  for (const [stepId, review] of reports) {
    if (review.status === 'succeeded' && review.passed === false) {
      issues.push({ stepId, kind: 'content-failed', message: review.summary })
      continue
    }
    if (review.status !== 'failed') {
      if (review.status !== 'succeeded' || review.passed !== true || review.finishedAt === null) {
        issues.push({ stepId, kind: 'review-incomplete', message: review.summary || '评审尚未得出完整结论。' })
      }
      continue
    }
    const failure = review.failureKind ?? (review.error?.startsWith('内容评审超时') ? 'timeout' : 'model-error')
    issues.push({ stepId, kind: failure, message: review.error ?? review.summary })
    const step = modelSteps.find((item) => item.id === stepId)
    const acceptance = definition && stepId ? getStepAcceptance(definition, stepId) : null
    const traces = run.steps.filter((item) => item.stepId === stepId)
    const binding = review.modelBinding
    /** 冻结标准、成功输出和完整模型身份缺一不可；内容不通过不是恢复型故障。 */
    const complete = definition && step && acceptance && binding?.channelId.trim() && binding.modelId.trim()
      && binding.declaredModel.trim() && binding.slotId.trim()
      && stableCapabilityValueKey(acceptance) === stableCapabilityValueKey(review.acceptance)
      && run.finishedAt !== null && (run.outputs !== null || (run.kind === 'step' && run.stepId === stepId))
      && (run.kind !== 'step' || run.stepId === stepId) && run.review?.finishedAt != null
      && review.finishedAt !== null && traces.length > 0
      && traces.every((trace) => trace.status === 'succeeded' && (trace.parsedOutput !== undefined || trace.rawOutput !== undefined))
    if (stepId && complete && review.passed !== false && (failure === 'timeout' || failure === 'invalid-response')) retryableStepIds.push(stepId)
    else if (!complete) issues.push({ stepId, kind: 'missing-evidence', message: '缺少一致的定义、标准、模型绑定或已完成步骤输出，不能安全补评。' })
  }
  if (issues.some((item) => item.kind === 'content-failed')) {
    return result('content-failed', '已有评审确认内容未达标。', retryableStepIds.length
      ? '保留内容问题；可有界补评其它异常步骤，但不能用重试抹去不达标结论。' : '依据具体证据调整提取提示词，并用独立样本验证。')
  }
  if (retryableStepIds.length) return result('review-retryable', '执行输出已保留，部分评审遇到可恢复异常。', '使用诊断返回的源指纹和明确预算，只补评列出的失败步骤。')
  if (reports.some(([, review]) => review.status === 'failed')) return result('review-failed', '评审异常，当前证据不允许自动补评。', '检查模型服务、取消原因或缺失快照；不要直接重跑整链。')
  if (!reports.length || issues.length || (definition && modelSteps.some((step) =>
    (run.kind !== 'step' || run.stepId === step.id) && getStepAcceptance(definition, step.id) && !run.stepReviews?.[step.id]))) {
    return result('review-incomplete', '尚无完整、可判断的内容评审结论。', '补齐评审标准或事实依据，不能把未知计为通过。')
  }
  return result('passed', '执行、约束与已记录的内容评审通过。', '按原有验证与采纳流程继续；单次通过不代表泛化能力。')
}
