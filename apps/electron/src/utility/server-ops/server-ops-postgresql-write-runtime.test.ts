import { describe, expect, test } from 'bun:test'
import type { ServerOpsPostgresqlClient } from './server-ops-postgresql-adapter'
import { runServerOpsPostgresqlWriteScript } from './server-ops-postgresql-write-runtime'

/** 生成 PostgreSQL 写计划，避免测试正文重复拼接。 */
function plan(sql: string, head = 'UPDATE'): Array<{ text: string; head: string }> {
  return sql.split(';').filter(Boolean).map((text, index) => ({ text: text.trim(), head: index === 0 ? head : 'INSERT' }))
}

/** 生成可记录 SQL 调用的 PostgreSQL 客户端替身。 */
function createClient(options: { failOn?: string; commitFails?: boolean } = {}): { client: ServerOpsPostgresqlClient; statements: string[] } {
  const statements: string[] = []
  const client: ServerOpsPostgresqlClient = {
    query: async (text) => {
      statements.push(text)
      if (options.failOn === text) throw Object.assign(new Error('permission'), { code: '42501' })
      if (options.commitFails && text === 'COMMIT') throw new Error('connection lost')
      return { rows: [], rowCount: text.startsWith('UPDATE') ? 2 : text.startsWith('INSERT') ? 1 : 0 }
    },
    end: async () => undefined,
  }
  return { client, statements }
}

describe('PostgreSQL 写脚本执行', () => {
  test('Given 多条 DML When 全部成功 Then 在 PostgreSQL 事务中提交并累计 rowCount', async () => {
    const harness = createClient()
    const result = await runServerOpsPostgresqlWriteScript(harness.client, plan('UPDATE users SET active = true; INSERT INTO audit VALUES (1)'))
    expect(result).toMatchObject({ committed: true, outcome: 'committed', statementCount: 2, affectedRows: 3 })
    expect(harness.statements).toEqual(['BEGIN', 'UPDATE users SET active = true', 'INSERT INTO audit VALUES (1)', 'COMMIT'])
  })

  test('Given 语句权限失败 When 执行 Then 等待回滚并返回稳定权限码', async () => {
    const harness = createClient({ failOn: 'UPDATE users SET active = true' })
    const result = await runServerOpsPostgresqlWriteScript(harness.client, plan('UPDATE users SET active = true'))
    expect(result).toMatchObject({ committed: false, outcome: 'unknown', errorCode: 'SERVER_OPS_DATA_WRITE_PERMISSION_DENIED' })
    expect(harness.statements).toEqual(['BEGIN', 'UPDATE users SET active = true', 'ROLLBACK'])
  })

  test('Given COMMIT 确认丢失 When 事务已执行 Then 返回 unknown 且不自动回滚', async () => {
    const harness = createClient({ commitFails: true })
    const result = await runServerOpsPostgresqlWriteScript(harness.client, plan('UPDATE users SET active = true'))
    expect(result).toMatchObject({ committed: false, outcome: 'unknown', errorCode: 'SERVER_OPS_DATA_WRITE_COMMIT_FAILED' })
    expect(harness.statements).toEqual(['BEGIN', 'UPDATE users SET active = true', 'COMMIT'])
  })

  test('Given 取消信号在事务中触发 When 当前语句未结束 Then 返回未知且尽力回滚', async () => {
    const controller = new AbortController()
    const statements: string[] = []
    let resolveUpdate: (() => void) | undefined
    const client: ServerOpsPostgresqlClient = {
      query: async (text) => {
        statements.push(text)
        if (text === 'UPDATE users SET active = true') {
          await new Promise<void>((resolve) => { resolveUpdate = resolve })
        }
        return { rows: [], rowCount: 1 }
      },
      end: async () => undefined,
    }
    const running = runServerOpsPostgresqlWriteScript(client, plan('UPDATE users SET active = true'), controller.signal)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    controller.abort()
    resolveUpdate?.()
    const result = await running
    expect(result).toMatchObject({ committed: false, outcome: 'unknown', errorCode: 'SERVER_OPS_DATA_WRITE_CANCELLED' })
    expect(statements).toContain('ROLLBACK')
  })
})
