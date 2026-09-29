/** 隔离验收 Electron 主进程到 SQLite 子进程的运维写入、审计与历史完整链路。 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SERVER_OPS_DATA_WRITE_CHANNELS,
  parseServerOpsDataWriteResult,
} from '@proma/shared'
import type { ServerOpsDataWriteInput } from '@proma/shared'
import { app } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { ServerOpsAgentAccessStore } from '../src/main/lib/server-ops/server-ops-agent-access-store'
import { ServerOpsAuditStore } from '../src/main/lib/server-ops/server-ops-audit-store'
import { ServerOpsDataQueryHistoryStore } from '../src/main/lib/server-ops/server-ops-data-query-history-store'
import { ServerOpsDataService } from '../src/main/lib/server-ops/server-ops-data-service'
import { ServerOpsDataSourceStore } from '../src/main/lib/server-ops/server-ops-data-source-store'
import { registerServerOpsIpcHandlers } from '../src/main/lib/server-ops/server-ops-ipc'
import type { ServerOpsIpcOptions } from '../src/main/lib/server-ops/server-ops-ipc'
import { ServerOpsRuntimeClient } from '../src/main/lib/server-ops/server-ops-runtime-client'

/** SQLite 夹具返回的业务行。 */
interface FixtureRow { id: number; value: number }
/** Electron 内置 SQLite 的最小 statement 能力。 */
interface FixtureStatement { all(): unknown[] }
/** Electron 内置 SQLite 的最小数据库能力。 */
interface FixtureDatabase { exec(sql: string): void; prepare(sql: string): FixtureStatement; close(): void }
/** IPC smoke 内保存的 handler 签名。 */
type SmokeHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 使用 Electron 自带 Node SQLite，避免引入依赖或读取用户数据库。 */
const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => FixtureDatabase }
/** 本次 smoke 独占的配置、userData 与数据库根目录。 */
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'proma-server-ops-write-smoke-'))
/** 本次 smoke 的合成 SQLite 文件。 */
const databasePath = join(fixtureDirectory, 'fixture.sqlite3')
/** 跨进程写执行使用的真实 runtime client。 */
const runtime = new ServerOpsRuntimeClient()
/** 注册后的 IPC handler，仅在当前进程内模拟 Electron ipcMain。 */
const handlers = new Map<string, SmokeHandler>()
/** 授权 sender 模拟唯一可见主窗口，不创建真实 UI。 */
const sender = { id: 91, isDestroyed: () => false, send: () => undefined } as unknown as WebContents
/** 当前脚本的 Electron userData，确保不会触达正式实例。 */
const electronDirectory = join(fixtureDirectory, 'electron-user-data')
mkdirSync(electronDirectory)
app.setPath('userData', electronDirectory)
/** 整体验收超时，防止失败时遗留 utility 或 SQLite 子进程。 */
const timeout = setTimeout(() => finish(1), 45_000)
/** 防止超时与正常结束同时重复清理。 */
let finished = false

/** 调用真实注册器安装的 IPC handler，保持与 renderer 请求相同的入口。 */
function invoke(channel: string, input: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`未注册运维 IPC: ${channel}`)
  return Promise.resolve().then(() => handler({ sender } as IpcMainInvokeEvent, input))
}

/** 从独立 SQLite 连接读取当前业务行，验证提交或回滚事实。 */
function readRows(): FixtureRow[] {
  const database = new sqlite.DatabaseSync(databasePath)
  try {
    /** Node SQLite 返回 null-prototype 行对象；投影为普通对象后只比较业务值。 */
    return (database.prepare('SELECT id, value FROM records ORDER BY id').all() as FixtureRow[])
      .map((row) => ({ id: row.id, value: row.value }))
  } finally {
    database.close()
  }
}

/** 构造 IPC 注册所需但本 smoke 不允许触达的服务器依赖。 */
function createUnavailableServerDependencies(): Pick<ServerOpsIpcOptions, 'hosts' | 'connections' | 'credentials'> {
  const unavailable = (): never => { throw new Error('smoke 不应访问 SSH 或服务器资产') }
  return {
    hosts: {
      list: () => [], get: () => undefined, upsert: unavailable, setCredentialRef: unavailable, remove: () => false,
    },
    credentials: { remember: unavailable, forgetHost: () => undefined },
    connections: {
      connect: async () => unavailable(), testConnection: async () => unavailable(), confirmHostKey: async () => unavailable(),
      disconnect: unavailable, writeTerminal: unavailable, resizeTerminal: unavailable, acknowledgeOutput: unavailable,
      getTerminalSnapshot: () => undefined, onState: () => () => undefined, onOutput: () => () => undefined,
      onExit: () => () => undefined, getState: unavailable, exec: async () => unavailable(),
    },
  }
}

