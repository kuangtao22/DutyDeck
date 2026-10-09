import { describe, expect, test } from 'bun:test'
import { parseServerOpsRedisCommandInput, parseServerOpsRedisCommandResult } from './server-ops-redis'

describe('Redis 单键命令合同', () => {
  test('Given 单键读写 When 按工具能力解析 Then 严格分离读写', () => {
    expect(parseServerOpsRedisCommandInput({ sourceId: 'redis-1', command: 'get', args: ['key'] }, 'read').command).toBe('GET')
    expect(parseServerOpsRedisCommandInput({ sourceId: 'redis-1', command: 'SET', args: ['key', 'value', 'EX', '60'] }, 'write').args).toEqual(['key', 'value', 'EX', '60'])
    expect(() => parseServerOpsRedisCommandInput({ sourceId: 'redis-1', command: 'SET', args: ['key', 'value'] }, 'read')).toThrow()
    expect(() => parseServerOpsRedisCommandInput({ sourceId: 'redis-1', command: 'GET', args: ['key'] }, 'write')).toThrow()
  })
  test('Given 脚本/管理/多键/额外字段/无界读取 When 解析 Then 无法到达驱动', () => {
    for (const input of [
      { command: 'EVAL', args: ['return 1', '0'] }, { command: 'FLUSHDB', args: [] },
      { command: 'SELECT', args: ['2'] }, { command: 'HGETALL', args: ['key'] },
      { command: 'DEL', args: ['one', 'two'] }, { command: 'SET', args: ['key', 'value', 'GET'] },
      { command: 'EXPIRE', args: ['key', '-1'] }, { command: 'ZADD', args: ['key', 'NaN', 'm'] },
      { command: 'GETRANGE', args: ['key', '0', '99999999'] },
      { command: 'SET', args: ['key', 'a'.repeat(70_000)] },
      { command: 'GET', args: ['key'], database: '9' },
    ]) expect(() => parseServerOpsRedisCommandInput({ sourceId: 'redis-1', ...input })).toThrow()
  })
  test('Given 不确定写回执 When 解析 Then 不携带值且拒绝错误正文', () => {
    expect(parseServerOpsRedisCommandResult({ command: 'SET', outcome: 'unknown', value: null, truncated: false, durationMs: 1, errorCode: 'SERVER_OPS_REDIS_OUTCOME_UNKNOWN' }).outcome).toBe('unknown')
    expect(() => parseServerOpsRedisCommandResult({ command: 'SET', outcome: 'unknown', value: 'OK', truncated: false, durationMs: 1 })).toThrow()
  })
})
