import { describe, expect, test } from 'bun:test'
import { getServerOpsDataWriteOutcome, parseServerOpsDataWriteInput, parseServerOpsDataWriteResult } from './server-ops-data-write'

/** 无业务数据的写入回执，供终态合同回归使用。 */
const receipt = { writeId: 'write-1', database: 'main', statementCount: 0, affectedRows: 0, committed: false, durationMs: 5, statements: [], warnings: [] }
/** 用户确认时看到的完整公开数据源快照。 */
const source = { id: 'source-1', transport: 'direct' as const, engine: 'mysql' as const, label: '业务库', address: 'db.internal', port: 3306, database: 'app', username: 'writer', tlsMode: 'required' as const, hasPassword: true, createdAt: 1, updatedAt: 2 }

describe('手工写入目标快照合同', () => {
  test('Given 完整公开快照 When 解析写入请求 Then 保留快照并要求 sourceId 一致', () => {
    const input = { sourceId: source.id, source, database: 'app', writeId: 'write-1', sql: 'UPDATE users SET active = 1' }
    expect(parseServerOpsDataWriteInput(input)).toEqual(input)
    expect(() => parseServerOpsDataWriteInput({ ...input, sourceId: 'source-other' }))
      .toThrow('SERVER_OPS_DATA_WRITE_INPUT_INVALID')
  })

  test('Given 缺少目标快照 When 解析写入请求 Then 拒绝无法绑定确认目标的旧请求', () => {
    expect(() => parseServerOpsDataWriteInput({ sourceId: source.id, database: 'app', writeId: 'write-1', sql: 'UPDATE users SET active = 1' }))
      .toThrow('SERVER_OPS_DATA_WRITE_INPUT_INVALID')
  })
})

describe('手工写入终态合同', () => {
  test('Given 结果未知 When 跨进程解析 Then 保留事实与稳定错误码', () => {
    expect(parseServerOpsDataWriteResult({ ...receipt, outcome: 'unknown', errorCode: 'SERVER_OPS_DATA_WRITE_OUTCOME_UNKNOWN' }))
      .toMatchObject({ outcome: 'unknown', committed: false, errorCode: 'SERVER_OPS_DATA_WRITE_OUTCOME_UNKNOWN' })
  })
  test('Given 旧版未提交回执 When 解释状态 Then 不能臆断已回滚', () => {
    expect(getServerOpsDataWriteOutcome(receipt)).toBe('unknown')
    expect(getServerOpsDataWriteOutcome({ ...receipt, committed: true })).toBe('committed')
  })
  test('Given 提交事实矛盾或错误码携带正文 When 解析 Then 拒绝污染结果', () => {
    expect(() => parseServerOpsDataWriteResult({ ...receipt, outcome: 'committed' })).toThrow()
    expect(() => parseServerOpsDataWriteResult({ ...receipt, committed: true, outcome: 'rolled-back' })).toThrow()
    expect(() => parseServerOpsDataWriteResult({ ...receipt, outcome: 'unknown', errorCode: 'private driver error' })).toThrow()
  })
})
