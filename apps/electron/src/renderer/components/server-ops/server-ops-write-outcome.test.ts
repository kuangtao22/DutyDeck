import { describe, expect, test } from 'bun:test'
import type { ServerOpsDataWriteOutcome, ServerOpsDataWriteResult } from '@proma/shared'
import { getServerOpsWriteOutcomePresentation, getServerOpsWriteResultError } from './server-ops-write-outcome'

/** 构造不含业务正文的最小写回执。 */
function createResult(outcome?: ServerOpsDataWriteOutcome): ServerOpsDataWriteResult {
  return {
    writeId: 'write-1', database: 'app', statementCount: 1, affectedRows: 1,
    committed: outcome === 'committed', ...(outcome === undefined ? {} : { outcome }),
    durationMs: 5, statements: [{ head: 'UPDATE', affectedRows: 1 }], warnings: [],
  }
}

describe('SQL 写入终态文案', () => {
  test('Given 五种数据库终态 When 转为界面文案 Then 不混淆提交回滚部分生效和未知', () => {
    expect(getServerOpsWriteOutcomePresentation(createResult('committed'))).toMatchObject({ label: '已提交', successful: true })
    expect(getServerOpsWriteOutcomePresentation(createResult('rolled-back'))).toMatchObject({ label: '已回滚', successful: false })
    expect(getServerOpsWriteOutcomePresentation(createResult('partial'))).toMatchObject({ label: '部分生效', successful: false })
    expect(getServerOpsWriteOutcomePresentation(createResult('unknown'))).toMatchObject({ label: '结果未知', successful: false })
    expect(getServerOpsWriteOutcomePresentation(createResult('not-started'))).toMatchObject({ label: '未开始', successful: false })
  })

  test('Given 旧回执 committed=false When 转为界面文案 Then 只能解释为未知', () => {
    const legacy = createResult()
    expect(getServerOpsWriteOutcomePresentation(legacy).label).toBe('结果未知')
    expect(getServerOpsWriteResultError(legacy)).toContain('无法确认')
  })

  test('Given 已回滚且只有通用失败码 When 生成错误 Then 不同时声称状态未知', () => {
    const result = { ...createResult('rolled-back'), errorCode: 'SERVER_OPS_DATA_WRITE_FAILED' }
    expect(getServerOpsWriteResultError(result)).toBe('写入失败；事务已回滚，数据未改变')
  })
})
