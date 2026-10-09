import { describe, expect, test } from 'bun:test'
import { Duplex } from 'node:stream'
import { runServerOpsRedisCommand } from './server-ops-redis-runtime'
import type { ServerOpsRuntimeRedisRequest } from './server-ops-runtime-protocol'
import { parseServerOpsRuntimeMessage, parseServerOpsRuntimeRequest } from './server-ops-runtime-protocol'

/** 只在内存中解析客户端 RESP，不连接任何真实 Redis。 */
class RedisChannel extends Duplex {
  readonly commands: string[][] = []
  constructor(private readonly reply: (args: string[], channel: RedisChannel) => string | undefined) { super() }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    /** ioredis 对有界字符串命令一次写出完整 RESP；测试保存参数验证不重发。 */
    const parts = chunk.toString().split('\r\n')
    const args = parts.filter((_part, index) => index > 0 && index % 2 === 0).slice(0, Number(parts[0]?.slice(1)))
    this.commands.push(args)
    const response = this.reply(args, this)
    if (response !== undefined) queueMicrotask(() => { if (!this.destroyed) this.push(response) })
    done()
  }
}

/** 合法请求固定逻辑库为保存配置的 2，所有读取和写入共用。 */
const request: ServerOpsRuntimeRedisRequest = { requestId: 'r1', sourceId: 'redis-1', hostId: 'direct', connectionId: 'c1', transport: 'direct',
  address: '127.0.0.1', port: 6379, database: '2', tlsMode: 'disabled', timeoutMs: 1_000, command: 'SET', args: ['key', 'value'] }

describe('Redis 有界独立运行时', () => {
  test('Given 保存来源的逻辑库 When 执行单键 SET Then 只选择指定库且写一次', async () => {
    const channel = new RedisChannel(() => '+OK\r\n')
    const result = await runServerOpsRedisCommand(request, async () => channel)
    expect(result).toMatchObject({ command: 'SET', outcome: 'completed', value: 'OK' })
    expect(channel.commands).toEqual([['select', '2'], ['SET', 'key', 'value']])
    expect(channel.destroyed).toBe(true)
  })
  test('Given 写命令发出但断线 When 等待回执 Then unknown 且不自动重试', async () => {
    const channel = new RedisChannel((args, active) => {
      if (args[0]?.toUpperCase() === 'SELECT') return '+OK\r\n'
      queueMicrotask(() => active.destroy())
      return undefined
    })
    let connects = 0
    const result = await runServerOpsRedisCommand(request, async () => { connects += 1; return channel })
    expect(result.outcome).toBe('unknown')
    expect(result.errorCode).toBe('SERVER_OPS_REDIS_OUTCOME_UNKNOWN')
    expect(connects).toBe(1)
    expect(channel.commands.filter((args) => args[0] === 'SET')).toHaveLength(1)
  })
  test('Given 预先取消或通道迟到 When 执行 Then 不发命令并销毁迟到通道', async () => {
    const controller = new AbortController()
    const channel = new RedisChannel(() => '+OK\r\n')
    let deliver!: (stream: Duplex) => void
    const result = runServerOpsRedisCommand(request, () => new Promise((resolve) => { deliver = resolve }), controller.signal)
    controller.abort()
    expect((await result).outcome).toBe('not-started')
    deliver(channel)
    await Promise.resolve()
    await Promise.resolve()
    expect(channel.commands).toHaveLength(0)
    expect(channel.destroyed).toBe(true)
  })
  test('Given 超大 bulk 响应 When 读取 Then 在 RESP 累积期间终止且不泄漏正文', async () => {
    const channel = new RedisChannel((args) => args[0]?.toUpperCase() === 'SELECT' ? '+OK\r\n' : '$10000000\r\n' + 'x'.repeat(70_000))
    const result = await runServerOpsRedisCommand({ ...request, command: 'GET', args: ['key'] }, async () => channel)
    expect(result).toMatchObject({ outcome: 'not-started', errorCode: 'SERVER_OPS_REDIS_RESULT_TOO_LARGE', value: null })
    expect(channel.destroyed).toBe(true)
  })
  test('Given TCP 建链一直未返回 When 达到总时限 Then 中止建链且迟到通道不能发送命令', async () => {
    const channel = new RedisChannel(() => '+OK\r\n')
    let deliver!: (stream: Duplex) => void
    let lifetime: AbortSignal | undefined
    const pending = runServerOpsRedisCommand({ ...request, timeoutMs: 20 }, (signal) => {
      lifetime = signal
      return new Promise((resolve) => { deliver = resolve })
    })
    expect(await pending).toMatchObject({ outcome: 'not-started', errorCode: 'SERVER_OPS_REDIS_TIMEOUT' })
    expect(lifetime?.aborted).toBe(true)
    deliver(channel)
    await Promise.resolve()
    await Promise.resolve()
    expect(channel.destroyed).toBe(true)
    expect(channel.commands).toHaveLength(0)
  })
  test('Given 中文返回超过上下文预算 When 读取 Then 按 UTF-8 字节截断', async () => {
    const text = '中文'.repeat(4_000)
    const channel = new RedisChannel((args) => args[0]?.toUpperCase() === 'SELECT' ? '+OK\r\n' : `$${Buffer.byteLength(text)}\r\n${text}\r\n`)
    const result = await runServerOpsRedisCommand({ ...request, command: 'GET', args: ['key'] }, async () => channel)
    expect(result.outcome).toBe('completed')
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(String(result.value))).toBeLessThanOrEqual(16_384)
    expect(String(result.value)).not.toContain('�')
  })
  test('Given 协议携带任意命令或目标覆盖 When 跨进程解析 Then 严格拒绝', () => {
    expect(parseServerOpsRuntimeRequest({ type: 'server-ops.redis', input: request })).toMatchObject({ input: { command: 'SET' } })
    for (const input of [{ ...request, command: 'FLUSHALL' }, { ...request, mode: 'probe' }, { ...request, engine: 'mysql' }, { ...request, args: ['one', 'two'], command: 'DEL' }]) {
      expect(() => parseServerOpsRuntimeRequest({ type: 'server-ops.redis', input })).toThrow()
    }
    expect(() => parseServerOpsRuntimeMessage({ type: 'server-ops.redis-result', requestId: 'r1', hostId: 'direct', connectionId: 'c1',
      result: { command: 'SET', outcome: 'unknown', value: 'OK', truncated: false, durationMs: 1 } })).toThrow()
  })
})
