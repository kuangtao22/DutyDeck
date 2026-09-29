import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import type { Connection, ConnectionOptions } from 'mysql2'
import { openServerOpsMySqlConnection } from './server-ops-mysql-connection'

/** 假底层通道；只实现被销毁统计需要的最小表面。 */
function createFakeChannel(destroyed: string[]): Duplex {
  /** 用宽松索引签名对象承载假实现，避免与 `Duplex.destroy` 的返回类型冲突。 */
  const channel = new EventEmitter() as unknown as Record<string, unknown>
  channel.destroy = (): void => { destroyed.push('channel') }
  channel.destroyed = false
  return channel as unknown as Duplex
}

/**
 * 假驱动连接。
 *
 * @param encrypted 是否为加密流；决定 TLS 状态判定
 * @param failure 握手失败时的错误码
 */
function createFakeConnection(encrypted: boolean, failure?: string): Connection {
  const connection = new EventEmitter() as unknown as Connection & {
    destroy: () => void
    stream: Duplex & { encrypted?: boolean }
  }
  connection.destroy = () => undefined
  connection.stream = { encrypted } as unknown as Duplex & { encrypted?: boolean }
  /**
   * 用微任务模拟异步握手。
   *
   * **必须发 `connect`**：mysql2 的 Connection 在握手完成时发的是 `connect`，
   * 从不发 `ready`——早期版本这里的假件按错误的假设发 `ready`，于是测试全绿而真机永远超时。
   */
  queueMicrotask(() => {
    if (failure) connection.emit('error', Object.assign(new Error('handshake failed'), { code: failure }))
    else connection.emit('connect')
  })
  return connection as unknown as Connection
}

/** 记录每次建连使用的驱动选项。 */
interface Harness {
  options: ConnectionOptions[]
  destroyed: string[]
  channels: number
}

/**
 * 运行一次连接建立。
 *
 * @param params 连接参数
 * @param results 每次尝试的握手结果（是否加密、是否失败）
 */
async function open(
  params: Parameters<typeof openServerOpsMySqlConnection>[0],
  results: { encrypted: boolean; failure?: string }[],
  signal?: AbortSignal,
): Promise<{ harness: Harness; outcome: Awaited<ReturnType<typeof openServerOpsMySqlConnection>> }> {
  const harness: Harness = { options: [], destroyed: [], channels: 0 }
  let attempt = 0
  const outcome = await openServerOpsMySqlConnection(params, {
    createChannel: async () => { harness.channels += 1; return createFakeChannel(harness.destroyed) },
    createConnection: (options: ConnectionOptions) => {
      harness.options.push(options)
      const next = results[attempt] ?? results[results.length - 1]!
      attempt += 1
      return createFakeConnection(next.encrypted, next.failure)
    },
    timeoutMs: 5_000,
    ...(signal ? { signal } : {}),
  })
  return { harness, outcome }
}

/** 连接参数基线；各用例只覆盖要验证的字段。 */
const base = { address: '10.0.0.5', port: 3306, username: 'u', password: 'p', tlsMode: 'disabled' as const }

