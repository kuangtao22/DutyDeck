import type { CapabilitySceneDefinition, CapabilityRunModelBinding } from './capability-factory'
import type { CapabilityEvaluationProtocol, CapabilityExperimentSample, CapabilityCaseScore } from './capability-factory-experiment'
import type { CapabilityFactoryCallRecord } from './capability-factory-call-ledger'

/** 一期实验的阶段；中断为终态，不能重发结果未知的请求。 */
export type CapabilityExperimentStatus = 'prepared' | 'optimizing' | 'validating' | 'held-out' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
/** 留出保护只记录流程声明，普通文件工具仍可能读到材料。 */
export type CapabilityExperimentExposure = 'declared-unseen' | 'exposed' | 'unknown'
/** 宿主冻结数据集中的划分；指纹和标签内容不接受客户端自报。 */
export interface CapabilityExperimentAssignment {
  caseId: string
  split: CapabilityExperimentSample['split']
  sourceGroupId: string
  labelStatus: CapabilityExperimentSample['labelStatus']
}
/** 调用和时限硬边界；未知价格不提供金额硬封顶。 */
export interface CapabilityExperimentLimits {
  maxCalls: number
  maxTransportAttempts: number
  durationMs: number
}
/** 创建不启动模型请求；协议和划分在首次执行前冻结。 */
export interface CapabilityExperimentCreateRequest {
  sceneId: string
  expectedVersion: number
  datasetId: string
  targetStepId: string
  candidatePrompt: string
  protocol: CapabilityEvaluationProtocol
  assignments: CapabilityExperimentAssignment[]
  limits: CapabilityExperimentLimits
  heldOutExposure: CapabilityExperimentExposure
}
/** 每次推进只执行下一组；仅优化组完成后允许修改一次候选。 */
export interface CapabilityExperimentAdvanceRequest {
  sceneId: string
  experimentId: string
  expectedRevision: number
  candidatePrompt?: string
}
/** 独立保存候选，避免覆盖用户已有多块草案。 */
export interface CapabilityExperimentCandidate {
  id: 'A' | 'B'
  prompt: string
  definition: CapabilitySceneDefinition
  fingerprint: string
  createdAt: number
}
/** 一对运行只保存现有运行历史的引用及确定性分数。 */
export interface CapabilityExperimentPair {
  caseId: string
  comparisonId?: string
  baselineRunId?: string
  candidateRunId?: string
  baselineScore?: CapabilityCaseScore
  candidateScore?: CapabilityCaseScore
}
/** 所有预定用例计入分母，未知结果以错误率上下界报告。 */
export interface CapabilityExperimentQuality {
  planned: number
  paired: number
  unknown: number
  baselineMacroF1: number | null
  candidateMacroF1: number | null
  f1Delta: number | null
  baselineFailures: number
  candidateFailures: number
  baselineErrorBounds: [number, number]
  candidateErrorBounds: [number, number]
  validationEligible: boolean
  adoptionEligible: boolean
  reasons: string[]
}
/** 阶段证据绑定精确候选；A 的数据不能混入 B 的收益。 */
export interface CapabilityExperimentStage {
  split: CapabilityExperimentSample['split']
  candidateId: 'A' | 'B'
  candidateFingerprint: string
  batchId?: string
  pairs: CapabilityExperimentPair[]
  quality?: CapabilityExperimentQuality
  startedAt: number
  finishedAt: number | null
}
/** 持久实验账本；完整轨迹仍只存既有 runs/batches。 */
export interface CapabilityFactoryExperiment {
  id: string
  sceneId: string
  workspaceFingerprint: string
  revision: number
  /** 已消费实验绑定宿主进程代际；重启不恢复。 */
  processId?: string
  status: CapabilityExperimentStatus
  running: boolean
  sceneVersion: number
  datasetId: string
  datasetVersion: number
  datasetFingerprint: string
  protocol: CapabilityEvaluationProtocol
  protocolFingerprint: string
  samples: CapabilityExperimentSample[]
  targetStepId: string
  baselineDefinition: CapabilitySceneDefinition
  modelBindings: CapabilityRunModelBinding[]
  reviewModelBinding?: CapabilityRunModelBinding
  modelFingerprint: string
  /** 相关虚拟接入的宿主指纹；变化后必须新建实验。 */
  environmentFingerprint?: string
  /** 前次同场景实验引用，保留跨实验花费和材料使用的追溯。 */
  previousExperimentId?: string
  candidates: CapabilityExperimentCandidate[]
  stages: CapabilityExperimentStage[]
  heldOutExposure: CapabilityExperimentExposure
  /** 留出开始前冻结的声明；之后查看最终报告不会改写过去的事实。 */
  heldOutExposureAtStart?: CapabilityExperimentExposure
  limits: CapabilityExperimentLimits
  calls: CapabilityFactoryCallRecord[]
  roundsUsed: number
  runUnitsReserved: number
  createdAt: number
  startedAt: number | null
  deadlineAt: number | null
  updatedAt: number
  finishedAt: number | null
  stopReason?: string
  /** 供应商模型修订通常不可见，不能保证跨日完全复现。 */
  providerRevision: 'unknown'
  /** 提案 Agent 的混合回合费用不自动归入工厂调用费。 */
  proposalCost: 'unattributed'
}
/** 对外读取脱敏标签，只携带必要实验元数据；样本正文通过显式详情读取。 */
export type CapabilityFactoryExperimentView = Omit<CapabilityFactoryExperiment, 'samples'> & {
  samples: Array<Omit<CapabilityExperimentSample, 'expected'>>
  detailsUnavailableReason?: string
  details?: Array<{ caseId: string; input: Record<string, unknown>; expected?: unknown }>
}
