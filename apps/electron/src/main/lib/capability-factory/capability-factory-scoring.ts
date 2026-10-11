import { stableCapabilityValueKey, validateCapabilityEvaluationProtocol } from '@proma/shared'
import type { CapabilityCaseScore, CapabilityEvaluationProtocol, CapabilityExperimentSample, CapabilityRun, CapabilityScoreSummary } from '@proma/shared'

/** 从普通 JSON 值读取配置路径；缺字段返回 undefined，不发现原型属性。 */
function readPath(value: unknown, path: string): unknown {
  if (path === '') return value
  return path.split('.').reduce<unknown>((current, key) => current !== null && typeof current === 'object'
    && Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined, value)
}
/** 按冻结规范递归处理字符串与数组，普通对象键序交给稳定编码器处理。 */
function normalize(value: unknown, protocol: CapabilityEvaluationProtocol): unknown {
  if (typeof value === 'string') {
    const text = protocol.normalization.trim ? value.trim() : value
    return protocol.normalization.caseFold ? text.toLowerCase() : text
  }
  if (Array.isArray(value)) {
    const values = value.map((item) => normalize(item, protocol))
    return protocol.normalization.arrayOrder === 'set'
      ? [...new Map(values.map((item) => [stableCapabilityValueKey(item), item])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item)
      : values
  }
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, protocol)]))
  return value
}
/** 提取集合项的冻结匹配字段；任何缺字段均使结构不可评分。 */
function keys(value: unknown, protocol: CapabilityEvaluationProtocol): string[] | null {
  if (!Array.isArray(value)) return null
  const result: string[] = []
  for (const item of value) {
    const tuple = protocol.tupleFields.length ? protocol.tupleFields.map((path) => readPath(item, path)) : [item]
    if (tuple.some((field) => field === undefined)) return null
    /** 元组位置来自冻结字段协议，不是用户数组；仅归一化各字段值，避免关系方向被集合排序抹去。 */
    result.push(stableCapabilityValueKey(tuple.map((field) => normalize(field, protocol))))
  }
  return result
}

/**
 * 在实验启动前验证所有完整标签；空集合合法，非空主指标分母由实验阶段另外检查。
 * @param protocol 已冻结的字段路径与归一化规则
 * @param samples 待启动实验的全部样本，不允许部分标签冒充完整答案
 * @returns 校验成功不返回值；不完整、缺字段或归一化后重复时抛出中文错误
 */
export function assertCapabilityScoringLabels(protocol: CapabilityEvaluationProtocol, samples: readonly CapabilityExperimentSample[]): void {
  validateCapabilityEvaluationProtocol(protocol)
  for (const sample of samples) {
    if (typeof sample.caseId !== 'string' || !sample.caseId.trim() || sample.caseId.length > 128
      || typeof sample.sourceGroupId !== 'string' || !sample.sourceGroupId.trim() || sample.sourceGroupId.length > 128) {
      throw new Error('样本用例与来源标识必须为 1–128 字')
    }
    if (sample.labelStatus !== 'complete') throw new Error(`样本 ${sample.caseId} 必须使用完整且已核对的标签`)
    /** 按冻结标签路径读取；null 是有效精确值，undefined 表示缺字段。 */
    const expected = readPath(sample.expected, protocol.expectedPath)
    if (expected === undefined) throw new Error(`样本 ${sample.caseId} 的标签路径不存在`)
    if (protocol.mode !== 'tuple-set') continue
    /** 复用实际评分的字段提取和归一化，避免预检与执行口径分叉。 */
    const expectedKeys = keys(expected, protocol)
    if (expectedKeys === null) throw new Error(`样本 ${sample.caseId} 的标签集合或匹配字段无效`)
    if (new Set(expectedKeys).size !== expectedKeys.length) throw new Error(`样本 ${sample.caseId} 的标签包含重复匹配项`)
  }
}

