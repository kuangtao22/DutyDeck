import { Redis } from 'ioredis'
import type { Duplex } from 'node:stream'
import { isServerOpsRedisWriteCommand, parseServerOpsRedisCommandInput, SERVER_OPS_REDIS_MAX_RESULT_BYTES } from '@proma/shared'
import type { ServerOpsRedisCommandResult } from '@proma/shared'
import type { ServerOpsRuntimeRedisRequest } from './server-ops-runtime-protocol'
import { createRedisTunnelConnector } from './server-ops-data-runtime'

/** 命令执行前校验白名单；连接、取消及返回字节均有上限，写断线后不重发。 */
export async function runServerOpsRedisCommand(
  input: ServerOpsRuntimeRedisRequest,
  createChannel: (signal: AbortSignal) => Promise<Duplex>,
  signal?: AbortSignal,
): Promise<ServerOpsRedisCommandResult> {
  /** 命令、目标和时间分别固定，不能在异步建连中被调用者修改。 */
  const command = parseServerOpsRedisCommandInput({ sourceId: input.sourceId, command: input.command, args: input.args })
  const startedAt = Date.now()
  /** 内部时限也覆盖尚未完成的 TCP / SSH 建链。 */
  const lifetime = new AbortController()
  const write = isServerOpsRedisWriteCommand(command.command)
  let dispatched = false
  let finished = false
  let receivedBytes = 0
  let failureCode = 'SERVER_OPS_REDIS_COMMAND_FAILED'
  let stream: Duplex | undefined
  let rejectStopped: (error: Error) => void = () => undefined
  /** 无论驱动是否响应 close，取消和时限都能终止外部 await。 */
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject })
  /** 协议仅配置保存来源的 db；不注册自动重连/重发/离线排队。 */
  const redis = new Redis({
    Connector: createRedisTunnelConnector(async () => {
      if (finished || signal?.aborted || lifetime.signal.aborted) throw new Error('SERVER_OPS_REDIS_CANCELLED')
      const channel = await createChannel(lifetime.signal)
      if (finished || signal?.aborted || lifetime.signal.aborted) { channel.destroy(); throw new Error('SERVER_OPS_REDIS_CANCELLED') }
      stream = channel
      return channel
    }, input, (connectedStream) => {
      stream = connectedStream
      /** 在 ioredis RESP 解析前限制明文响应总量，超大 bulk 不会完整驻留内存。 */
      connectedStream.on('data', (chunk: Buffer | string) => {
        receivedBytes += Buffer.byteLength(chunk)
        if (receivedBytes > 65_536) stop('SERVER_OPS_REDIS_RESULT_TOO_LARGE')
      })
    }),
    ...(input.tlsMode !== 'disabled' ? { tls: {} } : {}),
    ...(input.username === undefined ? {} : { username: input.username }),
    ...(input.password === undefined ? {} : { password: input.password }),
    ...(input.database === undefined ? {} : { db: Number(input.database) }),
    connectTimeout: input.timeoutMs, commandTimeout: input.timeoutMs,
    enableOfflineQueue: false, enableReadyCheck: false, lazyConnect: true,
    /** SSH Duplex 没有 net.Socket 专属方法；底层 SSH/TCP 自行管理连接保活。 */
    noDelay: false,
    protocol: 2, disableClientInfo: true, retryStrategy: () => null,
    maxRetriesPerRequest: 0, autoResendUnfulfilledCommands: false,
  })
  /** 构造器会补默认 keepAlive，因此在 lazyConnect 前显式禁用 Socket 专属调用。 */
  redis.options.keepAlive = undefined
  /** 先记录稳定分类，再销毁资源；不得回传 Redis 原始错误正文。 */
  const stop = (code: string): void => {
    if (finished) return
    failureCode = code
    rejectStopped(new Error(code))
    lifetime.abort()
    redis.disconnect()
    stream?.destroy()
  }
  const onAbort = (): void => stop('SERVER_OPS_REDIS_CANCELLED')
  const timer = setTimeout(() => stop('SERVER_OPS_REDIS_TIMEOUT'), input.timeoutMs)
  signal?.addEventListener('abort', onAbort, { once: true })
  redis.on('error', () => undefined)
  try {
    if (signal?.aborted) onAbort()
    /** 使用独立 Promise，迟到的通道回调会由 finished 检查释放。 */
    const execution = async (): Promise<ServerOpsRedisCommandResult> => {
      if (signal?.aborted) throw new Error('SERVER_OPS_REDIS_CANCELLED')
      await redis.connect()
      if (finished || signal?.aborted || lifetime.signal.aborted) throw new Error('SERVER_OPS_REDIS_CANCELLED')
      dispatched = true
      const raw: unknown = await redis.call(command.command, ...command.args)
      if (raw !== null && typeof raw !== 'string' && (typeof raw !== 'number' || !Number.isFinite(raw))) {
        throw new Error('SERVER_OPS_REDIS_RESULT_INVALID')
      }
      /** TextDecoder 的 stream 模式丢弃末尾半个 UTF-8 字符，保证截断后字节不超限。 */
      const bytes = typeof raw === 'string' ? Buffer.from(raw) : undefined
      const truncated = bytes !== undefined && bytes.length > SERVER_OPS_REDIS_MAX_RESULT_BYTES
      const value = truncated && bytes !== undefined
        ? new TextDecoder().decode(bytes.subarray(0, SERVER_OPS_REDIS_MAX_RESULT_BYTES), { stream: true }) : raw
      return { command: command.command, outcome: 'completed', value, truncated, durationMs: Math.max(0, Date.now() - startedAt) }
    }
    return await Promise.race([stopped, execution()])
  } catch {
    /** 服务端报错也保守保留 unknown；避免将部分模块错误误当作未写入。 */
    return { command: command.command, outcome: write && dispatched ? 'unknown' : 'not-started', value: null, truncated: false,
      errorCode: write && dispatched && failureCode === 'SERVER_OPS_REDIS_COMMAND_FAILED' ? 'SERVER_OPS_REDIS_OUTCOME_UNKNOWN' : failureCode,
      durationMs: Math.max(0, Date.now() - startedAt) }
  } finally {
    finished = true
    lifetime.abort()
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    redis.disconnect()
    stream?.destroy()
  }
}
