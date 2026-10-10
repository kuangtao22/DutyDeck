import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import {
  executeServerOpsDataWrite,
  ServerOpsDataWriteError,
} from './server-ops-write-dispatch'
import type { ServerOpsDataWriteDependencies, ServerOpsDataWriteContext } from './server-ops-write-dispatch'
import type { ServerOpsRuntimeDataWriteRequest } from './server-ops-runtime-protocol'

/** 造一个可触发 connect 的假直连通道。 */
function createFakeSocket(): Duplex {
  const socket = new EventEmitter() as unknown as Record<string, unknown>
  socket.destroy = (): void => undefined
  socket.destroyed = false
  /** 下一次微任务触发 connect，模拟真实异步建链。 */
  queueMicrotask(() => (socket as unknown as EventEmitter).emit('connect'))
  return socket as unknown as Duplex
}

/** 造一个带 promise() 的假 mysql2 连接。 */
function createFakeMysqlConnection(): { connection: unknown; promiseCalls: number[] } {
  const promiseCalls: number[] = []
  const connection = {
    destroy: (): void => undefined,
    promise: () => { promiseCalls.push(1); return { marker: 'promise-connection' } },
  }
  return { connection, promiseCalls }
}

/** 记录调用的假依赖；各用例只覆盖需要的字段。 */
interface Harness {
  dependencies: ServerOpsDataWriteDependencies
  sqliteInputs: unknown[]
  mySqlStatements: unknown[]
  mySqlConnections: unknown[]
  openedChannels: number
  openedConnections: number
  remoteWrites: number
}

/**
 * 构造假依赖。
 *
 * @param options.mysqlOpen 连接建立阶段的行为
 * @param options.mysqlWrite 语句执行阶段的行为
 * @param options.sqlite 本地 SQLite 执行阶段的行为
 */
function createHarness(options: {
  mysqlOpen?: () => unknown
  mysqlWrite?: () => unknown
  sqlite?: () => unknown
  remoteSqlite?: () => unknown
} = {}): Harness {
  /** 时钟在第二次读取时前进，使 durationMs 可断言。 */
  let clock = 1_000
  const harness: Harness = {
    sqliteInputs: [], mySqlStatements: [], mySqlConnections: [], openedChannels: 0, openedConnections: 0, remoteWrites: 0,
    dependencies: null as unknown as ServerOpsDataWriteDependencies,
  }
  harness.dependencies = {
    createDirectChannel: () => { harness.openedChannels += 1; return createFakeSocket() },
    openMySqlConnection: (async (_params: unknown, connectionDependencies: { createChannel: () => Promise<Duplex> }) => {
      const outcome = options.mysqlOpen?.()
      if (outcome instanceof Error) throw outcome
      /** 按真实顺序先建立通道，才能验证核心确实在连接前登记了它。 */
      await connectionDependencies.createChannel()
      const { connection } = createFakeMysqlConnection()
      return { connection, channel: createFakeSocket(), stream: {}, tlsStatus: 'plaintext' }
    }) as unknown as ServerOpsDataWriteDependencies['openMySqlConnection'],
    runMySqlWrite: (async (connection: unknown, statements: unknown) => {
      harness.mySqlConnections.push(connection)
      harness.mySqlStatements.push(statements)
      const outcome = options.mysqlWrite?.()
      if (outcome instanceof Error) throw outcome
      return outcome ?? { statementCount: 1, affectedRows: 3, committed: true, statements: [{ head: 'UPDATE', affectedRows: 3 }], warnings: [] }
    }) as unknown as ServerOpsDataWriteDependencies['runMySqlWrite'],
    runLocalSqliteWrite: (async (input: unknown) => {
      harness.sqliteInputs.push(input)
      const outcome = options.sqlite?.()
      if (outcome instanceof Error) throw outcome
      return outcome ?? { writeId: 'write-1', database: 'main', statementCount: 1, affectedRows: 2, committed: true, durationMs: 5, statements: [{ head: 'UPDATE', affectedRows: 2 }], warnings: [] }
    }) as unknown as ServerOpsDataWriteDependencies['runLocalSqliteWrite'],
    runRemoteSqliteWrite: (async () => {
      harness.remoteWrites += 1
      const outcome = options.remoteSqlite?.()
      if (outcome instanceof Error) throw outcome
      return outcome ?? { writeId: 'write-1', database: 'main', statementCount: 1, affectedRows: 1, committed: true, outcome: 'committed', durationMs: 5, statements: [{ head: 'UPDATE', affectedRows: 1 }], warnings: [] }
    }) as unknown as ServerOpsDataWriteDependencies['runRemoteSqliteWrite'],
    now: () => { clock += 7; return clock },
  }
  return harness
}

/** 构造上下文并记录资源登记。 */
function createContext(harness: Harness): ServerOpsDataWriteContext {
  return {
    signal: new AbortController().signal,
    onChannelOpened: () => { harness.openedChannels += 1 },
    onConnectionOpened: () => { harness.openedConnections += 1 },
  }
}

/** 请求基线；各用例只覆盖要验证的字段。 */
const baseRequest: ServerOpsRuntimeDataWriteRequest = {
  requestId: 'request-1', hostId: 'host-1', connectionId: 'connection-1', transport: 'direct',
  engine: 'mysql', address: '10.0.0.5', port: 3306, database: 'chebenben', tlsMode: 'disabled',
  timeoutMs: 30_000, writeId: 'write-1', statements: [{ text: 'UPDATE t SET n = 1', head: 'UPDATE' }],
}

