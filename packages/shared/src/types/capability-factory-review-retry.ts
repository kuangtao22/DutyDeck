import type { CapabilityRunReview } from './capability-factory'
import type { CapabilityFactoryCallRecord } from './capability-factory-call-ledger'

/** 评审异常的稳定分类；内容未达标不属于调用故障。 */
export type CapabilityRunReviewFailureKind = 'timeout' | 'cancelled' | 'invalid-response' | 'model-error'
/** 不调用模型的运行诊断，包含原始问题与下一步建议。 */
export interface CapabilityRunDiagnosis {
  category: 'in-progress' | 'execution-failed' | 'invalid-output' | 'content-failed' | 'review-incomplete' | 'review-failed' | 'review-retryable' | 'passed'
  summary: string
  nextAction: string
  retryableStepIds: string[]
  issues: { stepId?: string; kind: string; message: string }[]
}
/** 补评的逻辑调用、可观测传输与总耗时上限。 */
export interface CapabilityFactoryReviewRetryLimits {
  maxCalls: number
  maxTransportAttempts: number
  durationMs: number
}
/** 调用方必须绑定最近诊断的源记录，不允许替换评审材料。 */
export interface CapabilityFactoryReviewRetryRequest {
  sceneId: string
  runId: string
  expectedSourceFingerprint: string
  limits: CapabilityFactoryReviewRetryLimits
}
/** 补评独立保存，不覆盖原运行及其质量证据。 */
export interface CapabilityFactoryReviewRetryRecord {
  id: string
  sceneId: string
  sourceRunId: string
  sourceFingerprint: string
  modelFingerprint: string
  processId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  stepIds: string[]
  limits: CapabilityFactoryReviewRetryLimits
  calls: CapabilityFactoryCallRecord[]
  reviews: Record<string, CapabilityRunReview>
  /** 取消、超时或身份漂移后收到的有界原始响应，仅供排障，永不计入质量结论。 */
  excludedResponses?: Record<string, {
    text: string
    truncated: boolean
    receivedAt: number
    reason: string
  }>
  startedAt: number
  deadlineAt: number
  finishedAt: number | null
  summary: string
  nextAction: string
}
/** 宿主附加源身份和已发生的唯一补评记录。 */
export interface CapabilityFactoryRunDiagnosis extends CapabilityRunDiagnosis {
  sceneId: string
  runId: string
  sourceFingerprint: string
  retry: CapabilityFactoryReviewRetryRecord | null
}
