import type { Duplex } from 'node:stream'
import type { Connection, ConnectionOptions } from 'mysql2'
import type { ServerOpsDataTlsMode, ServerOpsDataTlsStatus } from '@proma/shared'

/**
 * MySQL 连接构造的**唯一实现**。
 *
 * 读写两条链共用同一个连接构造：区别只在会话设置（写链不设置只读），
 * 而 TLS 校验、`tlsServerName` 处理、`preferred` 回退与加密状态判定这些
 * 安全相关逻辑必须只有一份——复制成两份必然漂移，且漂移方向通常是某一条链悄悄放松了校验。
 */

/** 建立 MySQL 连接所需的公开连接参数；不含任何会话设置。 */
export interface ServerOpsMySqlConnectionParams {
  /** 目标地址；`verify` 模式下由 `tlsServerName` 取代。 */
  address?: string
  port?: number
  username?: string
  password?: string
  /** 握手默认库；省略表示不绑定库。 */
  database?: string
  tlsMode: ServerOpsDataTlsMode
  tlsServerName?: string
}

/** 连接构造的可替换依赖；测试注入假通道与假驱动即可覆盖 TLS 分支。 */
export interface ServerOpsMySqlConnectionDependencies {
  /** 建立底层通道：直连 socket 或经 SSH 的转发通道。 */
  createChannel: () => Promise<Duplex>
  /** 创建驱动连接；生产为 `mysql2.createConnection`。 */
  createConnection: (options: ConnectionOptions) => Connection
  /** 握手超时，与调用方整体时限保持一致。 */
  timeoutMs: number
  signal?: AbortSignal
}

/** 成功建立的连接与其真实加密状态。 */
export interface ServerOpsMySqlOpenConnection {
  connection: Connection
  /** 本次成功尝试持有的底层通道；调用方负责在结算时销毁。 */
  channel: Duplex
  /** 驱动升级 TLS 后的真实流；调用方据此报告加密状态。 */
  stream: Duplex & { encrypted?: boolean }
  tlsStatus: ServerOpsDataTlsStatus
}

/** 从驱动错误里读取稳定错误码。 */
function readErrorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

/**
 * 等待 MySQL 握手完成。
 *
 * **必须监听 `connect`**：mysql2 的 Connection 在握手完成时发出的是 `connect`，
 * 从不发出 `ready`。早期版本这里误用 `ready`，导致每次握手都等不到结果、
 * 一直挂到整体超时——对外表现就是「数据库连不上」。
 *
 * @param connection 已创建的驱动连接
 * @param signal 取消信号；取消时先结算再销毁，避免同步 close/error 改写取消原因
 */
export function waitForServerOpsMySqlConnection(connection: Connection, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    /** 移除握手阶段监听，后续查询由驱动自身的 promise 路径处理错误。 */
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      connection.removeListener('connect', onConnect)
      connection.removeListener('error', onError)
    }
    /** 握手成功。 */
    const onConnect = (): void => { cleanup(); resolve() }
    /** 握手失败保留原始驱动错误码，用于判定是否允许 preferred 回退。 */
    const onError = (error: Error): void => { cleanup(); reject(error) }
    /** 先结算再销毁，防止同步 close/error 竞争改变取消原因。 */
    const onAbort = (): void => { cleanup(); reject(new Error('SERVER_OPS_DATA_CANCELLED')); connection.destroy() }
    connection.once('connect', onConnect)
    connection.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/**
 * 建立一条 MySQL 连接，并返回真实 TLS 状态。
 *
 * `preferred` 模式在服务端明确不支持 TLS（`HANDSHAKE_NO_SSL_SUPPORT`）时允许**重试一次明文**；
 * 该错误只在 mysql2 检查服务端 capability 且尚未发送认证材料时产生，因此明文重试不会泄漏凭据。
 * 其它模式与其它错误一概不降级：`verify` 永远不允许回退。
 *
 * 失败的尝试由本函数负责销毁通道与连接，不把半开资源留给调用方。
 *
 * @param params 连接参数
 * @param dependencies 通道工厂、驱动工厂、超时与取消信号
 * @returns 已就绪的连接、真实流与加密状态
 */
export async function openServerOpsMySqlConnection(
  params: ServerOpsMySqlConnectionParams,
  dependencies: ServerOpsMySqlConnectionDependencies,
): Promise<ServerOpsMySqlOpenConnection> {
  /** 初次连接按配置请求 TLS；只有明确无 TLS 才能把下一次尝试设为明文。 */
  let useTls = params.tlsMode !== 'disabled'
  for (;;) {
    const channel = await dependencies.createChannel()
    if (dependencies.signal?.aborted) {
      channel.destroy()
      throw new Error('SERVER_OPS_DATA_CANCELLED')
    }
    /** verify 模式必须用真实主机名握手，否则证书校验没有意义。 */
    const connection = dependencies.createConnection({
      host: params.tlsMode === 'verify' ? params.tlsServerName : params.address,
      port: params.port,
      user: params.username,
      password: params.password,
      ...(params.database === undefined ? {} : { database: params.database }),
      stream: channel,
      connectTimeout: dependencies.timeoutMs,
      ...(useTls ? { ssl: { rejectUnauthorized: params.tlsMode === 'verify', verifyIdentity: params.tlsMode === 'verify' } } : {}),
    })
    /** 取消或销毁后迟到的驱动错误也必须被消费，不能使 utility 进程崩溃。 */
    connection.on('error', () => undefined)
    try {
      await waitForServerOpsMySqlConnection(connection, dependencies.signal)
    } catch (error) {
      connection.destroy()
      channel.destroy()
      if (dependencies.signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
      /** 只有 preferred 且服务端明确无 TLS 时才允许一次明文回退。 */
      if (params.tlsMode !== 'preferred' || !useTls || readErrorCode(error) !== 'HANDSHAKE_NO_SSL_SUPPORT') throw error
      useTls = false
      continue
    }
    /** mysql2 在升级 TLS 后把 stream 替换成 TLSSocket，以实际流识别加密状态。 */
    const stream = (connection as unknown as { stream: Duplex & { encrypted?: boolean } }).stream
    /** 声称要 TLS 却没有得到加密流，说明握手被绕过，必须拒绝。 */
    if (useTls && stream.encrypted !== true) {
      connection.destroy()
      throw Object.assign(new Error('TLS 未建立'), { code: 'HANDSHAKE_SSL_ERROR' })
    }
    /** verified 只在真实 TLS 流且驱动已完成证书与主机名验证后报告。 */
    const tlsStatus: ServerOpsDataTlsStatus = stream.encrypted === true
      ? params.tlsMode === 'verify' ? 'verified' : 'encrypted'
      : 'plaintext'
    return { connection, channel, stream, tlsStatus }
  }
}