describe('MySQL 连接构造（读写共用）', () => {
  test('Given 明文模式 When 建连 Then 不请求 TLS 且状态为 plaintext', async () => {
    const { harness, outcome } = await open(base, [{ encrypted: false }])
    expect(harness.options[0]?.ssl).toBeUndefined()
    expect(harness.options[0]?.host).toBe('10.0.0.5')
    expect(outcome.tlsStatus).toBe('plaintext')
  })

  test('Given required 模式 When 建连 Then 请求 TLS 但状态是 encrypted 而不是 verified', async () => {
    const { harness, outcome } = await open({ ...base, tlsMode: 'required' }, [{ encrypted: true }])
    expect(harness.options[0]?.ssl).toEqual({ rejectUnauthorized: false, verifyIdentity: false })
    expect(outcome.tlsStatus).toBe('encrypted')
  })

  test('Given verify 模式 When 建连 Then 用 tlsServerName 握手并要求证书与主机名校验', async () => {
    const { harness, outcome } = await open(
      { ...base, tlsMode: 'verify', tlsServerName: 'db.example.com' },
      [{ encrypted: true }],
    )
    expect(harness.options[0]?.host).toBe('db.example.com')
    expect(harness.options[0]?.ssl).toEqual({ rejectUnauthorized: true, verifyIdentity: true })
    expect(outcome.tlsStatus).toBe('verified')
  })

  test('Given 声称要 TLS 但拿到明文流 When 建连 Then 拒绝且不放过', async () => {
    const failure = await open({ ...base, tlsMode: 'required' }, [{ encrypted: false }]).catch((error) => error)
    expect(failure.code).toBe('HANDSHAKE_SSL_ERROR')
  })

  test('Given preferred 且服务端明确无 TLS When 建连 Then 只回退一次明文并报告 plaintext', async () => {
    const { harness, outcome } = await open(
      { ...base, tlsMode: 'preferred' },
      [{ encrypted: false, failure: 'HANDSHAKE_NO_SSL_SUPPORT' }, { encrypted: false }],
    )
    expect(harness.channels).toBe(2)
    expect(harness.options[0]?.ssl).toBeDefined()
    /** 第二次尝试必须不带 ssl，否则会再次触发同一种握手失败。 */
    expect(harness.options[1]?.ssl).toBeUndefined()
    expect(outcome.tlsStatus).toBe('plaintext')
  })

  test('Given required 或 verify 遇到无 TLS 服务端 When 建连 Then 绝不回退', async () => {
    for (const tlsMode of ['required', 'verify'] as const) {
      const failure = await open(
        { ...base, tlsMode, ...(tlsMode === 'verify' ? { tlsServerName: 'db.example.com' } : {}) },
        [{ encrypted: false, failure: 'HANDSHAKE_NO_SSL_SUPPORT' }],
      ).catch((error) => error)
      expect(failure.code).toBe('HANDSHAKE_NO_SSL_SUPPORT')
    }
  })

  test('Given 握手失败 When 建连 Then 销毁通道与连接而不是留给调用方', async () => {
    const harness: Harness = { options: [], destroyed: [], channels: 0 }
    const failure = await openServerOpsMySqlConnection(base, {
      createChannel: async () => { harness.channels += 1; return createFakeChannel(harness.destroyed) },
      createConnection: () => createFakeConnection(false, 'PROTOCOL_CONNECTION_LOST'),
      timeoutMs: 5_000,
    }).catch((error) => error)
    expect(failure.code).toBe('PROTOCOL_CONNECTION_LOST')
    expect(harness.destroyed).toEqual(['channel'])
  })

  test('Given 取消信号已触发 When 建连 Then 立即拒绝并销毁刚建立的通道', async () => {
    const controller = new AbortController()
    controller.abort()
    const harness: Harness = { options: [], destroyed: [], channels: 0 }
    const failure = await openServerOpsMySqlConnection(base, {
      createChannel: async () => { harness.channels += 1; return createFakeChannel(harness.destroyed) },
      createConnection: () => createFakeConnection(false),
      timeoutMs: 5_000,
      signal: controller.signal,
    }).catch((error) => error)
    expect(failure.message).toBe('SERVER_OPS_DATA_CANCELLED')
    expect(harness.destroyed).toEqual(['channel'])
    /** 取消后绝不能再创建驱动连接。 */
    expect(harness.options).toEqual([])
  })

  test('Given 未提供默认库 When 建连 Then 驱动选项里不出现 database', async () => {
    const { harness } = await open(base, [{ encrypted: false }])
    expect('database' in (harness.options[0] ?? {})).toBe(false)
    const withDatabase = await open({ ...base, database: 'chebenben' }, [{ encrypted: false }])
    expect(withDatabase.harness.options[0]?.database).toBe('chebenben')
  })

  test('Given 驱动只发 ready 而不发 connect When 建连 Then 不得据此认为握手已完成', async () => {
    /**
     * 回归：早期版本等待 `ready`，而 mysql2 只发 `connect`，
     * 结果是每次握手都挂到整体超时，对外表现成「数据库连不上」。
     */
    const controller = new AbortController()
    const channel = createFakeChannel([])
    /** 只发 `ready`：如果实现错误地等这个事件，下面的竞态会返回 success 而不是可选取消。 */
    const connection = new EventEmitter() as unknown as Record<string, unknown>
    connection.destroy = (): void => undefined
    connection.stream = { encrypted: false }
    queueMicrotask(() => (connection as unknown as EventEmitter).emit('ready'))
    const pending = openServerOpsMySqlConnection(base, {
      createChannel: async () => channel,
      createConnection: () => connection as unknown as Connection,
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    /** 给 `ready` 一个回合的机会，然后取消；只有仍处于等待握手才会以取消结算。 */
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    const failure = await pending.catch((error) => error)
    expect(failure.message).toBe('SERVER_OPS_DATA_CANCELLED')
  })
})
