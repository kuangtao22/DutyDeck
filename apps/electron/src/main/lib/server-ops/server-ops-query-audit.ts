import { randomUUID } from 'node:crypto'
import { getServerOpsDataWriteOutcome } from '@proma/shared'
import type { ServerOpsAuditAppendInput, ServerOpsAuditRecord, ServerOpsDataWriteResult } from '@proma/shared'

/** 只读 SQL 结果的最小预算合同。 */
interface QueryResult { rows: unknown[][]; rowCount: number; truncated: boolean; warnings: string[] }
/** 执行者只传受控摘要，类型合同不接受 SQL 正文。 */
interface QueryAuditOptions<T extends QueryResult> {
  summary: { sourceId: string; database: string; tables: string[]; queryHash: string }
  actor: { actor: 'agent'; sessionId: string } | { actor: 'user'; windowId: number }
  audit: { append(input: ServerOpsAuditAppendInput): ServerOpsAuditRecord; prepareForWrites?: () => Promise<void> }
  check: () => void
  execute: () => Promise<T>
}
/** 查询前审计失败只透传这些稳定分类，任意磁盘路径、系统异常和正文都不返回。 */
const AUDIT_START_ERROR_CODES: ReadonlySet<string> = new Set([
  'SERVER_OPS_OTHER_INSTANCE_ACTIVE', 'SERVER_OPS_TRUST_BUSY', 'SERVER_OPS_CONFIG_BUSY',
  'SERVER_OPS_CONFIG_LOCK_UNAVAILABLE', 'SERVER_OPS_CONFIG_OUTCOME_UNKNOWN',
  'SERVER_OPS_AUDIT_READ_FAILED', 'SERVER_OPS_AUDIT_SCHEMA_NOT_PREPARED', 'SERVER_OPS_AUDIT_WRITE_FAILED',
])

/** 将准备或开始写入异常转成安全稳定码；未知原因仍失败关闭，不暴露原始异常。 */
function getAuditStartErrorCode(error: unknown): string {
  /** 配置事务以 code 携带分类，普通领域错误才读取完整 message。 */
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
  /** 精确匹配白名单，含稳定码前缀的私有正文也不能透传。 */
  const candidate = typeof code === 'string' ? code : error instanceof Error ? error.message : ''
  return AUDIT_START_ERROR_CODES.has(candidate) ? candidate : 'SERVER_OPS_AUDIT_START_WRITE_FAILED'
}

