import { describe, expect, test } from 'bun:test'
import {
  SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS,
  SERVER_OPS_DATA_QUERY_HISTORY_LIMIT,
  parseServerOpsDataQueryHistoryRecordInput,
  parseServerOpsDataQueryHistoryResult,
  parseServerOpsDataQueryHistoryScope,
} from './server-ops-data-query-history'

describe('数据源 SQL 查询历史公开合同', () => {
  test('Given 主进程写入历史 When 跨 IPC 解析 Then 保留运行事实且拒绝客户端伪造与错配回执', () => {
    /** 固定运行身份，用于验证每次执行的字段绑定。 */
    const execution = {
      writeId: 'write-1', startedAt: 10, finishedAt: 20,
      result: { writeId: 'write-1', database: 'app', statementCount: 1, affectedRows: 3,
        committed: true, outcome: 'committed' as const, durationMs: 10,
        statements: [{ head: 'UPDATE', affectedRows: 3 }], warnings: [] },
    }
    /** 旧 SQL 条目仍可解析，新字段只允许出现在主进程返回值。 */
    const entry = { id: 'history-1', sourceId: 'source-1', database: 'app', sql: 'UPDATE t SET n = 1', createdAt: 10 }
    expect(parseServerOpsDataQueryHistoryResult({ entries: [{ ...entry, execution }] }).entries[0]?.execution).toEqual(execution)
    expect(() => parseServerOpsDataQueryHistoryRecordInput({ sourceId: entry.sourceId, database: entry.database, sql: entry.sql, execution }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RECORD_INVALID')
    for (const invalidExecution of [
      { ...execution, finishedAt: 9 },
      { ...execution, finishedAt: undefined },
      { ...execution, result: undefined },
      { ...execution, result: { ...execution.result, database: 'other' } },
      { ...execution, result: { ...execution.result, writeId: 'write-other' } },
    ]) {
      expect(() => parseServerOpsDataQueryHistoryResult({ entries: [{ ...entry, execution: invalidExecution }] }))
        .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
    }
    expect(parseServerOpsDataQueryHistoryResult({ entries: [{ ...entry, execution: { writeId: execution.writeId, startedAt: 10 } }] }).entries[0]?.execution?.result).toBeUndefined()
  })

  test('Given 合法 scope、记录与结果 When 解析 Then 保留原始 SQL 并暴露稳定通道', () => {
    expect(SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS).toEqual({
      LIST: 'server-ops:data-query-history-list',
      SAVE: 'server-ops:data-query-history-save',
    })
    expect(SERVER_OPS_DATA_QUERY_HISTORY_LIMIT).toBe(100)
    expect(parseServerOpsDataQueryHistoryScope({ sourceId: 'source-1', database: 'app' }))
      .toEqual({ sourceId: 'source-1', database: 'app' })
    const sql = '  SELECT id\nFROM users  '
    expect(parseServerOpsDataQueryHistoryRecordInput({ sourceId: 'source-1', database: 'app', sql }))
      .toEqual({ sourceId: 'source-1', database: 'app', sql })
    expect(parseServerOpsDataQueryHistoryResult({ entries: [{
      id: 'history-1', sourceId: 'source-1', database: 'app', sql, createdAt: 1,
    }] })).toEqual({ entries: [{ id: 'history-1', sourceId: 'source-1', database: 'app', sql, createdAt: 1 }] })
  })

  test('Given 未知字段、空 SQL、NUL 或超过 16 KiB When 解析 Then 稳定拒绝', () => {
    expect(() => parseServerOpsDataQueryHistoryScope({ sourceId: 'source-1', database: 'app', extra: true }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_SCOPE_INVALID')
    expect(() => parseServerOpsDataQueryHistoryRecordInput({ sourceId: 'source-1', database: 'app', sql: '   ' }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RECORD_INVALID')
    expect(() => parseServerOpsDataQueryHistoryRecordInput({ sourceId: 'source-1', database: 'app', sql: 'SELECT\u0000 1' }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RECORD_INVALID')
    expect(() => parseServerOpsDataQueryHistoryRecordInput({
      sourceId: 'source-1', database: 'app', sql: `SELECT '${'你'.repeat(5_462)}'`,
    })).toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RECORD_INVALID')
  })

  test('Given 结果未知字段、重复 ID、越界条数或非法时间 When 解析 Then 拒绝整个结果', () => {
    const entry = { id: 'history-1', sourceId: 'source-1', database: 'app', sql: 'SELECT 1', createdAt: 1 }
    expect(() => parseServerOpsDataQueryHistoryResult({ entries: [{ ...entry, extra: true }] }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
    expect(() => parseServerOpsDataQueryHistoryResult({ entries: [entry, entry] }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
    expect(() => parseServerOpsDataQueryHistoryResult({ entries: Array.from({ length: 101 }, (_, index) => ({ ...entry, id: `history-${index}` })) }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
    expect(() => parseServerOpsDataQueryHistoryResult({ entries: [{ ...entry, createdAt: -1 }] }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
    expect(() => parseServerOpsDataQueryHistoryResult({ entries: [{ ...entry, createdAt: 8_640_000_000_000_001 }] }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
  })
})
