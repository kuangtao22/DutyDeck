import { describe, expect, test } from 'bun:test'
import { LOCAL_MODEL_IPC_CHANNELS, type LocalModelSnapshot } from '@proma/shared'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerLocalModelIpcHandlers } from './local-model-ipc'
import type { LocalModelRuntime } from './local-model-runtime'

/** 以真实注册器和可观察 runtime 验证 IPC 边界，无需真实 Electron 窗口。 */
function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
  const operations: Array<{ method: string; input?: unknown }> = []
  const sent: unknown[] = []
  let publish: ((snapshot: LocalModelSnapshot) => void) | undefined
  let disposed = 0
  const runtime = {
    listSnapshot: () => ({ catalog: [], assets: [], runtime: { state: 'idle', endpointReady: false }, updatedAt: 1 }),
    subscribe: (listener: typeof publish) => { publish = listener; return () => { disposed++ } },
    subscribeProgress: () => () => { disposed++ },
    download: (input: unknown) => { operations.push({ method: 'download', input }) },
    cancelDownload: (input: unknown) => { operations.push({ method: 'cancel', input }) },
    start: (input: unknown) => { operations.push({ method: 'start', input }) },
    stop: () => { operations.push({ method: 'stop' }) },
    test: (input: unknown) => { operations.push({ method: 'test', input }) },
    setEnabled: (assetId: string, enabled: boolean) => { operations.push({ method: 'enable', input: { assetId, enabled } }) },
    downloadEngine: () => { operations.push({ method: 'engine-download' }) },
    cancelEngineDownload: () => { operations.push({ method: 'engine-cancel' }) },
  } as unknown as LocalModelRuntime
  const dispose = registerLocalModelIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } } as Pick<IpcMain, 'handle'>, {
    runtime,
    assertSender: (event) => { if (event.sender.id !== 7) throw new Error('未授权窗口') },
    listTargets: () => [{ isDestroyed: () => false, send: (_channel, value) => { sent.push(value) } }],
  })
  return {
    invoke: (channel: string, input?: unknown, sender = 7) => handlers.get(channel)!({ sender: { id: sender } } as IpcMainInvokeEvent, input),
    operations, sent, dispose, disposed: () => disposed,
    publish: (snapshot: LocalModelSnapshot) => publish?.(snapshot),
  }
}

describe('本地模型 IPC 授权与输入校验', () => {
  test('Given 辅助窗口 When 调用任意操作 Then 在触碰运行时前拒绝', () => {
    const f = fixture()
    for (const key of ['LIST', 'DOWNLOAD', 'CANCEL_DOWNLOAD', 'START', 'STOP', 'TEST', 'SET_ENABLED', 'ENGINE_DOWNLOAD', 'ENGINE_CANCEL_DOWNLOAD'] as const) {
      expect(() => f.invoke(LOCAL_MODEL_IPC_CHANNELS[key], key.startsWith('ENGINE_') ? undefined : { assetId: 'model', enabled: true, prompt: 'hi' }, 8)).toThrow('未授权')
    }
    expect(f.operations).toEqual([])
  })
  test('Given 主窗口的合法操作 When 调用 Then 使用窄DTO并强制完整能力探测', () => {
    const f = fixture()
    f.invoke(LOCAL_MODEL_IPC_CHANNELS.DOWNLOAD, { assetId: 'qwen-rev1' })
    f.invoke(LOCAL_MODEL_IPC_CHANNELS.TEST, { assetId: 'qwen-rev1', prompt: ' hi ', includeToolCall: false, includeJson: false })
    f.invoke(LOCAL_MODEL_IPC_CHANNELS.SET_ENABLED, { assetId: 'qwen-rev1', enabled: true })
    f.invoke(LOCAL_MODEL_IPC_CHANNELS.ENGINE_DOWNLOAD)
    f.invoke(LOCAL_MODEL_IPC_CHANNELS.ENGINE_CANCEL_DOWNLOAD)
    expect(f.operations).toEqual([
      { method: 'download', input: { assetId: 'qwen-rev1' } },
      { method: 'test', input: { assetId: 'qwen-rev1', prompt: 'hi', includeToolCall: true, includeJson: true } },
      { method: 'enable', input: { assetId: 'qwen-rev1', enabled: true } },
      { method: 'engine-download' },
      { method: 'engine-cancel' },
    ])
  })
  test('Given 越界或未知参数 When 请求 Then 全部拒绝且不执行副作用', () => {
    const f = fixture()
    for (const input of [null, {}, { assetId: '../model' }, { assetId: 'a/b' }, { assetId: 'ok', url: 'https://evil.test' }]) expect(() => f.invoke(LOCAL_MODEL_IPC_CHANNELS.DOWNLOAD, input)).toThrow()
    expect(() => f.invoke(LOCAL_MODEL_IPC_CHANNELS.SET_ENABLED, { assetId: 'ok', enabled: 'true' })).toThrow()
    expect(() => f.invoke(LOCAL_MODEL_IPC_CHANNELS.TEST, { assetId: 'ok', prompt: 'x'.repeat(4001) })).toThrow()
    expect(() => f.invoke(LOCAL_MODEL_IPC_CHANNELS.ENGINE_DOWNLOAD, { path: '/tmp/llama' })).toThrow()
    expect(f.operations).toEqual([])
  })
  test('Given 订阅 When 状态更新和注销 Then 广播真实快照并回收两个监听', () => {
    const f = fixture()
    const snapshot: LocalModelSnapshot = { catalog: [], assets: [], runtime: { state: 'idle', endpointReady: false }, updatedAt: 2 }
    f.publish(snapshot)
    expect(f.sent).toEqual([snapshot])
    f.dispose()
    expect(f.disposed()).toBe(2)
  })
})