/** 窗口与 Agent 共用审计执行顺序；后续实现不得记录 SQL 或行内容。 */
export async function runAuditedServerOpsQuery<T extends QueryResult>(options: QueryAuditOptions<T>): Promise<T> {
  options.check()
  try { await options.audit.prepareForWrites?.() } catch (error) { throw new Error(getAuditStartErrorCode(error)) }
  options.check()
  /** 摘要复制后冻结实际范围，调用方之后修改数组不能污染审计。 */
  const common = { ...options.actor, ...options.summary, tables: [...options.summary.tables],
    operation: 'data-query' as const, resourceType: 'data-query' as const, operationId: randomUUID() }
  /** 墙钟只用于有界耗时，不接收调用方提交的时间。 */
  const startedAt = Date.now()
  try { options.audit.append({ ...common, phase: 'start', outcome: 'pending' }) } catch (error) { throw new Error(getAuditStartErrorCode(error)) }
  let result: T
  try {
    options.check()
    result = await options.execute()
    options.check()
  } catch (error) {
    /** runtime 的取消拒绝可能晚于撤权；优先归因当前授权或用户取消原因。 */
    try { options.check() } catch (checkError) { error = checkError }
    /** 错误仅保留本模块稳定码，不泄露驱动错误里的 SQL、密码或字面值。 */
    const runtimeCode = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
    /** runtime 错误用 code 承载分类，普通领域错误才以 message 承载稳定码。 */
    const candidateCode = typeof runtimeCode === 'string' ? runtimeCode : error instanceof Error ? error.message : ''
    /** 只返回有界的大写领域码，不透传任何驱动正文。 */
    const errorCode = candidateCode.length <= 128 && /^SERVER_OPS_[A-Z_]+$/.test(candidateCode) ? candidateCode : 'SERVER_OPS_SQL_FAILED'
    try { options.audit.append({ ...common, phase: 'result', outcome: 'error', errorCode, durationMs: Math.min(86_400_000, Math.max(0, Date.now() - startedAt)) }) } catch { /* 已失败的读取不返回行数据，也不拼接底层审计异常。 */ }
    throw new Error(errorCode)
  }
  try {
    options.audit.append({ ...common, phase: 'result', outcome: 'success', durationMs: Math.min(86_400_000, Math.max(0, Date.now() - startedAt)) })
  } catch {
    result = structuredClone(result)
    result.warnings = [...result.warnings.slice(0, 7), 'SERVER_OPS_AUDIT_RESULT_WRITE_FAILED']
    /** 固定警告也占返回预算，必要时裁剪行并明确标记，避免最后一步超限。 */
    while (Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8') > 32_768 && result.rows.length) {
      result.rows.pop()
      result.rowCount = result.rows.length
      result.truncated = true
    }
    if (Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8') > 32_768) throw new Error('SERVER_OPS_SQL_RESULT_TOO_LARGE')
  }
  options.check()
  return result
}

/** 写执行的审计摘要：只带目标身份与库，不含 SQL 正文、表名或语句内容。 */
interface WriteAuditSummary { sourceId: string; database: string }
/** 写执行的审计选项；用户窗口与运维读写模式的 Agent 共用同一审计链。 */
interface WriteAuditOptions<T extends ServerOpsDataWriteResult> {
  summary: WriteAuditSummary
  actor: { actor: 'user'; windowId: number } | { actor: 'agent'; sessionId: string }
  audit: { append(input: ServerOpsAuditAppendInput): ServerOpsAuditRecord; prepareForWrites?: () => Promise<void> }
  check: () => void
  execute: () => Promise<T>
}

/**
 * 写执行的审计顺序：开始记录写失败必须 fail closed，结果记录写失败只降级成公开警告。
 *
 * 与只读查询共用同一套失败分类与「不暴露原始异常」的纪律，但 operation/resourceType 是
 * `data-write`，且**不带 queryHash 与 tables**——写链的审计不保存语句正文或指纹之外的语义。
 *
 * @param options 摘要、来源、审计边界与执行闭包
 * @returns 执行结果；结果审计失败时附带公开警告
 */
export async function runAuditedServerOpsDataWrite<T extends ServerOpsDataWriteResult>(options: WriteAuditOptions<T>): Promise<T> {
  options.check()
  try { await options.audit.prepareForWrites?.() } catch (error) { throw new Error(getAuditStartErrorCode(error)) }
  options.check()
  /** 开始与结果共享同一个 operationId，供审计页关联同一次写入。 */
  const common = {
    ...options.actor, ...options.summary,
    operation: 'data-write' as const, resourceType: 'data-write' as const, operationId: randomUUID(),
  }
  /** 墙钟只用于有界耗时，不接收调用方提交的时间。 */
  const startedAt = Date.now()
  try { options.audit.append({ ...common, phase: 'start', outcome: 'pending' }) } catch (error) { throw new Error(getAuditStartErrorCode(error)) }
  let result: T
  try {
    options.check()
    result = await options.execute()
  } catch (error) {
    /** 写的执行事实优先，执行后的取消或权限变化不能覆盖原始结果。 */
    const runtimeCode = error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
    const candidateCode = typeof runtimeCode === 'string' ? runtimeCode : error instanceof Error ? error.message : ''
    /** 只返回有界的大写领域码，不透传任何驱动正文。 */
    const errorCode = candidateCode.length <= 128 && /^SERVER_OPS_[A-Z_]+$/.test(candidateCode) ? candidateCode : 'SERVER_OPS_DATA_WRITE_FAILED'
    /** 没有结构化回执就没有提交/回滚事实，审计必须保守标记为未知。 */
    try { options.audit.append({ ...common, phase: 'result', outcome: 'unknown', errorCode, durationMs: Math.min(86_400_000, Math.max(0, Date.now() - startedAt)) }) } catch { /* 已发生的事实不因审计失败改写。 */ }
    throw new Error(errorCode)
  }
  try {
    /** 审计状态必须保留事务事实：部分生效或无法确认不能降格成普通失败。 */
    const writeOutcome = getServerOpsDataWriteOutcome(result)
    const auditOutcome = writeOutcome === 'committed'
      ? 'success'
      : writeOutcome === 'partial' || writeOutcome === 'unknown' ? 'unknown' : 'error'
    options.audit.append({ ...common, phase: 'result', outcome: auditOutcome,
      ...(writeOutcome === 'committed' ? {} : { errorCode: result.errorCode ?? 'SERVER_OPS_DATA_WRITE_OUTCOME_UNKNOWN' }),
      durationMs: Math.min(86_400_000, Math.max(0, Date.now() - startedAt)) })
  } catch {
    /** 写已经发生：结果审计失败只能降级成公开警告，不能伪装成写入失败。 */
    result = structuredClone(result)
    result.warnings = [...result.warnings.slice(0, 7), 'SERVER_OPS_AUDIT_RESULT_WRITE_FAILED']
  }
  return result
}
