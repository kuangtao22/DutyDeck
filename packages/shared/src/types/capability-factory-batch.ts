import type { CapabilitySceneDefinition, CapabilityRunStatus } from './capability-factory'

/** 批次用途：普通数据集评测，或当前定义与候选草案的同条件对比。 */
export type CapabilityFactoryBatchKind = 'evaluation' | 'comparison'

/** 批次生命周期；interrupted 只表示持久记录仍在运行，但当前进程没有对应执行。 */
export type CapabilityFactoryBatchStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

/** 单项执行状态，完成项在取消或失败后仍保留证据索引。 */
export type CapabilityFactoryBatchItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** 启动批次的请求；scopeId 由宿主注入 runner，不能由模型或 IPC 调用方自报。 */
export interface CapabilityFactoryBatchRequest {
  sceneId: string
  kind: CapabilityFactoryBatchKind
  datasetId?: string
  /** 数据集可长期积累任意数量用例；单批通过此字段显式选择最多 10 条。 */
  caseIds?: string[]
  taskIds?: string[]
  expectedVersion?: number
  expectedDraftCreatedAt?: number
  expectedDraftDefinition?: CapabilitySceneDefinition
}

/** 开始执行时冻结的身份与输入集合，防止等待期间混入新版本。 */
export interface CapabilityFactoryBatchSnapshot {
  sceneVersion: number
  datasetId?: string
  datasetVersion?: number
  draftCreatedAt?: number
  draftDefinition?: CapabilitySceneDefinition
  itemIds: string[]
}

/** 一条冻结任务；只保存输入和运行 ID，不复制运行输出与轨迹。 */
export interface CapabilityFactoryBatchItem {
  id: string
  name: string
  input: Record<string, unknown>
  status: CapabilityFactoryBatchItemStatus
  runId?: string
  comparisonId?: string
  baselineRunId?: string
  candidateRunId?: string
  error?: string
}

/** evaluation 批次的质量汇总；评审缺失或失败不会按通过处理。 */
export interface CapabilityFactoryBatchEvaluationSummary {
  total: number
  completed: number
  valid: number
  reviewed: number
  passedReview: number
}

/** comparison 批次的可解释汇总，不合成缺少依据的总分。 */
export interface CapabilityFactoryBatchComparisonSummary {
  comparable: number
  candidatePassed: number
  fixed: string[]
  regressed: string[]
  unknown: string[]
  reasons: string[]
}

/** 可恢复的完整批次记录；原始输出通过 runId 从运行历史精确读取。 */
export interface CapabilityFactoryBatch {
  id: string
  scopeId?: string
  sceneId: string
  kind: CapabilityFactoryBatchKind
  status: CapabilityFactoryBatchStatus
  snapshot: CapabilityFactoryBatchSnapshot
  items: CapabilityFactoryBatchItem[]
  evaluation?: CapabilityFactoryBatchEvaluationSummary
  comparison?: CapabilityFactoryBatchComparisonSummary
  adoptable: boolean
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  error?: string
}

/** 列表只返回轻量摘要，完整输入由 get 按批次 ID 精确读取。 */
export interface CapabilityFactoryBatchSummary {
  id: string
  scopeId?: string
  sceneId: string
  kind: CapabilityFactoryBatchKind
  status: CapabilityFactoryBatchStatus
  itemCount: number
  completedCount: number
  evaluation?: CapabilityFactoryBatchEvaluationSummary
  comparison?: CapabilityFactoryBatchComparisonSummary
  adoptable: boolean
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  error?: string
}

/** 批次调用运行器时复用单次运行选项，不另建模型执行协议。 */
export interface CapabilityFactoryBatchRunOptions {
  saveTask?: boolean
  target?: 'current' | 'draft'
  expectedVersion?: number
  expectedDraftCreatedAt?: number
  expectedDraftDefinition?: CapabilitySceneDefinition
  comparisonId?: string
  comparisonRole?: 'baseline' | 'candidate'
}

/** 批次执行端口；返回值必须是已经进入运行历史的真实记录。 */
export type CapabilityFactoryBatchRun = (
  sceneId: string,
  input: Record<string, unknown>,
  options?: CapabilityFactoryBatchRunOptions,
) => Promise<{
  id: string
  sceneId: string
  sceneVersion: number
  status: CapabilityRunStatus
  valid: boolean
  review?: { status: 'running' | 'succeeded' | 'failed' | 'skipped'; passed: boolean | null }
  placeholderCapabilities?: string[]
  evidenceIssues?: string[]
  error?: string
}>
