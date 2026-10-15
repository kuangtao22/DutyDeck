import { describe, expect, it } from 'bun:test'
import { normalizePiTokenUsage, createTokenUsageObserver } from './token-usage-observer'
import type { TokenUsageRecord } from '@proma/shared'

describe('模型调用统计观察器', () => {
  it('Given Pi 分离缓存 When 归一化 Then 输入包含缓存且未报告保持未知', () => {
    expect(normalizePiTokenUsage({ input: 10, output: 2, cacheRead: 30, cacheWrite: 4 })).toEqual({ inputTokens: 44, outputTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 4 })
    expect(normalizePiTokenUsage({ input: 0, output: 0, reported: false })).toBeNull()
    expect(normalizePiTokenUsage({ input: 0, output: 0 }, 'failed')).toBeNull()
    expect(normalizePiTokenUsage({ input: 0, output: 0, reported: true }, 'failed')?.inputTokens).toBe(0)
  })
  it('Given 父子共用根任务 When 失败重试成功取消 Then 每次尝试独立计数且不改变归属', () => {
    /** 内存账本代替真实磁盘数据。 */
    const records: TokenUsageRecord[] = []
    /** 固定来源快照，不从后续会话变更推测归属。 */
    const observer = createTokenUsageObserver({ taskId: 'agent:root', taskTitle: '根任务', sessionId: 'child', sessionType: 'agent', projectId: 'p', projectName: '项目', channelId: 'c', channelName: '渠道', modelId: 'm', source: 'delegation' }, (record) => records.push(record))
    observer(null, 'failed')
    observer({ inputTokens: 12, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: null }, 'completed')
    observer(null, 'cancelled')
    expect(records.map((record) => record.status)).toEqual(['failed', 'completed', 'cancelled'])
    expect(new Set(records.map((record) => record.id)).size).toBe(3)
    expect(records.every((record) => record.taskId === 'agent:root' && record.sessionId === 'child')).toBe(true)
    expect(records[0]?.inputTokens).toBeNull()
  })
  it('Given 账本失败 When 观察用量 Then 不抛异常改变业务结果', () => {
    /** 模拟不可写磁盘的失败观察端。 */
    const observer = createTokenUsageObserver({ taskId: 'chat:c', taskTitle: '测试', projectId: null, projectName: '未关联项目', channelId: null, channelName: '渠道', modelId: 'm', source: 'chat' }, () => { throw new Error('disk') })
    expect(() => observer(null, 'completed')).not.toThrow()
  })
})

it('Given 多轮工具等待跨午夜 When 第二请求携带实际时间 Then 按第二天开始统计而非上轮结束', () => {
  /** 固定自然日边界与实际模型调用时间，工具等待不应归入耗时或前一天。 */
  const beforeMidnight = Date.parse('2026-10-13T23:59:00+08:00')
  const afterMidnight = Date.parse('2026-10-14T00:05:00+08:00')
  const records: TokenUsageRecord[] = []
  const observer = createTokenUsageObserver({ taskId: 'agent:root', taskTitle: '任务', projectId: null, projectName: '未关联项目', channelId: 'c', channelName: '渠道', modelId: 'm', source: 'agent' }, (record) => records.push(record))
  observer(null, 'completed', { startedAt: beforeMidnight, finishedAt: beforeMidnight + 1000 })
  observer(null, 'completed', { startedAt: afterMidnight, finishedAt: afterMidnight + 2000 })
  expect(records[0]?.startedAt).toBe(beforeMidnight)
  expect(records[1]?.startedAt).toBe(afterMidnight)
  expect(records[1]?.finishedAt).toBe(afterMidnight + 2000)
  expect(records[1]!.finishedAt - records[1]!.startedAt).toBe(2000)
})
