import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planServerOpsSqlWrite } from '@proma/shared'
import { runServerOpsLocalSqliteWrite } from './server-ops-local-sqlite-runtime'

/** 本次用例的临时目录，用例结束后整体回收。 */
let fixtureDirectory = ''
/** 本次用例的真实 SQLite 文件路径。 */
let databasePath = ''
/** 无头环境可直接使用仓库内的 Electron 可执行文件作为子进程。 */
const executablePath: string = createRequire(import.meta.url)('electron') as string

/** 从 bigint stat 构造主进程与子进程共用的稳定文件身份。 */
function getFileId(path: string): string {
  const stat = statSync(path, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

/** 把写脚本编译成共享层判定的语句计划，测试不自己伪造计划。 */
function plan(sql: string): { text: string; head: string }[] {
  return planServerOpsSqlWrite(sql, 'sqlite').statements.map((statement) => ({ text: statement.text, head: statement.head }))
}

/** 读取当前行，用于验证改动是否真的落库或真的被回滚。 */
function readRows(): { id: number; n: number }[] {
  const database = new Database(databasePath)
  try {
    return database.query('SELECT id, n FROM t ORDER BY id').all() as { id: number; n: number }[]
  } finally {
    database.close()
  }
}

beforeEach(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'proma-sqlite-write-'))
  databasePath = join(fixtureDirectory, 'db_task.sqlite')
  const database = new Database(databasePath)
  try {
    database.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO t (id, n) VALUES (1, 10), (2, 20);')
  } finally {
    database.close()
  }
})

afterEach(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true })
})

describe('本地 SQLite 写执行', () => {
  test('Given 真实 SQLite 文件 When 执行写入 Then 改动落库并返回受影响行数', async () => {
    const result = await runServerOpsLocalSqliteWrite({
      filePath: databasePath, localFileId: getFileId(databasePath), writeId: 'write-1', database: 'main',
      statements: plan('UPDATE t SET n = n + 1'), timeoutMs: 10_000,
    }, undefined, { executablePath })

    expect(result).toMatchObject({ writeId: 'write-1', database: 'main', statementCount: 1, affectedRows: 2, committed: true })
    expect(result.statements).toEqual([{ head: 'UPDATE', affectedRows: 2 }])
    /** 用独立的 bun:sqlite 连接确认改动真的落盘。 */
    expect(readRows()).toEqual([{ id: 1, n: 11 }, { id: 2, n: 21 }])
  })

  test('Given 后续语句失败 When 执行写入 Then 整脚本回滚且文件保持原状', async () => {
    const failure = await runServerOpsLocalSqliteWrite({
      filePath: databasePath, localFileId: getFileId(databasePath), writeId: 'write-2', database: 'main',
      statements: plan('UPDATE t SET n = 0; INSERT INTO missing_table (id) VALUES (9)'), timeoutMs: 10_000,
    }, undefined, { executablePath })

    expect(failure).toMatchObject({
      committed: false,
      outcome: 'rolled-back',
      errorCode: 'SERVER_OPS_DATA_WRITE_FAILED',
      statementCount: 1,
      affectedRows: 2,
    })
    /** 第一条语句的改动必须被回滚，不能留下半截迁移。 */
    expect(readRows()).toEqual([{ id: 1, n: 10 }, { id: 2, n: 20 }])
  })

  test('Given 多行 SQLite 脚本 When 执行 Then 校验入口接受换行并完整提交', async () => {
    const result = await runServerOpsLocalSqliteWrite({
      filePath: databasePath, localFileId: getFileId(databasePath), writeId: 'write-multiline', database: 'main',
      statements: plan('UPDATE t\nSET n = n + 1\nWHERE id = 1;\nUPDATE t\nSET n = n + 2\nWHERE id = 2'), timeoutMs: 10_000,
    }, undefined, { executablePath })

    expect(result).toMatchObject({ outcome: 'committed', statementCount: 2, affectedRows: 2 })
    expect(readRows()).toEqual([{ id: 1, n: 11 }, { id: 2, n: 22 }])
  })

  test('Given DML 后跟 DDL 与 SELECT When 执行 Then 后两条不沿用上一条 changes', async () => {
    const result = await runServerOpsLocalSqliteWrite({
      filePath: databasePath, localFileId: getFileId(databasePath), writeId: 'write-counts', database: 'main',
      statements: plan('UPDATE t SET n = n + 1; CREATE TABLE extra (id INTEGER); SELECT * FROM t'), timeoutMs: 10_000,
    }, undefined, { executablePath })

    expect(result.statements).toEqual([
      { head: 'UPDATE', affectedRows: 2 },
      { head: 'CREATE', affectedRows: 0 },
      { head: 'SELECT', affectedRows: 0 },
    ])
  })

  test('Given SQLite 写入在锁等待中超时 When 子进程被终止 Then 返回状态未知而不声称已回滚', async () => {
    const locker = new Database(databasePath)
    locker.exec('BEGIN EXCLUSIVE')
    try {
      const result = await runServerOpsLocalSqliteWrite({
        filePath: databasePath, localFileId: getFileId(databasePath), writeId: 'write-timeout', database: 'main',
        statements: plan('UPDATE t SET n = 0'), timeoutMs: 250,
      }, undefined, { executablePath })
      expect(result).toMatchObject({
        outcome: 'unknown',
        errorCode: 'SERVER_OPS_DATA_WRITE_TIMEOUT',
        committed: false,
      })
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
    expect(readRows()).toEqual([{ id: 1, n: 10 }, { id: 2, n: 20 }])
  })

  test('Given 伪造的事务控制计划 When 执行 Then 父入口重新编译并在开子进程前拒绝', async () => {
    const failure = await runServerOpsLocalSqliteWrite({
      filePath: databasePath, localFileId: getFileId(databasePath), writeId: 'write-forged', database: 'main',
      statements: [{ text: 'END TRANSACTION', head: 'UPDATE' }, { text: 'UPDATE t SET n = 0', head: 'UPDATE' }], timeoutMs: 10_000,
    }, undefined, { executablePath }).catch((error) => error)

    expect(failure.message).toBe('SERVER_OPS_DATA_WRITE_INPUT_INVALID')
    expect(readRows()).toEqual([{ id: 1, n: 10 }, { id: 2, n: 20 }])
  })

  test('Given 文件身份与当前文件不符 When 执行写入 Then 开子进程前拒绝', async () => {
    const failure = await runServerOpsLocalSqliteWrite({
      filePath: databasePath, localFileId: '1:2:3', writeId: 'write-3', database: 'main',
      statements: plan('UPDATE t SET n = n + 1'), timeoutMs: 10_000,
    }, undefined, { executablePath }).catch((error) => error)

    expect(failure.message).toBe('SERVER_OPS_SQLITE_FILE_CHANGED')
    expect(readRows()).toEqual([{ id: 1, n: 10 }, { id: 2, n: 20 }])
  })

  test('Given 写脚本只有只读语句 When 编译计划 Then 在进入执行器前就被拒绝', () => {
    expect(() => plan('SELECT * FROM t')).toThrow()
  })
})
