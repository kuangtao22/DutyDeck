import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TokenUsageStore } from './token-usage-store'
import { boundedHistoryLines, importTokenUsageHistory } from './token-usage-history'

/** 隔离数据根，绝不修改实际 session。 */
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
/** 用量报告夹具，输入与缓存在 Pi 协议中独立。 */
function entry(id: string, timestamp: number, usage: object): object {
  return { id, type: 'message', timestamp: new Date(timestamp).toISOString(), message: { role: 'assistant', model: 'gpt', timestamp, usage, stopReason: 'stop' } }
}
describe('Given 旧 Pi 会话有可验证时间与供应商用量', () => {
  test('When 正文单行超过预算 Then 丢弃到下一行并继续恢复完整UTF8记录', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-history-')); roots.push(root)
    const file = join(root, 'large.jsonl')
    writeFileSync(file, '中'.repeat(1024 * 1024) + '\n' + JSON.stringify({ text: '正常记录' }) + '\n')
    const lines: Array<string | null> = []
    for await (const line of boundedHistoryLines(file)) lines.push(line)
    expect(lines).toEqual([null, JSON.stringify({ text: '正常记录' })])
  })
  test('When 恢复复制分支与缺失报告 Then 去重且不猜历史渠道项目', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-history-'))
    roots.push(root)
    const file = join(root, 'pi.jsonl')
    const timestamp = Date.parse('2026-10-01T00:00:00Z')
    writeFileSync(file, [entry('a', timestamp, { input: 100, output: 10, cacheRead: 30, cacheWrite: 2 }), entry('a', timestamp + 60000, { input: 9, output: 3 }), entry('b', timestamp, { reported: false, input: 0, output: 0 }), entry('new', Date.now() + 100000, { input: 1, output: 1 })].map(value => JSON.stringify(value)).join('\n'))
    writeFileSync(join(root, 'agent-sessions.json'), JSON.stringify({ sessions: [{ id: 's', title: '任务', channelId: 'now-channel', workspaceId: 'now-project', piSessionFile: file }, { id: 'fork', title: '复制分支', piSessionFile: file }] }))
    const ledger = new TokenUsageStore(join(root, 'token-usage'))
    await importTokenUsageHistory(root, ledger)
    const records = ledger.read()
    expect(records).toHaveLength(2)
    expect(records.find(record => record.inputTokens === 132)).toMatchObject({ inputTokens: 132, outputTokens: 10, channelId: null, projectId: null, origin: 'history' })
    await importTokenUsageHistory(root, ledger)
    expect(ledger.read()).toHaveLength(2)
    expect(ledger.coverage().historyRecords).toBe(2)
  })
  test('When 元数据指向数据根外或文件损坏 Then 跳过并公开覆盖缺口', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-history-'))
    roots.push(root)
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'broken.jsonl'), '{broken}')
    writeFileSync(join(root, 'agent-sessions.json'), JSON.stringify({ sessions: [{ id: 'x', title: '外部', piSessionFile: '/outside.jsonl' }, { id: 'b', title: '坏记录', piSessionFile: join(root, 'broken.jsonl') }] }))
    const ledger = new TokenUsageStore(join(root, 'token-usage'))
    await importTokenUsageHistory(root, ledger)
    expect(ledger.read()).toHaveLength(0)
    expect(ledger.coverage().notes.join(' ')).toContain('跳过')
  })
})