/** 通过真实 IPC、服务、utility 和 SQLite 子进程执行全部写链验收。 */
async function runSmoke(): Promise<void> {
  app.dock?.hide()
  /** 创建完全合成的初始业务数据。 */
  const fixture = new sqlite.DatabaseSync(databasePath)
  fixture.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO records VALUES (1, 10), (2, 20);')
  fixture.close()

  /** 所有配置 Store 都指向临时根，并共享无外部锁的进程内事务边界。 */
  const transaction = <T>(callback: () => T): T => callback()
  const sourceStore = new ServerOpsDataSourceStore(fixtureDirectory, { transaction })
  const historyStore = new ServerOpsDataQueryHistoryStore(fixtureDirectory, { transaction })
  const auditStore = new ServerOpsAuditStore(fixtureDirectory, { transaction })
  /** 数据服务使用真实 runtime；凭据与 SSH 路径一旦触达就立即失败。 */
  const service = new ServerOpsDataService({
    store: sourceStore,
    runtime,
    transaction,
    credentials: {
      setSecret: () => { throw new Error('smoke 不应保存凭据') },
      resolveSecret: () => undefined,
      removeSecret: () => false,
      removeByHost: () => 0,
    },
    connection: { getActiveIdentity: () => { throw new Error('smoke 不应连接 SSH') } },
  })
  /** 本地 SQLite 数据源只存在于临时配置目录。 */
  const source = service.upsertSource({
    engine: 'sqlite', transport: 'direct', filePath: databasePath, label: '写入 smoke', database: 'main', tlsMode: 'disabled',
  }).source
  /** 主窗口替身保留关闭监听合同，用于验证真实 IPC 所有权路径。 */
  const owner = {
    id: 19,
    webContents: sender,
    isDestroyed: () => false,
    once: () => undefined,
    removeListener: () => undefined,
  }
  /** 注册真实运维 IPC，除目标链外的依赖均为明确禁止访问的替身。 */
  const registration = registerServerOpsIpcHandlers({
    ipc: {
      handle: (channel, handler) => { handlers.set(channel, handler) },
      removeHandler: (channel) => { handlers.delete(channel) },
    },
    listAuthorizedWebContents: () => [sender],
    ...createUnavailableServerDependencies(),
    access: new ServerOpsAgentAccessStore(),
    audit: {
      append: auditStore.append.bind(auditStore),
      list: auditStore.list.bind(auditStore),
      prepareForWrites: () => auditStore.prepareForWrites(async () => () => undefined),
    },
    data: service,
    queryHistory: historyStore,
    resolveOwnerWindow: () => owner,
    requireUserVisibleSession: () => ({ id: 'smoke-session', title: 'smoke', createdAt: 1, updatedAt: 1 }),
  })

  try {
    /** 多行写脚本必须完整提交，并通过独立连接观察到真实数据。 */
    const committedRequest: ServerOpsDataWriteInput = {
      sourceId: source.id,
      source,
      database: 'main',
      writeId: 'write-committed',
      sql: 'UPDATE records\nSET value = value + 1\nWHERE id = 1;\nUPDATE records\nSET value = value + 2\nWHERE id = 2',
    }
    const committed = parseServerOpsDataWriteResult(await invoke(SERVER_OPS_DATA_WRITE_CHANNELS.EXECUTE, committedRequest))
    assert.equal(committed.outcome, 'committed')
    assert.equal(committed.statementCount, 2)
    assert.deepEqual(readRows(), [{ id: 1, value: 11 }, { id: 2, value: 22 }])

    /** 审计必须用同一个 operationId 保存开始和终态，且不保存 SQL 正文。 */
    const committedAudit = auditStore.list({ sourceId: source.id }).records
      .filter((record) => record.operation === 'data-write')
    assert.equal(committedAudit.length, 2)
    assert.deepEqual(committedAudit.map((record) => record.phase), ['start', 'result'])
    assert.equal(committedAudit[0]?.operationId, committedAudit[1]?.operationId)
    assert.equal(committedAudit[1]?.outcome, 'success')
    assert.ok(committedAudit.every((record) => !('command' in record) && !('queryHash' in record)))

    /** 第二条语句失败必须回滚第一条，不允许留下半次变更。 */
    const rollbackRequest: ServerOpsDataWriteInput = {
      sourceId: source.id,
      source,
      database: 'main',
      writeId: 'write-rolled-back',
      sql: 'UPDATE records SET value = 0 WHERE id = 1; INSERT INTO missing_table (id) VALUES (9)',
    }
    const rolledBack = parseServerOpsDataWriteResult(await invoke(SERVER_OPS_DATA_WRITE_CHANNELS.EXECUTE, rollbackRequest))
    assert.equal(rolledBack.outcome, 'rolled-back')
    assert.equal(rolledBack.errorCode, 'SERVER_OPS_DATA_WRITE_FAILED')
    assert.deepEqual(readRows(), [{ id: 1, value: 11 }, { id: 2, value: 22 }])

    /** 会话控制语句必须在派发前以 not-started 拒绝，数据库保持不变。 */
    const rejectedRequest: ServerOpsDataWriteInput = {
      sourceId: source.id,
      source,
      database: 'main',
      writeId: 'write-rejected',
      sql: 'END TRANSACTION; UPDATE records SET value = 99',
    }
    const rejected = parseServerOpsDataWriteResult(await invoke(SERVER_OPS_DATA_WRITE_CHANNELS.EXECUTE, rejectedRequest))
    assert.equal(rejected.outcome, 'not-started')
    assert.equal(rejected.errorCode, 'SERVER_OPS_SQL_STATEMENT_REJECTED')
    assert.deepEqual(readRows(), [{ id: 1, value: 11 }, { id: 2, value: 22 }])

    /** 只读查询链继续拒绝写语句，不能因新增写通道而放宽。 */
    await assert.rejects(service.querySource({
      sourceId: source.id, database: 'main', queryId: 'read-chain-write', sql: 'DELETE FROM records', maxRows: 50,
    }))
    assert.deepEqual(readRows(), [{ id: 1, value: 11 }, { id: 2, value: 22 }])

    /** 相同 SQL 的两次执行拥有独立 writeId 和历史条目，不能按文本去重。 */
    const repeatedSql = 'UPDATE records SET value = value + 1 WHERE id = 1'
    for (const writeId of ['write-repeat-one', 'write-repeat-two']) {
      const result = parseServerOpsDataWriteResult(await invoke(SERVER_OPS_DATA_WRITE_CHANNELS.EXECUTE, {
        sourceId: source.id, source, database: 'main', writeId, sql: repeatedSql,
      }))
      assert.equal(result.outcome, 'committed')
    }
    const repeatedHistory = historyStore.list({ sourceId: source.id, database: 'main' }).entries
      .filter((entry) => entry.sql === repeatedSql)
    assert.equal(repeatedHistory.length, 2)
    assert.equal(new Set(repeatedHistory.map((entry) => entry.id)).size, 2)
    assert.deepEqual(new Set(repeatedHistory.map((entry) => entry.execution?.writeId)), new Set(['write-repeat-one', 'write-repeat-two']))
    assert.ok(repeatedHistory.every((entry) => entry.execution?.finishedAt !== undefined
      && entry.execution.result?.outcome === 'committed'
      && entry.execution.result.durationMs >= 0))

    /** 首次成功运行也必须持久化完整单次状态、时间与结果。 */
    const committedHistory = historyStore.list({ sourceId: source.id, database: 'main' }).entries
      .find((entry) => entry.execution?.writeId === committedRequest.writeId)
    assert(committedHistory?.execution?.finishedAt !== undefined)
    assert.equal(committedHistory.execution.result?.outcome, 'committed')
    assert.deepEqual(readRows(), [{ id: 1, value: 13 }, { id: 2, value: 22 }])

    /** 确认卡打开后另一个窗口改目标，旧快照必须在开始记录前拒绝，两个文件都不能被写。 */
    const replacementPath = join(fixtureDirectory, 'replacement.sqlite3')
    const replacement = new sqlite.DatabaseSync(replacementPath)
    try {
      replacement.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO records VALUES (1, 100);')
      service.upsertSource({ sourceId: source.id, engine: 'sqlite', transport: 'direct', filePath: replacementPath,
        label: '另一个窗口选择的新目标', database: 'main', tlsMode: 'disabled' })
      assert.equal(service.listSources({}).sources.find((entry) => entry.id === source.id)?.filePath, realpathSync(replacementPath))
      await assert.rejects(invoke(SERVER_OPS_DATA_WRITE_CHANNELS.EXECUTE, {
        sourceId: source.id, source, database: 'main', writeId: 'write-stale-target', sql: repeatedSql,
      }), /SERVER_OPS_DATA_SOURCE_CHANGED/u)
      assert.equal((replacement.prepare('SELECT value FROM records WHERE id = 1').all()[0] as FixtureRow).value, 100)
      assert.deepEqual(readRows(), [{ id: 1, value: 13 }, { id: 2, value: 22 }])
      assert.ok(historyStore.list({ sourceId: source.id, database: 'main' }).entries
        .every((entry) => entry.execution?.writeId !== 'write-stale-target'))
    } finally { replacement.close() }
    console.log('[运维写入 smoke] PASS：真实 IPC→DataService→runtime→SQLite，提交/回滚/策略拒绝/只读隔离/审计/逐次历史/旧目标快照拒绝均通过')
  } finally {
    registration.dispose()
    service.dispose()
  }
}

/** 停止本 smoke 的全部进程与临时文件，并把退出码交给调用方。 */
function finish(code: number): void {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  runtime.stop()
  rmSync(fixtureDirectory, { recursive: true, force: true })
  app.exit(code)
}

void app.whenReady().then(runSmoke).then(() => finish(0), (error: unknown) => {
  console.error('[运维写入 smoke] FAIL', error)
  finish(1)
})
