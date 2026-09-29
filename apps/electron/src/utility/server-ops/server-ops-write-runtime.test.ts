import { describe, expect, test } from 'bun:test'
import { planServerOpsSqlWrite } from '@proma/shared'
import { runServerOpsMySqlWriteScript } from './server-ops-write-runtime'
import type { ServerOpsWriteMySqlConnection } from './server-ops-write-runtime'

/** 记录调用顺序的假 MySQL 连接；用于在沙箱内验证事务语义而不连真实数据库。 */
interface FakeConnection extends ServerOpsWriteMySqlConnection {
  calls: string[]
}

/**
 * 构造假连接。
 *
 * @param results 每条语句的返回；用 Error 表示该语句抛错
 * @param failOn 需要模拟失败的调用名（begin/commit/rollback）
 */
function createConnection(
  results: readonly unknown[],
  failOn?: 'begin' | 'commit' | 'rollback',
): FakeConnection {
  const calls: string[] = []
  let index = 0
  return {
    calls,
    query: async (sql: string) => {
      calls.push(`query:${sql}`)
      const result = results[index]
      index += 1
      if (result instanceof Error) throw result
      return result
    },
    beginTransaction: async () => {
      calls.push('begin')
      if (failOn === 'begin') throw new Error('begin failed')
    },
    commit: async () => {
      calls.push('commit')
      if (failOn === 'commit') throw new Error('commit failed')
    },
    rollback: async () => {
      calls.push('rollback')
      if (failOn === 'rollback') throw new Error('rollback failed')
    },
  }
}

/** 把脚本编译成共享层判定的语句计划，测试不自己伪造计划。 */
function plan(sql: string) {
  return planServerOpsSqlWrite(sql, 'mysql').statements
}

describe('MySQL 写脚本执行', () => {
  test('Given 多条 DML 全部成功 When 执行 Then 单次提交并累计受影响行数', async () => {
    const connection = createConnection([{ affectedRows: 2 }, { affectedRows: 3 }])
    const outcome = await runServerOpsMySqlWriteScript(connection, plan('UPDATE a SET x = 1; DELETE FROM b WHERE id = 1'))
    expect(connection.calls).toEqual([
      'begin', 'query:UPDATE a SET x = 1', 'query:DELETE FROM b WHERE id = 1', 'commit',
    ])
    expect(outcome).toMatchObject({ statementCount: 2, affectedRows: 5, committed: true })
    expect(outcome.warnings).toEqual([])
  })

  test('Given 中途失败且回滚已确认 When 执行 Then 保守返回结果未知而不声称事务表之外也已回滚', async () => {
    const connection = createConnection([{ affectedRows: 1 }, new Error('驱动原文不应外泄')])
    const failure = await runServerOpsMySqlWriteScript(connection, plan('UPDATE a SET x = 1; DELETE FROM b'))
    expect(connection.calls).toEqual(['begin', 'query:UPDATE a SET x = 1', 'query:DELETE FROM b', 'rollback'])
    expect(failure).toMatchObject({
      committed: false,
      outcome: 'unknown',
      errorCode: 'SERVER_OPS_DATA_WRITE_FAILED',
      statementCount: 1,
      affectedRows: 1,
    })
  })

  test('Given DDL 隐式提交后失败 When 执行 Then 不回滚且不谎称已回滚', async () => {
    const connection = createConnection([{ affectedRows: 0 }, new Error('boom')])
    const failure = await runServerOpsMySqlWriteScript(connection, plan('ALTER TABLE a ADD COLUMN n INT; UPDATE a SET n = 1'))
    /** DDL 已经落库，回滚不再代表整体未生效，因此连回滚语句都不发。 */
    expect(connection.calls).toEqual([
      'begin', 'query:ALTER TABLE a ADD COLUMN n INT', 'query:UPDATE a SET n = 1',
    ])
    expect(failure).toMatchObject({ outcome: 'partial', errorCode: 'SERVER_OPS_DATA_WRITE_FAILED', statementCount: 1 })
  })

  test('Given DDL 自身执行失败 When 执行 Then 执行前即按隐式提交边界处理且结果未知', async () => {
    const connection = createConnection([new Error('ddl failed')])
    const failure = await runServerOpsMySqlWriteScript(connection, plan('ALTER TABLE a ADD COLUMN n INT'))

    expect(connection.calls).toEqual(['begin', 'query:ALTER TABLE a ADD COLUMN n INT'])
    expect(failure).toMatchObject({ outcome: 'unknown', errorCode: 'SERVER_OPS_DATA_WRITE_FAILED', statementCount: 0 })
  })

  test('Given 成功脚本含 DDL When 执行 Then 如实警告这些改动无法回滚', async () => {
    const connection = createConnection([{ affectedRows: 0 }, { affectedRows: 4 }])
    const outcome = await runServerOpsMySqlWriteScript(connection, plan('TRUNCATE TABLE a; INSERT INTO a VALUES (1)'))
    expect(outcome.committed).toBe(true)
    expect(outcome.warnings.some((warning) => warning.includes('无法回滚'))).toBe(true)
  })

  test('Given 取消信号在开始前已触发 When 执行 Then 不开启事务也不触碰连接', async () => {
    const connection = createConnection([])
    const controller = new AbortController()
    controller.abort()
    const failure = await runServerOpsMySqlWriteScript(connection, plan('UPDATE a SET x = 1'), controller.signal)
    expect(connection.calls).toEqual([])
    expect(failure).toMatchObject({ outcome: 'not-started', errorCode: 'SERVER_OPS_DATA_WRITE_CANCELLED' })
  })

  test('Given MySQL 驱动调用在销毁后不结算 When 在途取消 Then 仍及时返回未知结果', async () => {
    const pending = new Promise<unknown>(() => undefined)
    const connection = createConnection([pending])
    const controller = new AbortController()
    const write = runServerOpsMySqlWriteScript(connection, plan('UPDATE a SET x = 1'), controller.signal)
    while (!connection.calls.some((call) => call.startsWith('query:'))) await Promise.resolve()
    controller.abort()

    const result = await Promise.race([
      write,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ])
    expect(result).not.toBe('hung')
    expect(result).toMatchObject({ outcome: 'unknown', errorCode: 'SERVER_OPS_DATA_WRITE_CANCELLED' })
  })

  test('Given 提交确认丢失 When 执行 Then 结果未知且不再用回滚覆盖提交事实', async () => {
    const connection = createConnection([{ affectedRows: 1 }], 'commit')
    const failure = await runServerOpsMySqlWriteScript(connection, plan('UPDATE a SET x = 1'))
    expect(connection.calls).toEqual(['begin', 'query:UPDATE a SET x = 1', 'commit'])
    expect(failure).toMatchObject({ outcome: 'unknown', errorCode: 'SERVER_OPS_DATA_WRITE_COMMIT_FAILED', statementCount: 1 })
  })

  test('Given 只读语句与写语句混排 When 执行 Then 只累计真实受影响行数', async () => {
    const connection = createConnection([{ affectedRows: 7 }, [{ id: 1 }, { id: 2 }]])
    const outcome = await runServerOpsMySqlWriteScript(connection, plan('UPDATE a SET x = 1; SELECT * FROM a'))
    expect(outcome.affectedRows).toBe(7)
    expect(outcome.statements).toEqual([
      { head: 'UPDATE', affectedRows: 7 },
      { head: 'SELECT', affectedRows: 0 },
    ])
  })
})
