import { isServerOpsId } from './server-ops'
import { parseServerOpsDataSource } from './server-ops-data'
import type { ServerOpsDataSource } from './server-ops-data'

/**
 * 数据库手工写入合同。
 *
 * 这是运维面板与获批 Agent 共用的写库通道：只读查询链的三层保证
 * （解析只认单条 SELECT、引擎会话只读、Agent 合同禁止）在写链上一律不适用，
 * 因此写链自带独立的分句、拒绝规则、事务语义与审计。
 *
 * Renderer IPC 仍只接受用户窗口；普通用户会话中的 Agent 通过主进程 Facade 复用同一执行合同，
 * 每次写入先经过 Agent 原生单次确认；运维读写会话同样沿用该确认，不直接获得该 IPC 通道。
 * `ops_database_query` 的只读合同也不因本文件改变。
 */
export const SERVER_OPS_DATA_WRITE_CHANNELS = {
  /** 执行一次写脚本；用户窗口或明确选择运维读写模式的 Agent 才能触发。 */
  EXECUTE: 'server-ops:data-write',
  /** 取消在途写入。 */
  CANCEL: 'server-ops:data-write-cancel',
} as const

/** 单次写脚本允许的最大语句条数；与切分器共用同一上限。 */
export const SERVER_OPS_DATA_WRITE_STATEMENT_LIMIT = 200
/**
 * 写脚本正文（UTF-8）上限。
 *
 * 取 16 KiB 而不是更大的值：本地 SQLite 的执行子进程 stdin envelope 上限是 64 KiB
 * （见 `server-ops-local-sqlite-runtime.ts` 的 `MAX_CHILD_REQUEST_BYTES`），
 * 还要容纳语句元数据；16 KiB 对人工编写的迁移脚本足够，且避免各引擎预算不一致。
 */
export const SERVER_OPS_DATA_WRITE_SQL_MAX_BYTES = 16_384
/** 整脚本默认时限。 */
export const SERVER_OPS_DATA_WRITE_DEFAULT_TIMEOUT_MS = 60_000
/** 整脚本允许的最大时限。 */
export const SERVER_OPS_DATA_WRITE_MAX_TIMEOUT_MS = 300_000

/** 一次写执行的输入。 */
export interface ServerOpsDataWriteInput {
  sourceId: string
  /** 用户确认时看到的完整公开快照；主进程以此拒绝跨窗口修改后的旧确认。 */
  source: ServerOpsDataSource
  database: string
  /** 由渲染层生成的调用身份，用于运行中取消。 */
  writeId: string
  sql: string
  timeoutMs?: number
}

/** 单条语句的执行结果；只保留首关键字与受影响行数，不回传结果集。 */
export interface ServerOpsDataWriteStatementResult {
  /** 语句首关键字（大写），供界面与审计显示。 */
  head: string
  /** DML 受影响行数；DDL 与查询类语句为 0。 */
  affectedRows: number
}

/** 一次写执行的公开结果。 */
export interface ServerOpsDataWriteResult {
  writeId: string
  database: string
  statementCount: number
  affectedRows: number
  /**
   * 是否已经提交。
   *
   * 失败回滚、以及 MySQL 中 DDL 隐式提交导致「部分已生效」都在这里如实反映，
   * 不承诺 DDL 可回滚。
   */
  committed: boolean
  /** 实际事务终态；兼容旧成功回执，缺省的 false 只能解释为未知。 */
  outcome?: ServerOpsDataWriteOutcome
  /** 失败原因只传稳定分类，不携带驱动正文或 SQL。 */
  errorCode?: string
  durationMs: number
  statements: ServerOpsDataWriteStatementResult[]
  warnings: string[]
}

/** 事务事实与“是否请求了取消”分开建模，取消不等于回滚。 */
export type ServerOpsDataWriteOutcome = 'committed' | 'rolled-back' | 'partial' | 'unknown' | 'not-started'

/** 从新旧回执读取实际终态；旧回执没有证据时不能宣称已回滚。 */
export function getServerOpsDataWriteOutcome(result: ServerOpsDataWriteResult): ServerOpsDataWriteOutcome {
  return result.outcome ?? (result.committed ? 'committed' : 'unknown')
}

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝公开 DTO 中的未知字段。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key))
}

/** 校验有界文本；允许换行，拒绝 NUL 与其它控制字符。 */
function isBoundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
}

