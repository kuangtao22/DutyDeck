import type { ServerOpsDataWriteStatementResult } from '@proma/shared'
import type { ServerOpsPostgresqlClient } from './server-ops-postgresql-adapter'
import type { ServerOpsWriteScriptOutcome, ServerOpsWriteStatement } from './server-ops-write-runtime'

/** 让 PostgreSQL 驱动调用与取消信号竞速，避免连接销毁后 Promise 永久悬挂。 */
function awaitWriteOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(new Error('SERVER_OPS_DATA_WRITE_CANCELLED'))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown, value?: T): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve(value as T)
    }
    const onAbort = (): void => { finish(new Error('SERVER_OPS_DATA_WRITE_CANCELLED')) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then((value) => { finish(undefined, value) }, (error: unknown) => { finish(error) })
  })
}

/** 从 pg.Client 返回值读取 rowCount；DDL、无影响 DML 统一按 0 计数。 */
function readAffectedRows(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null) return 0
  const rowCount = (raw as { rowCount?: unknown }).rowCount
  return typeof rowCount === 'number' && Number.isSafeInteger(rowCount) && rowCount > 0 ? rowCount : 0
}

/** 仅把可公开的 PostgreSQL 错误类别映射为稳定写回执码。 */
function getPostgresqlWriteErrorCode(error: unknown, cancelled: boolean): string {
  if (cancelled) return 'SERVER_OPS_DATA_WRITE_CANCELLED'
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code : undefined
  if (code === '42501') return 'SERVER_OPS_DATA_WRITE_PERMISSION_DENIED'
  if (code === '57014' || code === '55P03') return 'SERVER_OPS_DATA_WRITE_TIMEOUT'
  return 'SERVER_OPS_DATA_WRITE_FAILED'
}

/** 尽力回滚；回滚结果不改变未知状态的保守分类。 */
function requestRollbackWithoutWaiting(client: ServerOpsPostgresqlClient): void {
  try { void client.query('ROLLBACK').catch(() => undefined) } catch { /* 连接已断开时保持未知。 */ }
}

/** 正常语句失败时等待回滚结束，避免结果返回后仍占用 PostgreSQL 事务。 */
async function safeRollback(client: ServerOpsPostgresqlClient): Promise<void> {
  try { await client.query('ROLLBACK') } catch { /* 回滚失败仍按未知结果返回。 */ }
}

/**
 * 在单个 PostgreSQL 事务中顺序执行已规划的写语句。
 *
 * PostgreSQL 的 DDL 通常也参与事务，因此无需 MySQL 的隐式提交特殊分支；提交确认丢失时仍返回 unknown。
 *
 * @param client 已建立且未启用只读会话的 PostgreSQL 客户端
 * @param statements 共享 SQL 规划器输出的语句计划
 * @param signal 取消信号
 * @returns 统一写回执
 */
export async function runServerOpsPostgresqlWriteScript(
  client: ServerOpsPostgresqlClient,
  statements: readonly ServerOpsWriteStatement[],
  signal?: AbortSignal,
): Promise<ServerOpsWriteScriptOutcome> {
  const results: ServerOpsDataWriteStatementResult[] = []
  let affectedRows = 0
  if (signal?.aborted) {
    return { statementCount: 0, affectedRows: 0, committed: false, outcome: 'not-started', errorCode: 'SERVER_OPS_DATA_WRITE_CANCELLED', statements: [], warnings: [] }
  }
  try {
    await awaitWriteOperation(client.query('BEGIN'), signal)
  } catch (error) {
    return { statementCount: 0, affectedRows: 0, committed: false, outcome: 'not-started', errorCode: getPostgresqlWriteErrorCode(error, signal?.aborted === true), statements: [], warnings: [] }
  }
  for (const statement of statements) {
    if (signal?.aborted) {
      requestRollbackWithoutWaiting(client)
      return { statementCount: results.length, affectedRows, committed: false, outcome: results.length === 0 ? 'not-started' : 'unknown', errorCode: 'SERVER_OPS_DATA_WRITE_CANCELLED', statements: results, warnings: ['写入已请求取消，数据库状态需要重新核对'] }
    }
    try {
      const result = await awaitWriteOperation(client.query(statement.text), signal)
      const statementAffectedRows = readAffectedRows(result)
      results.push({ head: statement.head, affectedRows: statementAffectedRows })
      affectedRows += statementAffectedRows
    } catch (error) {
      if (signal?.aborted) requestRollbackWithoutWaiting(client)
      else await safeRollback(client)
      return {
        statementCount: results.length,
        affectedRows,
        committed: false,
        outcome: results.length === 0 ? 'unknown' : 'unknown',
        errorCode: getPostgresqlWriteErrorCode(error, signal?.aborted === true),
        statements: results,
        warnings: ['事务未能完成，数据库状态需要重新核对'],
      }
    }
  }
  if (signal?.aborted) {
    requestRollbackWithoutWaiting(client)
    return { statementCount: results.length, affectedRows, committed: false, outcome: 'unknown', errorCode: 'SERVER_OPS_DATA_WRITE_CANCELLED', statements: results, warnings: ['写入已请求取消，数据库状态需要重新核对'] }
  }
  try {
    await awaitWriteOperation(client.query('COMMIT'), signal)
  } catch (error) {
    return {
      statementCount: results.length,
      affectedRows,
      committed: false,
      outcome: 'unknown',
      errorCode: getPostgresqlWriteErrorCode(error, signal?.aborted === true) === 'SERVER_OPS_DATA_WRITE_FAILED'
        ? 'SERVER_OPS_DATA_WRITE_COMMIT_FAILED' : getPostgresqlWriteErrorCode(error, signal?.aborted === true),
      statements: results,
      warnings: ['提交确认失败，数据库状态需要重新核对'],
    }
  }
  return { statementCount: results.length, affectedRows, committed: true, outcome: 'committed', statements: results, warnings: [] }
}
