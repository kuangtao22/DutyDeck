import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TokenUsageQuery, TokenUsageRecord } from '@proma/shared'
import { TokenUsageStore } from './token-usage-store'
import { aggregateTokenUsage, tokenUsageCsv, validateTokenUsageQuery } from './token-usage-query'

/** 所有测试仅使用临时目录，不打开真实业务数据根。 */
const directories: string[] = []
/** 基准查询覆盖跨 UTC 午夜的上海自然日。 */
const query: TokenUsageQuery = { from: '2026-10-13', to: '2026-10-13', timeZone: 'Asia/Shanghai' }
/** 创建可覆盖的供应商调用快照。 */
function call(overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
  return { id: 'call-a', taskId: 'agent:root', taskTitle: '修复界面', sessionId: 'child', sessionType: 'agent', projectId: 'p', projectName: '项目', channelId: 'c', channelName: '渠道', modelId: 'model', source: 'agent', startedAt: Date.parse('2026-10-12T18:00:00Z'), finishedAt: Date.parse('2026-10-12T18:01:00Z'), inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10, status: 'completed', origin: 'live', ...overrides }
}
/** 创建本测试独占账本。 */
function store(): TokenUsageStore {
  const directory = mkdtempSync(join(tmpdir(), 'token-usage-'))
  directories.push(directory)
  return new TokenUsageStore(directory, () => Date.parse('2026-10-13T00:00:00Z'))
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('Given 独立本地 Token 账本', () => {
  test('When 同一调用重放且重启 Then 只累计一次，缓存不重复相加', () => {
    const ledger = store()
    ledger.record(call())
    ledger.record(call())
    const restarted = new TokenUsageStore(directories[0]!)
    const snapshot = aggregateTokenUsage(restarted.read(query), query, restarted.coverage())
    expect(snapshot.totals).toMatchObject({ calls: 1, totalTokens: 120, inputTokens: 100, cacheReadTokens: 40, knownCalls: 1 })
  })
  test('When 用量为零、部分未知、失败未知 Then 保留不同语义并按根任务汇总', () => {
    const ledger = store()
    ledger.record(call({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
    ledger.record(call({ id: 'b', source: 'delegation', inputTokens: null, outputTokens: 7, cacheReadTokens: null, cacheWriteTokens: null }))
    ledger.record(call({ id: 'c', status: 'failed', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }))
    const snapshot = aggregateTokenUsage(ledger.read(query), query, ledger.coverage())
    expect(snapshot.totals).toMatchObject({ calls: 3, knownCalls: 1, partialCalls: 1, unknownCalls: 1, totalTokens: 7 })
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.tasks[0]?.calls).toBe(3)
    expect(tokenUsageCsv(ledger.read(query))).toContain('\"\",\"\",\"\"')
  })
  test('When 过滤渠道及未知任务 Then 同任务只汇总匹配调用且CSV不伪造零', () => {
    const records = [call(), call({ id: 'b', channelId: 'other', inputTokens: null, outputTokens: null }), call({ id: 'c', taskId: 'else', taskTitle: '=SUM(A1)', inputTokens: null, outputTokens: null })]
    const result = aggregateTokenUsage(records, { ...query, channelId: 'c', unknownOnly: true }, store().coverage())
    expect(result.totals.calls).toBe(2)
    expect(result.tasks.map(task => task.id)).toEqual(['else'])
    expect(tokenUsageCsv([records[2]!])).toContain("'=SUM(A1)")
  })
  test('When 分片损坏 Then 明确失败而非返回假空统计', () => {
    const ledger = store()
    ledger.record(call())
    const day = join(directories[0]!, '2026-10-12')
    const file = readdirSync(day).find(name => name.endsWith('.json'))!
    writeFileSync(join(day, file), 'broken')
    expect(() => new TokenUsageStore(directories[0]!).read(query)).toThrow()
  })
  test('When 非法用量写入 Then 拒绝负数和非整数', () => {
    const ledger = store()
    expect(() => ledger.record(call({ inputTokens: -1 }))).toThrow()
    expect(() => ledger.record(call({ inputTokens: 0.5 }))).toThrow()
  })
  test('When 其他日期的无关任务分片损坏 Then 当前任务详情仍仅读取自己的分片', () => {
    const ledger = store()
    ledger.record(call())
    ledger.record(call({ id: 'old', taskId: 'unrelated', startedAt: Date.parse('2026-01-01'), finishedAt: Date.parse('2026-01-01') }))
    const oldDay = join(directories[0]!, '2026-01-01')
    writeFileSync(join(oldDay, readdirSync(oldDay).find(name => name.endsWith('.json'))!), 'broken')
    expect(ledger.readTask('agent:root').map(record => record.id)).toEqual(['call-a'])
  })
})

describe('Given 跨时区日期与 IPC 查询', () => {
  test('When 历史归属未知与新调用未关联项目同时存在 Then 来源不混为同一项目', () => {
    const records = [call({ projectId: null, projectName: '未关联项目' }), call({ id: 'history', origin: 'history', projectId: null, projectName: '历史项目未知' })]
    const result = aggregateTokenUsage(records, query, store().coverage())
    expect(result.ranking.project.map(item => item.name).sort()).toEqual(['历史项目未知', '未关联项目'].sort())
    expect(aggregateTokenUsage(records, { ...query, projectId: '__history_unknown__' }, store().coverage()).totals.calls).toBe(1)
  })
  test('When 本地日期与UTC不同 Then 按本地自然日筛选并补齐空日期', () => {
    const ledger = store()
    ledger.record(call())
    const result = aggregateTokenUsage(ledger.read(query), { ...query, to: '2026-10-14' }, ledger.coverage())
    expect(result.trend.map(day => [day.day, day.calls])).toEqual([['2026-10-13', 1], ['2026-10-14', 0]])
  })
  test('When 日期、时区、分页或额外字段无效 Then 在读盘前拒绝', () => {
    for (const invalid of [{ ...query, from: '2026-02-31' }, { ...query, timeZone: '../x' }, { ...query, page: -1 }, { ...query, pageSize: 1001 }, { ...query, path: '/tmp/x' }, { ...query, from: '2000-01-01' }]) expect(() => validateTokenUsageQuery(invalid)).toThrow()
    expect(validateTokenUsageQuery(query)).toMatchObject(query)
  })
})