/** 校验数据库名；边界与只读查询合同保持一致。 */
function isDatabaseName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 校验写语句正文：非空白、字节数有界、无 NUL。 */
function isWriteSql(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\u0000')
    && new TextEncoder().encode(value).byteLength <= SERVER_OPS_DATA_WRITE_SQL_MAX_BYTES
}

/** 判断未知值是否为非负安全整数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 严格解析写执行输入。 */
export function parseServerOpsDataWriteInput(value: unknown): ServerOpsDataWriteInput {
  const errorCode = 'SERVER_OPS_DATA_WRITE_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sourceId', 'source', 'database', 'writeId', 'sql', 'timeoutMs']))
    || !isServerOpsId(value.sourceId) || !isDatabaseName(value.database) || !isServerOpsId(value.writeId)
    || !isWriteSql(value.sql)
    || (value.timeoutMs !== undefined
      && (typeof value.timeoutMs !== 'number' || !Number.isSafeInteger(value.timeoutMs)
        || value.timeoutMs < 1_000 || value.timeoutMs > SERVER_OPS_DATA_WRITE_MAX_TIMEOUT_MS))) {
    throw new Error(errorCode)
  }
  /** 快照必须先通过数据源公开合同，再与顶层稳定 ID 精确绑定。 */
  let source: ServerOpsDataSource
  try {
    source = parseServerOpsDataSource(value.source)
  } catch {
    throw new Error(errorCode)
  }
  if (source.id !== value.sourceId) throw new Error(errorCode)
  return {
    sourceId: value.sourceId, source, database: value.database, writeId: value.writeId, sql: value.sql,
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
  }
}

/** 取消在途写入；身份由数据源与写入 ID 共同确定。 */
export interface ServerOpsDataWriteCancelInput {
  sourceId: string
  writeId: string
}

/** 严格解析取消输入。 */
export function parseServerOpsDataWriteCancelInput(value: unknown): ServerOpsDataWriteCancelInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sourceId', 'writeId']))
    || !isServerOpsId(value.sourceId) || !isServerOpsId(value.writeId)) {
    throw new Error('SERVER_OPS_DATA_WRITE_CANCEL_INPUT_INVALID')
  }
  return { sourceId: value.sourceId, writeId: value.writeId }
}

/** 严格解析单条语句结果。 */
export function parseServerOpsDataWriteStatementResult(value: unknown): ServerOpsDataWriteStatementResult {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['head', 'affectedRows']))
    || typeof value.head !== 'string' || value.head.length < 1 || value.head.length > 32 || !/^[A-Z_]+$/u.test(value.head)
    || !isNonNegativeInteger(value.affectedRows)) {
    throw new Error('SERVER_OPS_DATA_WRITE_RESULT_INVALID')
  }
  return { head: value.head, affectedRows: value.affectedRows }
}

/** 严格解析写执行结果。 */
export function parseServerOpsDataWriteResult(value: unknown): ServerOpsDataWriteResult {
  const errorCode = 'SERVER_OPS_DATA_WRITE_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set([
    'writeId', 'database', 'statementCount', 'affectedRows', 'committed', 'outcome', 'errorCode', 'durationMs', 'statements', 'warnings',
  ]))
    || !isServerOpsId(value.writeId) || !isDatabaseName(value.database)
    || !isNonNegativeInteger(value.statementCount)
    || value.statementCount > SERVER_OPS_DATA_WRITE_STATEMENT_LIMIT
    || !isNonNegativeInteger(value.affectedRows)
    || typeof value.committed !== 'boolean'
    || (value.outcome !== undefined && (typeof value.outcome !== 'string' || !['committed', 'rolled-back', 'partial', 'unknown', 'not-started'].includes(value.outcome)
      || value.committed !== (value.outcome === 'committed')))
    || (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || value.errorCode.length > 128 || !/^SERVER_OPS_[A-Z_]+$/u.test(value.errorCode)))
    || !isNonNegativeInteger(value.durationMs)
    || !Array.isArray(value.statements) || value.statements.length !== value.statementCount
    || !Array.isArray(value.warnings) || value.warnings.length > 8
    || value.warnings.some((warning) => !isBoundedText(warning, 200))) {
    throw new Error(errorCode)
  }
  return {
    writeId: value.writeId, database: value.database, statementCount: value.statementCount,
    affectedRows: value.affectedRows, committed: value.committed, durationMs: value.durationMs,
    ...(value.outcome === undefined ? {} : { outcome: value.outcome as ServerOpsDataWriteOutcome }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode as string }),
    statements: value.statements.map(parseServerOpsDataWriteStatementResult),
    warnings: value.warnings.map((warning) => warning as string),
  }
}