/** 输入冻结协议、样本和实际运行，返回与模型评审分开的确定性证据。 */
export function scoreCapabilityCase(protocol: CapabilityEvaluationProtocol, sample: CapabilityExperimentSample, run?: CapabilityRun): CapabilityCaseScore {
  validateCapabilityEvaluationProtocol(protocol)
  const score: CapabilityCaseScore = {
    caseId: sample.caseId, protocolVersion: protocol.protocolVersion, scorerVersion: 1,
    protocolFingerprint: stableCapabilityValueKey(protocol), inputFingerprint: sample.inputFingerprint,
    sourceGroupId: sample.sourceGroupId, split: sample.split, labelStatus: sample.labelStatus,
    runId: run?.id ?? null, sceneId: run?.sceneId ?? null, sceneVersion: run?.sceneVersion ?? null,
    outcome: 'unknown', reason: '运行未完成或标签未核对', tp: null, fp: null, fn: null,
    precision: null, recall: null, f1: null, correctEmpty: null, f1Eligible: false,
    duplicatePredictions: null, duplicateLabels: null,
  }
  const expected = readPath(sample.expected, protocol.expectedPath)
  const expectedKeys = protocol.mode === 'tuple-set' ? keys(expected, protocol) : null
  score.f1Eligible = sample.labelStatus === 'complete' && protocol.mode === 'tuple-set' && expectedKeys !== null && expectedKeys.length > 0
  if (sample.labelStatus === 'unverified' || expected === undefined || (protocol.mode === 'tuple-set' && expectedKeys === null)) return score
  if (!run || run.status === 'running' || run.status === 'cancelled' || run.status === 'partial' || run.placeholderCapabilities?.length) return score
  /** 执行异常只有具备明确约束错误时才属于结构业务失败，其余失败保持未知。 */
  const structuralFailure = !run.valid && (run.status === 'succeeded' || run.steps.some((step) => (step.constraintErrors?.length ?? 0) > 0))
  if (run.status !== 'succeeded' && !structuralFailure) return score
  if (structuralFailure) {
    score.outcome = sample.labelStatus === 'complete' ? 'failed' : 'unknown'
    score.reason = '输出结构无效'
    if (score.f1Eligible) { score.tp = 0; score.fn = new Set(expectedKeys).size; score.recall = 0; score.f1 = 0 }
    if (sample.labelStatus === 'complete' && expectedKeys?.length === 0) score.correctEmpty = false
    return score
  }
  /** 占位、评审异常不能被确定性命中覆盖为整体通过。 */
  const reviewUnknown = protocol.requireReview && (run.review?.status !== 'succeeded' || run.review.passed === null)
  const prediction = readPath(run.outputs, protocol.outputPath)
  if (protocol.mode === 'exact-value') {
    score.outcome = sample.labelStatus === 'complete'
      ? prediction !== undefined && stableCapabilityValueKey(normalize(prediction, protocol)) === stableCapabilityValueKey(normalize(expected, protocol)) ? 'passed' : 'failed'
      : 'unknown'
  } else {
    const predictionKeys = keys(prediction, protocol)
    if (!predictionKeys || !expectedKeys) {
      score.outcome = sample.labelStatus === 'complete' ? 'failed' : 'unknown'
      score.reason = '输出字段结构无效'
      if (score.f1Eligible) score.f1 = 0
      if (sample.labelStatus === 'complete' && expectedKeys?.length === 0) score.correctEmpty = false
      return score
    }
    const predicted = new Set(predictionKeys)
    const labeled = new Set(expectedKeys)
    score.duplicatePredictions = predictionKeys.length - predicted.size
    score.duplicateLabels = expectedKeys.length - labeled.size
    if (score.duplicateLabels > 0) { score.reason = '冻结标签含重复匹配项，需核对后新建协议'; return score }
    score.tp = [...predicted].filter((key) => labeled.has(key)).length
    if (sample.labelStatus === 'complete') {
      score.fp = predicted.size - score.tp
      score.fn = labeled.size - score.tp
      score.precision = predicted.size ? score.tp / predicted.size : null
      score.recall = labeled.size ? score.tp / labeled.size : null
      score.f1 = predicted.size + labeled.size ? 2 * score.tp / (predicted.size + labeled.size) : null
      score.correctEmpty = labeled.size === 0 ? predicted.size === 0 : null
      score.outcome = score.fp === 0 && score.fn === 0 && score.duplicatePredictions === 0 ? 'passed' : 'failed'
    }
  }
  score.reason = score.outcome === 'unknown' ? '部分标签不能证明完整质量' : '按冻结标签与匹配规范评分'
  if (run.evidenceIssues?.length || (protocol.requireReview && run.review?.passed === false)) {
    score.outcome = 'failed'
    score.reason = '证据检查或冻结语义评审未通过'
  }
  if (reviewUnknown) { score.outcome = 'unknown'; score.reason = '评审缺失或异常，整条业务结果未知' }
  return score
}

/** 按全部计划 ID 汇总，遗漏、重复或异协议评分计未知，禁止只汇报成功子集。 */
export function summarizeCapabilityScores(plannedCaseIds: readonly string[], scores: readonly CapabilityCaseScore[]): CapabilityScoreSummary {
  if (new Set(plannedCaseIds).size !== plannedCaseIds.length) throw new Error('汇总计划包含重复用例')
  const protocolKeys = new Set(scores.map((score) => score.protocolFingerprint))
  const records = plannedCaseIds.map((id) => {
    const matches = scores.filter((score) => score.caseId === id)
    return protocolKeys.size === 1 && matches.length === 1 ? matches[0] : undefined
  })
  const passed = records.filter((score) => score?.outcome === 'passed').length
  const failed = records.filter((score) => score?.outcome === 'failed').length
  const unknown = records.length - passed - failed
  const f1Scores = records.filter((score): score is CapabilityCaseScore => score?.f1Eligible === true)
  const emptyScores = records.filter((score): score is CapabilityCaseScore => score?.correctEmpty !== null && score?.correctEmpty !== undefined)
  const correctEmptySamples = emptyScores.filter((score) => score.correctEmpty).length
  return {
    planned: records.length, passed, failed, unknown,
    errorRateLower: records.length ? failed / records.length : null,
    errorRateUpper: records.length ? (failed + unknown) / records.length : null,
    macroF1: unknown === 0 && f1Scores.length > 0 && f1Scores.every((score) => score.f1 !== null)
      ? f1Scores.reduce((sum, score) => sum + (score.f1 ?? 0), 0) / f1Scores.length : null,
    f1Samples: f1Scores.length, emptySamples: emptyScores.length, correctEmptySamples,
    emptyAccuracy: unknown === 0 && emptyScores.length ? correctEmptySamples / emptyScores.length : null,
    duplicatePredictions: records.reduce((sum, score) => sum + (score?.duplicatePredictions ?? 0), 0),
  }
}
