import { describe, expect, test } from 'bun:test'
import { describeServerOpsApproval } from './server-ops-approval-view'

describe('运维写入审批卡展示', () => {
  test('Given Agent 请求数据库写入 When 生成审批视图 Then 展示目标、完整 SQL 和中文注意事项', () => {
    const view = describeServerOpsApproval('ops_database_write', {
      sourceId: 'source-1', database: 'app', sql: 'UPDATE users SET active = 0 WHERE id = 7',
    }, '数据库写入需要确认', '目标：业务主库 · 127.0.0.1:3306 · 数据库 app\n注意：MySQL DDL 可能隐式提交。')

    expect(view).not.toBeNull()
    expect(view?.title).toBe('数据库写入需要确认')
    expect(view?.details.join('\n')).toContain('目标：业务主库')
    expect(view?.sql).toBe('UPDATE users SET active = 0 WHERE id = 7')
    expect(view?.warnings.join('\n')).toContain('MySQL DDL 可能隐式提交')
  })

  test('Given Agent 请求 Redis 写入 When 生成审批视图 Then 展示命令参数并明确仅本次确认', () => {
    const view = describeServerOpsApproval('ops_redis_write', {
      sourceId: 'redis-1', command: 'SET', args: ['feature:enabled', '1', 'EX', '60'],
    }, undefined, undefined)

    expect(view).toMatchObject({
      title: 'Redis 写入需要确认',
      operation: 'SET feature:enabled 1 EX 60',
    })
    expect(view?.warnings.join('\n')).toContain('只批准本次 Redis 写入')
  })

  test('Given 非写入工具 When 生成审批视图 Then 不改变通用权限卡', () => {
    expect(describeServerOpsApproval('ops_database_query', { sourceId: 'source-1' }, undefined, undefined)).toBeNull()
  })
})
