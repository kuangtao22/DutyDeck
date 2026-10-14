import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IpcMainInvokeEvent } from 'electron'
import { TOKEN_USAGE_IPC } from '@proma/shared'
import type { TokenUsageRecord } from '@proma/shared'
import { TokenUsageStore } from './token-usage-store'
import { registerTokenUsageIpc } from './token-usage-ipc'
import { createTokenUsagePreload } from '../../preload/token-usage-preload'

/** IPC 夹具只使用临时目录。 */
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
describe('Given Token 统计四层 IPC 合同', () => {
  test('When 导出筛选任务或打开已删除会话 Then 导出仅含匹配调用且历史仍可追溯', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-ipc-')); roots.push(root)
    const store = new TokenUsageStore(join(root, 'usage'))
    const timestamp = Date.parse('2026-10-13T10:00:00+08:00')
    const call: TokenUsageRecord = { id: 'a', taskId: 'agent:task', taskTitle: '历史任务', sessionId: 'deleted', sessionType: 'agent', projectId: 'p', projectName: '项目', channelId: 'c', channelName: '渠道', modelId: 'm', source: 'agent', startedAt: timestamp, finishedAt: timestamp + 1000, status: 'completed', origin: 'live', inputTokens: 8, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: null }
    store.record(call)
    store.record({ ...call, id: 'b', channelId: 'other', inputTokens: 100 })
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    let exported = ''
    registerTokenUsageIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, { getStore: () => store, getRoot: () => root, assertSender: () => {}, sessionExists: () => false, saveCsv: async csv => { exported = csv; return true } })
    const api = createTokenUsagePreload((channel, ...args) => Promise.resolve().then(() => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)))
    const query = { from: '2026-10-13', to: '2026-10-13', timeZone: 'Asia/Shanghai', channelId: 'c' }
    expect(await api.exportTokenUsage(query)).toEqual({ saved: true, count: 1 })
    expect(exported).toContain('"a"')
    expect(exported).not.toContain('"b"')
    const detail = await api.getTokenUsageTask(call.taskId, query)
    expect(detail?.task.sessionId).toBeUndefined()
    expect(detail?.matching.totalTokens).toBe(10)
    expect(detail?.task.totalTokens).toBe(112)
    expect(detail?.calls.map(record => record.matchesFilter).sort()).toEqual([false, true])
  })
  test('When 未授权 sender 或非法参数 Then 读盘前拒绝；空导出不打开对话框', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-ipc-')); roots.push(root)
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    let allowed = false
    let exports = 0
    const store = new TokenUsageStore(join(root, 'usage'))
    registerTokenUsageIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, { getStore: () => store, getRoot: () => root, assertSender: () => { if (!allowed) throw new Error('拒绝') }, saveCsv: async () => { exports += 1; return true } })
    const api = createTokenUsagePreload((channel, ...args) => Promise.resolve().then(() => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)))
    const query = { from: '2026-10-13', to: '2026-10-13', timeZone: 'Asia/Shanghai' }
    await expect(api.getTokenUsage(query)).rejects.toThrow('拒绝')
    allowed = true
    await expect(api.getTokenUsage({ ...query, from: '../bad' })).rejects.toThrow()
    expect((await api.getTokenUsage(query)).totals.calls).toBe(0)
    expect(await api.exportTokenUsage(query)).toEqual({ saved: false, count: 0 })
    expect(exports).toBe(0)
    expect(handlers.size).toBe(Object.keys(TOKEN_USAGE_IPC).length)
  })
  test('When 历史恢复耗时 Then 首次查询先返回当前账本而不被恢复阻塞', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-ipc-')); roots.push(root)
    const store = new TokenUsageStore(join(root, 'usage'))
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    let release: () => void = () => undefined
    let started = 0
    const importing = new Promise<void>((resolve) => { release = resolve })
    registerTokenUsageIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, {
      getStore: () => store,
      getRoot: () => root,
      assertSender: () => {},
      saveCsv: async () => true,
      importHistory: async () => { started += 1; await importing },
    } as unknown as Parameters<typeof registerTokenUsageIpc>[1])
    const api = createTokenUsagePreload((channel, ...args) => Promise.resolve().then(() => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)))
    const query = { from: '2026-10-13', to: '2026-10-13', timeZone: 'Asia/Shanghai' }
    const snapshot = await Promise.race([
      api.getTokenUsage(query),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('历史恢复阻塞了查询')), 100)),
    ])
    expect(started).toBe(1)
    expect(snapshot.coverage.historyImportedAt).toBeNull()
    release()
    await importing
  })
  test('When 历史恢复失败 Then 查询返回可见错误而不是永久加载', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-ipc-')); roots.push(root)
    const store = new TokenUsageStore(join(root, 'usage'))
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    registerTokenUsageIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, {
      getStore: () => store,
      getRoot: () => root,
      assertSender: () => {},
      saveCsv: async () => true,
      importHistory: async () => { throw new Error('历史文件不可读') },
    } as unknown as Parameters<typeof registerTokenUsageIpc>[1])
    const api = createTokenUsagePreload((channel, ...args) => Promise.resolve().then(() => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)))
    const query = { from: '2026-10-13', to: '2026-10-13', timeZone: 'Asia/Shanghai' }
    await api.getTokenUsage(query)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const retry = await api.getTokenUsage(query)
    expect(retry.coverage.historyImportError).toContain('历史文件不可读')
  })
})
