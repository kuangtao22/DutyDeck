import type { ServerOpsDataWriteInput, ServerOpsDataWriteResult } from '@proma/shared'

/**
 * 没拿到可信引擎回执时生成保守结果，不能从取消、断线或错误文本推断回滚。
 * @param input 发起时的固定目标和运行身份
 * @param error 只提取有界领域错误码，私有驱动正文不出进程
 * @param dispatched 是否已经进入实际执行路径
 * @param durationMs 本次请求已经消耗的时间
 */
export function createServerOpsWriteFailureResult(
  input: ServerOpsDataWriteInput,
  error: unknown,
  dispatched: boolean,
  durationMs: number,
): ServerOpsDataWriteResult {
  /** IPC 包装信息不可信，只接受完整匹配的稳定分类。 */
  const candidate = error !== null && typeof error === 'object' && 'code' in error
    ? error.code : error instanceof Error ? error.message : ''
  const errorCode = typeof candidate === 'string' && candidate.length <= 128 && /^SERVER_OPS_[A-Z_]+$/u.test(candidate)
    ? candidate : 'SERVER_OPS_DATA_WRITE_FAILED'
  return {
    writeId: input.writeId, database: input.database, statementCount: 0, affectedRows: 0,
    committed: false, outcome: dispatched ? 'unknown' : 'not-started', errorCode,
    durationMs: Math.max(0, Math.round(durationMs)), statements: [],
    warnings: dispatched ? ['未能确认数据库最终状态，请核对数据后再决定是否重跑'] : [],
  }
}
