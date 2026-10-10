import type { Duplex } from 'node:stream'
import { createConnection as createMysqlConnection } from 'mysql2'
import type { ServerOpsDataWriteResult } from '@proma/shared'
import type { ServerOpsRuntimeDataWriteRequest } from './server-ops-runtime-protocol'
import { openServerOpsMySqlConnection } from './server-ops-mysql-connection'
import { runServerOpsMySqlWriteScript } from './server-ops-write-runtime'
import { runServerOpsLocalSqliteWrite } from './server-ops-local-sqlite-runtime'
import { getServerOpsSqlQueryPublicError } from './server-ops-query-runtime'
import { getServerOpsSqlitePublicError } from './server-ops-sqlite-runtime'

/**
 * 写执行的可测核心。
 *
 * 从 runtime 的消息循环里抽出来，只保留「分引擎执行 + 错误归一化」这两件需要被验证的事：
 * runtime 入口有顶层副作用、无法被测试导入，把逻辑留在那里等于永久不可测。
 * 登记表、超时与取消的生命周期仍由 runtime 负责，因为它们属于消息循环而不是执行语义。
 */

/** 写链自己的稳定码白名单；只接受本模块执行器产出的码，不按前缀接受驱动正文。 */
export const SERVER_OPS_DATA_WRITE_PUBLIC_CODES: ReadonlySet<string> = new Set([
  'SERVER_OPS_DATA_WRITE_FAILED',
  'SERVER_OPS_DATA_WRITE_COMMIT_FAILED',
  'SERVER_OPS_DATA_WRITE_CANCELLED',
  'SERVER_OPS_DATA_WRITE_TIMEOUT',
  'SERVER_OPS_DATA_WRITE_PERMISSION_DENIED',
  'SERVER_OPS_DATA_WRITE_INPUT_INVALID',
  'SERVER_OPS_SQLITE_FILE_NOT_FOUND',
  'SERVER_OPS_SQLITE_FILE_NOT_REGULAR',
  'SERVER_OPS_SQLITE_FILE_PERMISSION_DENIED',
  'SERVER_OPS_SQLITE_FILE_UNAVAILABLE',
  'SERVER_OPS_SQLITE_DATABASE_INVALID',
  'SERVER_OPS_SQLITE_DATABASE_LOCKED',
  'SERVER_OPS_SQLITE_PYTHON_MISSING',
  'SERVER_OPS_SQLITE_PYTHON_VERSION_UNSUPPORTED',
  'SERVER_OPS_SQLITE_MODULE_UNAVAILABLE',
])

/** 写执行的稳定错误：调用方只按 code 分类，绝不透传驱动正文。 */
export class ServerOpsDataWriteError extends Error {
  /** 稳定机器码。 */
  readonly code: string
  /** 固定中文说明。 */
  readonly publicMessage: string

  /**
   * 创建公开写错误。
   *
   * @param code 稳定码
   * @param publicMessage 面向用户的中文说明
   */
  constructor(code: string, publicMessage: string) {
    super(code)
    this.name = 'ServerOpsDataWriteError'
    this.code = code
    this.publicMessage = publicMessage
  }
}

/** 写核心的可替换依赖；测试注入假件即可覆盖三条路径。 */
export interface ServerOpsDataWriteDependencies {
  /** 建立直连通道。 */
  createDirectChannel: (address: string, port: number) => Duplex
  /** 建立并校验 MySQL 连接。 */
  openMySqlConnection: typeof openServerOpsMySqlConnection
  /** 执行 MySQL 写脚本。 */
  runMySqlWrite: typeof runServerOpsMySqlWriteScript
  /** 执行本地 SQLite 写脚本。 */
  runLocalSqliteWrite: typeof runServerOpsLocalSqliteWrite
  /** 执行已认证 SSH 主机上的远程 SQLite 写脚本。 */
  runRemoteSqliteWrite?: (input: ServerOpsRuntimeDataWriteRequest, signal: AbortSignal) => Promise<ServerOpsDataWriteResult>
  /** 时间源。 */
  now: () => number
}

/** 真实依赖；生产只在这里组装一次。 */
export function createServerOpsDataWriteDependencies(
  createDirectChannel: (address: string, port: number) => Duplex,
  options: Pick<ServerOpsDataWriteDependencies, 'runRemoteSqliteWrite'> = {},
): ServerOpsDataWriteDependencies {
  return {
    createDirectChannel,
    openMySqlConnection: openServerOpsMySqlConnection,
    runMySqlWrite: runServerOpsMySqlWriteScript,
    runLocalSqliteWrite: runServerOpsLocalSqliteWrite,
    ...options,
    now: Date.now,
  }
}

