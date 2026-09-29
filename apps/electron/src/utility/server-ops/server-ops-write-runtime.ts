import type { ServerOpsDataWriteOutcome, ServerOpsDataWriteStatementResult } from '@proma/shared'

/**
 * 执行器实际消费的语句形状。
 *
 * 只需要正文与大写首关键字：`mutating` 等判定字段属于共享层计划，执行器不重复消费，
 * 因此协议跨进程传输时只带这两个字段即可。
 */
export interface ServerOpsWriteStatement {
  text: string
  head: string
}

/**
 * 手工写库的引擎执行器。
 *
 * **与只读链完全不同的一条路**：写连接绝不携带只读会话设置，也不复用只读连接。
 * 只读链的三层保证（解析只认单条 SELECT、引擎会话只读、Agent 合同禁止）在这里都不适用，
 * 因此本文件承担全部写侧语义：事务边界、隐式提交的如实标注、受影响行数归一化。
 *
 * 语句切分、会话控制语句拒绝与「必须含写语句」由共享层的 `planServerOpsSqlWrite` 负责，
 * 本文件只消费已经判定过的语句，不重复解析 SQL 文本。
 */

/** 一次写执行的引擎无关结果。 */
export interface ServerOpsWriteScriptOutcome {
  statementCount: number
  affectedRows: number
  committed: boolean
  outcome: ServerOpsDataWriteOutcome
  errorCode?: string
  statements: ServerOpsDataWriteStatementResult[]
  warnings: string[]
}

/** MySQL 写执行需要的最小连接能力；mysql2 的 Connection 天然满足。 */
export interface ServerOpsWriteMySqlConnection {
  /** Promise 形态 mysql2 连接执行单条语句。 */
  query: (sql: string) => Promise<unknown>
  beginTransaction: () => Promise<void>
  commit: () => Promise<void>
  rollback: () => Promise<void>
}

/**
 * MySQL 中会隐式提交事务的语句首关键字。
 *
 * 命中过这些语句之后再失败，前面的改动已经落库，**不能**对外声称「已回滚」；
 * 这正是「MySQL DDL 不承诺回滚」在代码里的落点。
 */
const MYSQL_IMPLICIT_COMMIT_HEADS: ReadonlySet<string> = new Set([
  'ALTER', 'CREATE', 'DROP', 'RENAME', 'TRUNCATE', 'GRANT', 'REVOKE', 'LOCK', 'UNLOCK',
])

/** 从 mysql2 返回值里取受影响行数；非 DML 或异常形状一律按 0 处理。 */
function readAffectedRows(raw: unknown): number {
  /** mysql2 对多结果集返回数组，逐个累加有界整数。 */
  const entries = Array.isArray(raw) ? raw : [raw]
  let total = 0
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const affected = (entry as { affectedRows?: unknown }).affectedRows
    if (typeof affected === 'number' && Number.isSafeInteger(affected) && affected > 0) total += affected
  }
  return total
}

/** 构造不携带 SQL 与驱动正文的结构化失败结果。 */
function createFailedOutcome(
  results: readonly ServerOpsDataWriteStatementResult[],
  affectedRows: number,
  outcome: Exclude<ServerOpsDataWriteOutcome, 'committed'>,
  errorCode: string,
  warnings: readonly string[] = [],
): ServerOpsWriteScriptOutcome {
  return {
    statementCount: results.length,
    affectedRows,
    committed: false,
    outcome,
    errorCode,
    statements: [...results],
    warnings: [...warnings],
  }
}

/**
 * 让驱动 Promise 与取消信号独立竞速。
 * mysql2 在 socket 被销毁后不保证当前 Promise 一定结算，不能让写生命周期永久悬挂。
 */
function awaitWriteOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(new Error('SERVER_OPS_DATA_WRITE_CANCELLED'))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error: unknown, value?: T): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve(value as T)
    }
    const onAbort = (): void => { finish(new Error('SERVER_OPS_DATA_WRITE_CANCELLED')) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => { finish(undefined, value) },
      (error: unknown) => { finish(error) },
    )
  })
}

/**
 * 在一个事务里顺序执行写语句。
 *
 * 全部成功才提交；中途失败时回滚，除非此前已经有语句隐式提交过——那种情况下
 * 只能如实报告「部分已生效」，并附带公开警告，绝不假装回滚成功。
 *
 * @param connection 已建立且**未设置只读会话**的 MySQL 连接
 * @param statements 已通过共享层判定的语句计划
 * @param signal 取消信号；与每次驱动调用竞速，避免连接销毁后 Promise 永久不结算
 * @returns 语句条数、累计受影响行数与真实提交状态
 */