describe('写执行核心', () => {
  test('Given 本地 SQLite 请求 When 执行 Then 只调用 SQLite 执行器并返回其合同', async () => {
    const harness = createHarness()
    const result = await executeServerOpsDataWrite(
      { ...baseRequest, engine: 'sqlite', filePath: '/tmp/db.sqlite', localFileId: '1:2:3' },
      createContext(harness), harness.dependencies,
    )
    expect(result.affectedRows).toBe(2)
    expect(harness.sqliteInputs).toHaveLength(1)
    /** SQLite 不建立 TCP 通道，也不触碰 MySQL 执行器。 */
    expect(harness.mySqlStatements).toEqual([])
    expect(harness.openedConnections).toBe(0)
  })

  test('Given 经跳板的写请求 When 执行 Then 在执行任何引擎前显式拒绝', async () => {
    const harness = createHarness()
    const failure = await executeServerOpsDataWrite(
      { ...baseRequest, transport: 'ssh' }, createContext(harness), harness.dependencies,
    ).catch((error) => error)
    expect(failure).toBeInstanceOf(ServerOpsDataWriteError)
    expect(failure.code).toBe('SERVER_OPS_DATA_WRITE_SSH_UNSUPPORTED')
    /** 拒绝必须发生在建通道与建连接之前。 */
    expect(harness.openedChannels).toBe(0)
    expect(harness.mySqlStatements).toEqual([])
  })

  test('Given SSH SQLite 请求 When 执行 Then 路由到远程 SQLite 执行器', async () => {
    const harness = createHarness()
    const result = await executeServerOpsDataWrite(
      { ...baseRequest, transport: 'ssh', engine: 'sqlite', database: 'main', address: undefined, port: undefined,
        filePath: '/var/lib/app.sqlite', localFileId: undefined }, createContext(harness), harness.dependencies,
    )
    expect(result).toMatchObject({ committed: true, outcome: 'committed', affectedRows: 1 })
    expect(harness.remoteWrites).toBe(1)
    expect(harness.openedConnections).toBe(0)
  })

  test('Given MySQL 写入成功 When 执行 Then 用 promise 形态连接并补上 durationMs', async () => {
    const harness = createHarness()
    const result = await executeServerOpsDataWrite(baseRequest, createContext(harness), harness.dependencies)
    expect(result).toMatchObject({ writeId: 'write-1', database: 'chebenben', affectedRows: 3, durationMs: 7 })
    /** 直连通道与连接都必须交给 runtime 登记，取消时才有东西可销毁。 */
    expect(harness.openedChannels).toBeGreaterThan(0)
    expect(harness.openedConnections).toBe(1)
    expect(harness.mySqlConnections).toEqual([{ marker: 'promise-connection' }])
  })

  test('Given 连接阶段失败 When 执行 Then 报连接失败而不是写入失败', async () => {
    const harness = createHarness({ mysqlOpen: () => new Error('connect ECONNREFUSED') })
    const failure = await executeServerOpsDataWrite(baseRequest, createContext(harness), harness.dependencies).catch((error) => error)
    expect(failure.code).toBe('SERVER_OPS_DATA_CHANNEL_FAILED')
  })

  test('Given 语句执行阶段失败 When 执行 Then 报写入失败并带上执行器稳定码', async () => {
    const failing = createHarness({ mysqlWrite: () => Object.assign(new Error('boom'), { code: 'SERVER_OPS_DATA_WRITE_FAILED' }) })
    const first = await executeServerOpsDataWrite(baseRequest, createContext(failing), failing.dependencies).catch((error) => error)
    expect(first.code).toBe('SERVER_OPS_DATA_WRITE_FAILED')
    /** 未登记在写白名单里的驱动错误不得被当成公开码透传。 */
    const driverError = createHarness({ mysqlWrite: () => Object.assign(new Error('ER_PARSE_ERROR'), { code: 'ER_PARSE_ERROR' }) })
    const second = await executeServerOpsDataWrite(baseRequest, createContext(driverError), driverError.dependencies).catch((error) => error)
    expect(second.code).toBe('SERVER_OPS_DATA_WRITE_FAILED')
    expect(second.publicMessage).not.toContain('ER_PARSE_ERROR')
  })

  test('Given 执行器返回取消 When 执行 Then 归一到取消码而不是失败码', async () => {
    const harness = createHarness({ mysqlWrite: () => Object.assign(new Error('cancelled'), { code: 'SERVER_OPS_DATA_WRITE_CANCELLED' }) })
    const failure = await executeServerOpsDataWrite(baseRequest, createContext(harness), harness.dependencies).catch((error) => error)
    expect(failure.code).toBe('SERVER_OPS_DATA_WRITE_CANCELLED')
    /** 提交失败要有独立分类，不能和普通写入失败混在一起。 */
    const commit = createHarness({ mysqlWrite: () => Object.assign(new Error('commit'), { code: 'SERVER_OPS_DATA_WRITE_COMMIT_FAILED' }) })
    const commitFailure = await executeServerOpsDataWrite(baseRequest, createContext(commit), commit.dependencies).catch((error) => error)
    expect(commitFailure.code).toBe('SERVER_OPS_DATA_WRITE_COMMIT_FAILED')
  })
})
