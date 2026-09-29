import { describe, expect, test } from 'bun:test'
import type { ServerOpsAuditAppendInput, ServerOpsAuditRecord, ServerOpsDataWriteResult } from '@proma/shared'
import { runAuditedServerOpsDataWrite } from './server-ops-query-audit'

/** 合成提交回执，审计测试不读取或修改数据库。 */
const receipt: ServerOpsDataWriteResult = { writeId: 'write-1', database: 'app', statementCount: 1, affectedRows: 1, committed: true, outcome: 'committed', durationMs: 1, statements: [{ head: 'UPDATE', affectedRows: 1 }], warnings: [] }

describe('写入审计服从数据库结果', () => {
  test('Given 提交完成后才取消 When 记录结果 Then 保留成功且不得追加错误审计', async () => {
    let cancelled = false
    const records: ServerOpsAuditAppendInput[] = []
    const result = await runAuditedServerOpsDataWrite({
      actor: { actor: 'user', windowId: 7 }, summary: { sourceId: 'db-1', database: 'app' },
      check: () => { if (cancelled) throw new Error('SERVER_OPS_DATA_WRITE_CANCELLED') },
      audit: { append: (record) => { records.push(record); return record as ServerOpsAuditRecord } },
      execute: async () => { cancelled = true; return receipt },
    })
    expect(result.committed).toBe(true)
    expect(records.map((record) => record.outcome)).toEqual(['pending', 'success'])
  })
  test('Given 执行器返回已回滚的失败结果 When 记录审计 Then 不误记为成功', async () => {
    const records: ServerOpsAuditAppendInput[] = []
    const result = await runAuditedServerOpsDataWrite({
      actor: { actor: 'user', windowId: 7 }, summary: { sourceId: 'db-1', database: 'app' }, check: () => {},
      audit: { append: (record) => { records.push(record); return record as ServerOpsAuditRecord } },
      execute: async () => ({ ...receipt, committed: false, outcome: 'rolled-back' as const, errorCode: 'SERVER_OPS_DATA_WRITE_FAILED' }),
    })
    expect(result.outcome).toBe('rolled-back')
    expect(records.at(-1)).toMatchObject({ outcome: 'error', errorCode: 'SERVER_OPS_DATA_WRITE_FAILED' })
  })

  test('Given 写入终态可能未知或部分生效 When 记录审计 Then 保留未知而不伪装成普通错误', async () => {
    for (const outcome of ['unknown', 'partial'] as const) {
      const records: ServerOpsAuditAppendInput[] = []
      const errorCode = outcome === 'unknown' ? 'SERVER_OPS_DATA_WRITE_OUTCOME_UNKNOWN' : 'SERVER_OPS_DATA_WRITE_PARTIAL'
      const result = await runAuditedServerOpsDataWrite({
        actor: { actor: 'user', windowId: 7 }, summary: { sourceId: 'db-1', database: 'app' }, check: () => {},
        audit: { append: (record) => { records.push(record); return record as ServerOpsAuditRecord } },
        execute: async () => ({ ...receipt, committed: false, outcome, errorCode }),
      })
      expect(result.outcome).toBe(outcome)
      expect(records.at(-1)).toMatchObject({ outcome: 'unknown', errorCode })
    }
  })

  test('Given 写入明确未开始或已经回滚 When 记录审计 Then 归类为错误', async () => {
    for (const outcome of ['not-started', 'rolled-back'] as const) {
      const records: ServerOpsAuditAppendInput[] = []
      const errorCode = outcome === 'not-started' ? 'SERVER_OPS_SQL_STATEMENT_REJECTED' : 'SERVER_OPS_DATA_WRITE_FAILED'
      await runAuditedServerOpsDataWrite({
        actor: { actor: 'user', windowId: 7 }, summary: { sourceId: 'db-1', database: 'app' }, check: () => {},
        audit: { append: (record) => { records.push(record); return record as ServerOpsAuditRecord } },
        execute: async () => ({ ...receipt, committed: false, outcome, errorCode }),
      })
      expect(records.at(-1)).toMatchObject({ outcome: 'error', errorCode })
    }
  })

  test('Given 执行器抛出但没有事务终态 When 记录审计 Then 结果归类为未知', async () => {
    const records: ServerOpsAuditAppendInput[] = []
    await expect(runAuditedServerOpsDataWrite({
      actor: { actor: 'user', windowId: 7 }, summary: { sourceId: 'db-1', database: 'app' }, check: () => {},
      audit: { append: (record) => { records.push(record); return record as ServerOpsAuditRecord } },
      execute: async () => { throw new Error('SERVER_OPS_DATA_WRITE_TIMEOUT') },
    })).rejects.toThrow('SERVER_OPS_DATA_WRITE_TIMEOUT')
    expect(records.at(-1)).toMatchObject({ outcome: 'unknown', errorCode: 'SERVER_OPS_DATA_WRITE_TIMEOUT' })
  })
})