export async function runServerOpsMySqlWriteScript(
  connection: ServerOpsWriteMySqlConnection,
  statements: readonly ServerOpsWriteStatement[],
  signal?: AbortSignal,
): Promise<ServerOpsWriteScriptOutcome> {
  const results: ServerOpsDataWriteStatementResult[] = []
  const warnings: string[] = []
  /** 是否出现过隐式提交；一旦为真，回滚不再代表整体未生效。 */
  let implicitCommitted = false
  let affectedTotal = 0
  if (signal?.aborted) return createFailedOutcome(results, affectedTotal, 'not-started', 'SERVER_OPS_DATA_WRITE_CANCELLED')

  try {
    await awaitWriteOperation(connection.beginTransaction(), signal)
  } catch {
    /** 开启事务失败也要归一化：驱动原文里可能带连接串与库名。 */
    return createFailedOutcome(
      results,
      affectedTotal,
      'not-started',
      signal?.aborted ? 'SERVER_OPS_DATA_WRITE_CANCELLED' : 'SERVER_OPS_DATA_WRITE_FAILED',
    )
  }
  for (const statement of statements) {
    if (signal?.aborted) {
      requestRollbackWithoutWaiting(connection, implicitCommitted)
      return createFailedOutcome(
        results,
        affectedTotal,
        results.length === 0 ? 'not-started' : implicitCommitted ? 'partial' : 'unknown',
        'SERVER_OPS_DATA_WRITE_CANCELLED',
      )
    }
    /** DDL 在真正执行前就会提交当前事务；即使 DDL 自身报错，也不能再声称整体已回滚。 */
    if (MYSQL_IMPLICIT_COMMIT_HEADS.has(statement.head)) implicitCommitted = true
    try {
      const affectedRows = readAffectedRows(await awaitWriteOperation(connection.query(statement.text), signal))
      results.push({ head: statement.head, affectedRows })
      affectedTotal += affectedRows
    } catch {
      if (signal?.aborted) requestRollbackWithoutWaiting(connection, implicitCommitted)
      else await safeRollback(connection, implicitCommitted, signal)
      return createFailedOutcome(
        results,
        affectedTotal,
        implicitCommitted && results.length > 0 ? 'partial' : 'unknown',
        signal?.aborted ? 'SERVER_OPS_DATA_WRITE_CANCELLED' : 'SERVER_OPS_DATA_WRITE_FAILED',
        implicitCommitted ? ['脚本已跨过 MySQL 隐式提交边界，部分改动可能已经生效'] : [],
      )
    }
  }
  if (signal?.aborted) {
    requestRollbackWithoutWaiting(connection, implicitCommitted)
    return createFailedOutcome(
      results,
      affectedTotal,
      implicitCommitted ? 'partial' : 'unknown',
      'SERVER_OPS_DATA_WRITE_CANCELLED',
    )
  }
  try {
    await awaitWriteOperation(connection.commit(), signal)
  } catch {
    /** COMMIT 已发送但确认丢失时，补发 ROLLBACK 不能证明提交没有发生。 */
    return createFailedOutcome(
      results,
      affectedTotal,
      implicitCommitted ? 'partial' : 'unknown',
      signal?.aborted ? 'SERVER_OPS_DATA_WRITE_CANCELLED' : 'SERVER_OPS_DATA_WRITE_COMMIT_FAILED',
    )
  }
  if (implicitCommitted) warnings.push('脚本包含会隐式提交的语句，MySQL 下这些改动无法回滚')
  return {
    statementCount: results.length,
    affectedRows: affectedTotal,
    committed: true,
    outcome: 'committed',
    statements: results,
    warnings,
  }
}

/**
 * 尽力回滚当前事务；调用方仍按 MySQL 的保守规则把失败结果标成 unknown。
 *
 * 回滚自身失败或此前已有隐式提交时，不透传底层异常，也不改变原始失败分类。
 *
 * @param connection 目标连接
 * @param implicitCommitted 此前是否已有隐式提交
 */
async function safeRollback(
  connection: ServerOpsWriteMySqlConnection,
  implicitCommitted: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (implicitCommitted) return
  try {
    await awaitWriteOperation(connection.rollback(), signal)
  } catch {
    /** 回滚失败不能让上层拿到数据库原文；调用方已经拿到稳定失败码。 */
  }
}

/** 取消路径只发起尽力回滚，不等待可能永远不结算的驱动 Promise。 */
function requestRollbackWithoutWaiting(connection: ServerOpsWriteMySqlConnection, implicitCommitted: boolean): void {
  if (implicitCommitted) return
  try { void connection.rollback().catch(() => undefined) } catch { /* 连接已销毁时保持 unknown 结果。 */ }
}

/**
 * 把已提交过的写执行结果转成失败语义。
 *
 * 供上层在「事务提交后才发现结果无法核对」这类场景统一使用：此时改动已经生效，
 * 必须让调用方与用户看到「部分已生效」而不是「失败且无副作用」。
 *
 * @param outcome 已经执行完的结果
 * @param code 稳定错误码
 * @returns 带有实际影响范围说明的警告文本
 */
export function describeServerOpsWritePartialEffect(outcome: ServerOpsWriteScriptOutcome, code: string): string {
  return `${code}: 已执行 ${outcome.statementCount} 条语句、影响 ${outcome.affectedRows} 行，改动可能已生效`
}