/** 把任意异常归一化成公开写错误；未知原因一律失败关闭。 */
export function normalizeServerOpsDataWriteError(error: unknown, connected: boolean): ServerOpsDataWriteError {
  const publicError = getServerOpsSqlQueryPublicError(error) ?? getServerOpsSqlitePublicError(error)
  const rawCode = error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
  const message = error instanceof Error ? error.message : ''
  const candidate = publicError?.code
    ?? (typeof rawCode === 'string' && SERVER_OPS_DATA_WRITE_PUBLIC_CODES.has(rawCode) ? rawCode : undefined)
    ?? (SERVER_OPS_DATA_WRITE_PUBLIC_CODES.has(message) ? message : undefined)
  if (candidate !== undefined) {
    return new ServerOpsDataWriteError(candidate, publicError?.message ?? '数据库写入失败')
  }
  /**
   * 还没连上就失败时不能报「写入失败、事务已回滚」——那会让人以为语句已经执行过。
   */
  return connected
    ? new ServerOpsDataWriteError('SERVER_OPS_DATA_WRITE_FAILED', '数据库写入失败')
    : new ServerOpsDataWriteError('SERVER_OPS_DATA_CHANNEL_FAILED', '无法建立到数据库的通道')
}

/** 单次写执行需要的运行时上下文。 */
export interface ServerOpsDataWriteContext {
  signal: AbortSignal
  /** 建立直连通道后立刻交给 runtime 登记，便于取消时销毁。 */
  onChannelOpened: (channel: Duplex) => void
  /** 连接就绪后交给 runtime 登记，便于取消时销毁。 */
  onConnectionOpened: (connection: { destroy: () => void }) => void
}

/**
 * 执行一次写库脚本并返回公开结果。
 *
 * @param input 已通过协议解析的写请求
 * @param context 取消信号与资源登记回调
 * @param dependencies 引擎执行器与时间源
 * @returns 写执行结果
 * @throws ServerOpsDataWriteError 归一化后的稳定失败
 */
export async function executeServerOpsDataWrite(
  input: ServerOpsRuntimeDataWriteRequest,
  context: ServerOpsDataWriteContext,
  dependencies: ServerOpsDataWriteDependencies,
): Promise<ServerOpsDataWriteResult> {
  /** 经跳板的写需要另一套通道所有权与终止语义，在没做对之前显式拒绝。 */
  if (input.transport === 'ssh') {
    if (input.engine !== 'sqlite' || dependencies.runRemoteSqliteWrite === undefined) {
      throw new ServerOpsDataWriteError('SERVER_OPS_DATA_WRITE_SSH_UNSUPPORTED', '仅支持通过已连接 SSH 主机写入 SQLite 文件，MySQL 请配置直连')
    }
    return dependencies.runRemoteSqliteWrite(input, context.signal)
  }
  if (input.transport !== 'direct') {
    throw new ServerOpsDataWriteError('SERVER_OPS_DATA_WRITE_SSH_UNSUPPORTED', '数据库连接方式不支持写入')
  }
  const startedAt = dependencies.now()
  if (input.engine === 'sqlite') {
    try {
      return await dependencies.runLocalSqliteWrite({
        filePath: input.filePath ?? '', localFileId: input.localFileId ?? '', writeId: input.writeId,
        database: input.database, statements: input.statements, timeoutMs: input.timeoutMs,
      }, context.signal)
    } catch (error) {
      throw normalizeServerOpsDataWriteError(error, false)
    }
  }
  /** 是否已经建立驱动连接；决定失败时是「连不上」还是「写入失败」。 */
  let connected = false
  try {
    const opened = await dependencies.openMySqlConnection({
      address: input.address, port: input.port, username: input.username, password: input.password,
      database: input.database, tlsMode: input.tlsMode, tlsServerName: input.tlsServerName,
    }, {
      /** 直连通道：写链不建立 SSH 转发。 */
      createChannel: async () => {
        if (typeof input.address !== 'string' || typeof input.port !== 'number') throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
        const socket = dependencies.createDirectChannel(input.address, input.port)
        context.onChannelOpened(socket)
        await new Promise<void>((resolve, reject) => {
          /** 单次建链只允许结算一次。 */
          let settled = false
          const fail = (error: Error): void => { if (settled) return; settled = true; reject(error) }
          socket.once('error', fail)
          socket.once('close', () => fail(new Error('SERVER_OPS_DATA_CHANNEL_CLOSED')))
          socket.once('connect', () => {
            if (context.signal.aborted) {
              socket.destroy()
              fail(new Error('SERVER_OPS_DATA_CANCELLED'))
              return
            }
            settled = true
            resolve()
          })
        })
        return socket
      },
      createConnection: createMysqlConnection,
      timeoutMs: input.timeoutMs,
      signal: context.signal,
    })
    connected = true
    context.onConnectionOpened(opened.connection)
    /**
     * 与只读链一致，用 `connection.promise()` 拿到 Promise 形态的 API：
     * mysql2 原始 Connection 的事务方法带回调重载，直接用会让类型与运行时语义脱节。
     */
    const outcome = await dependencies.runMySqlWrite(opened.connection.promise(), input.statements, context.signal)
    return {
      writeId: input.writeId, database: input.database, ...outcome,
      durationMs: Math.max(0, dependencies.now() - startedAt),
    }
  } catch (error) {
    throw normalizeServerOpsDataWriteError(error, connected)
  }
}
