/** 工厂标签评分协议；内部元数据不进入可移植能力包。 */
export interface CapabilityEvaluationProtocol {
  /** 任意标签、字段、规范或判据变化必须产生新版本。 */
  protocolVersion: string
  scorerVersion: 1
  primaryMetric: 'f1' | 'business-error-rate'
  mode: 'exact-value' | 'tuple-set'
  /** 从 run.outputs 读取的点分隔路径；空字符串表示整个值。 */
  outputPath: string
  /** 从样本 expected 读取的点分隔路径。 */
  expectedPath: string
  /** 集合项内的匹配路径；空数组表示直接匹配完整项。 */
  tupleFields: string[]
  normalization: { trim: boolean; caseFold: boolean; arrayOrder: 'ordered' | 'set' }
  /** 是否把既有语义评审纳入整条业务通过规则。 */
  requireReview: boolean
}

/** 样本身份、来源和标签完整性；旧 expected 字段不意味着已核对。 */
export interface CapabilityExperimentSample {
  caseId: string
  split: 'optimization' | 'validation' | 'held-out'
  sourceGroupId: string
  inputFingerprint: string
  labelStatus: 'complete' | 'partial' | 'unverified'
  expected?: unknown
}

/** 一次确定性评分；机器指标与既有模型 review 独立。 */
export interface CapabilityCaseScore {
  caseId: string
  protocolVersion: string
  scorerVersion: 1
  /** 完整协议键防止同版本名称下不同规范被混算。 */
  protocolFingerprint: string
  inputFingerprint: string
  sourceGroupId: string
  split: CapabilityExperimentSample['split']
  labelStatus: CapabilityExperimentSample['labelStatus']
  runId: string | null
  sceneId: string | null
  sceneVersion: number | null
  outcome: 'passed' | 'failed' | 'unknown'
  reason: string
  tp: number | null
  fp: number | null
  fn: number | null
  precision: number | null
  recall: number | null
  f1: number | null
  /** 只有完整标签已知为空时有值；与非空样本 F1 分开。 */
  correctEmpty: boolean | null
  /** 非空完整标签是否可纳入主指标分母。 */
  f1Eligible: boolean
  duplicatePredictions: number | null
  duplicateLabels: number | null
}

/** 全部预定样本的汇总，未知绝不从错误率分母移除。 */
export interface CapabilityScoreSummary {
  planned: number
  passed: number
  failed: number
  unknown: number
  errorRateLower: number | null
  errorRateUpper: number | null
  macroF1: number | null
  f1Samples: number
  emptySamples: number
  correctEmptySamples: number
  emptyAccuracy: number | null
  duplicatePredictions: number
}

/** 仅接受普通对象；用于验证外部 JSON，不执行任何评分脚本。 */
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
/** 点路径禁用原型成员，空路径明确表示根节点。 */
function pathValid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1024
    && (value === '' || value.split('.').every((part) => part.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(part)))
}
/** 验证宿主收到的冻结协议，返回隔离副本；未知版本拒绝执行。 */
export function validateCapabilityEvaluationProtocol(value: unknown): CapabilityEvaluationProtocol {
  if (!object(value) || Object.keys(value).some((key) => !['protocolVersion', 'scorerVersion', 'primaryMetric', 'mode', 'outputPath', 'expectedPath', 'tupleFields', 'normalization', 'requireReview'].includes(key))
    || typeof value.protocolVersion !== 'string' || !value.protocolVersion.trim() || value.protocolVersion.length > 128
    || value.scorerVersion !== 1 || !['f1', 'business-error-rate'].includes(String(value.primaryMetric))
    || !['exact-value', 'tuple-set'].includes(String(value.mode))
    || !pathValid(value.outputPath) || !pathValid(value.expectedPath)
    || !Array.isArray(value.tupleFields) || value.tupleFields.length > 32 || !value.tupleFields.every(pathValid)
    || new Set(value.tupleFields).size !== value.tupleFields.length
    || !object(value.normalization) || Object.keys(value.normalization).some((key) => !['trim', 'caseFold', 'arrayOrder'].includes(key))
    || typeof value.normalization.trim !== 'boolean'
    || typeof value.normalization.caseFold !== 'boolean' || !['ordered', 'set'].includes(String(value.normalization.arrayOrder))
    || typeof value.requireReview !== 'boolean') throw new Error('评分协议无效或评分器版本不受支持')
  return structuredClone(value) as unknown as CapabilityEvaluationProtocol
}
/** 校验全部冻结样本；禁止来源跨组和重复输入，部分标签保留真实状态。 */
export function validateCapabilityExperimentSamples(value: unknown): CapabilityExperimentSample[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('实验样本不能为空')
  /** 每项独立验证后再检查分组关系。 */
  const groups = new Map<string, string>()
  const ids = new Set<string>()
  const inputs = new Set<string>()
  for (const item of value) {
    if (!object(item) || !['caseId', 'sourceGroupId', 'inputFingerprint'].every((key) => typeof item[key] === 'string' && String(item[key]).trim())
      || String(item.caseId).length > 128 || String(item.sourceGroupId).length > 128
      || !['optimization', 'validation', 'held-out'].includes(String(item.split))
      || !['complete', 'partial', 'unverified'].includes(String(item.labelStatus))) throw new Error('实验样本身份或标签状态无效')
    if (item.labelStatus !== 'unverified' && item.expected === undefined) throw new Error('已核对标签不能为空')
    const id = String(item.caseId)
    const group = String(item.sourceGroupId)
    const fingerprint = String(item.inputFingerprint)
    const split = String(item.split)
    if (ids.has(id)) throw new Error('重复用例标识')
    if (inputs.has(fingerprint)) throw new Error('实验包含重复输入')
    if (groups.has(group) && groups.get(group) !== split) throw new Error('同一来源不能跨数据划分')
    ids.add(id)
    inputs.add(fingerprint)
    groups.set(group, split)
  }
  return structuredClone(value) as CapabilityExperimentSample[]
}
