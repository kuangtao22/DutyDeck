import { afterEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { LocalModelAsset, LocalModelSnapshot, LocalModelTestInput } from '@proma/shared'
import { acceptLocalModelSnapshotAtom, localModelErrorsAtom, localModelPendingAtom, localModelPromptAtom, localModelSnapshotAtom, localModelTestResultsAtom, performLocalModelActionAtom } from './local-model-atoms'

/** 每个用例隔离全局 bridge，防止影响其他 renderer 测试。 */
const originalWindow = globalThis.window
afterEach(() => { globalThis.window = originalWindow })
/** 测试模型与主进程状态。 */
function setup() {
  const store = createStore()
  const asset: LocalModelAsset = { assetId: 'qwen', modelId: 'qwen', name: 'Qwen', family: 'qwen', revision: 'r1', fileName: 'qwen.gguf', sha256: 'sha', sizeBytes: 1, status: 'installed', enabled: false, capability: { state: 'unknown' }, installedAt: 1, updatedAt: 1 }
  const snapshot: LocalModelSnapshot = { catalog: [], assets: [asset], runtime: { state: 'running', assetId: asset.assetId, endpointReady: true }, updatedAt: 1 }
  const calls: string[] = []
  const api = {
    listLocalModels: async () => snapshot,
    downloadLocalModelEngine: async (): Promise<void> => {},
    cancelLocalModelEngineDownload: async (): Promise<void> => { calls.push('engine-cancel') },
    downloadLocalModel: async () => asset,
    cancelLocalModelDownload: async () => { calls.push('cancel') },
    startLocalModel: async () => snapshot.runtime,
    stopLocalModel: async () => { calls.push('stop') },
    testLocalModel: async (input: LocalModelTestInput) => { calls.push(input.prompt); return { success: true, assetId: asset.assetId, message: '通过', reply: '真实回复', toolCallSupported: true, jsonSupported: true, capability: { state: 'available' as const } } },
    setLocalModelEnabled: async () => { calls.push('enable'); return asset },
  }
  globalThis.window = { electronAPI: api } as unknown as Window & typeof globalThis
  store.set(acceptLocalModelSnapshotAtom, snapshot)
  return { store, asset, snapshot, calls, api }
}

describe('本地模型 Jotai 真实操作回归', () => {
  test('Given 编辑提示词 When 点击发送测试 Then 传入草稿并保留回复且不启用', async () => {
    const { store, calls } = setup()
    store.set(localModelPromptAtom, '我的测试提示词')
    await store.set(performLocalModelActionAtom, { assetId: 'qwen', action: 'test' })
    expect(calls).toEqual(['我的测试提示词'])
    expect(store.get(localModelTestResultsAtom).qwen?.reply).toBe('真实回复')
    expect(store.get(localModelSnapshotAtom)?.assets[0]?.enabled).toBe(false)
  })
  test('Given 下载在途 When 点击取消 Then 立即发送取消而不等待下载 promise', async () => {
    const { store, api, asset, calls } = setup()
    let finish!: (asset: LocalModelAsset) => void
    api.downloadLocalModel = () => new Promise((resolve) => { finish = resolve })
    const downloading = store.set(performLocalModelActionAtom, { assetId: 'qwen', action: 'download' })
    expect(store.get(localModelPendingAtom).qwen).toBe('download')
    await store.set(performLocalModelActionAtom, { assetId: 'qwen', action: 'cancel' })
    expect(calls).toEqual(['cancel'])
    finish(asset)
    await downloading
    expect(store.get(localModelPendingAtom).qwen).toBeUndefined()
  })
  test('Given 引擎下载未结束 When 连续取消 Then 独立发送一次取消并保留下载状态', async () => {
    const { store, api, calls } = setup()
    // 下载与取消分别受控，验证两条请求不互相阻塞。
    let finishDownload!: () => void
    let finishCancel!: () => void
    api.downloadLocalModelEngine = () => new Promise<void>((resolve) => { finishDownload = resolve })
    api.cancelLocalModelEngineDownload = () => {
      calls.push('engine-cancel')
      return new Promise<void>((resolve) => { finishCancel = resolve })
    }
    const downloading = store.set(performLocalModelActionAtom, { action: 'engine-download' })
    const cancelling = store.set(performLocalModelActionAtom, { action: 'engine-cancel' })
    try {
      await store.set(performLocalModelActionAtom, { action: 'engine-cancel' })
      expect(calls).toEqual(['engine-cancel'])
      expect(store.get(localModelPendingAtom).engine).toBe('engine-download')
      expect(store.get(localModelPendingAtom)['engine:cancel']).toBe('engine-cancel')
    } finally {
      finishCancel?.()
      finishDownload()
      await Promise.all([downloading, cancelling])
    }
    expect(store.get(localModelPendingAtom).engine).toBeUndefined()
    expect(store.get(localModelPendingAtom)['engine:cancel']).toBeUndefined()
  })
  test('Given IPC 包装中文诊断 When 引擎或模型下载失败 Then 只展示可读诊断', async () => {
    const { store, api } = setup()
    api.downloadLocalModelEngine = async () => { throw new Error("Error invoking remote method 'local-model:engine-download': Error: 下载连接超时，请检查代理设置") }
    api.downloadLocalModel = async () => { throw new Error("Error invoking remote method 'local-model:download': TypeError: 模型下载连接中断") }
    await store.set(performLocalModelActionAtom, { action: 'engine-download' })
    await store.set(performLocalModelActionAtom, { assetId: 'qwen', action: 'download' })
    expect(store.get(localModelErrorsAtom).engine).toBe('下载连接超时，请检查代理设置')
    expect(store.get(localModelErrorsAtom).qwen).toBe('模型下载连接中断')
  })
  test('Given 下载失败 When IPC 拒绝 Then 展示错误并解锁重试', async () => {
    const { store, api } = setup()
    api.downloadLocalModel = async () => { throw new Error('校验失败') }
    await store.set(performLocalModelActionAtom, { assetId: 'qwen', action: 'download' })
    expect(store.get(localModelErrorsAtom).qwen).toBe('校验失败')
    expect(store.get(localModelPendingAtom).qwen).toBeUndefined()
  })
  test('Given 未通过能力测试 When 调用启用 Then 阻止 IPC 且保留关闭', async () => {
    const { store, calls } = setup()
    await store.set(performLocalModelActionAtom, { assetId: 'qwen', action: 'toggle' })
    expect(calls).toEqual([])
    expect(store.get(localModelErrorsAtom).qwen).toContain('能力测试')
  })
  test('Given 新事件先返回 When 较旧读取返回 Then 不覆盖新快照', () => {
    const { store, snapshot } = setup()
    store.set(acceptLocalModelSnapshotAtom, { ...snapshot, updatedAt: 3 })
    store.set(acceptLocalModelSnapshotAtom, { ...snapshot, updatedAt: 2 })
    expect(store.get(localModelSnapshotAtom)?.updatedAt).toBe(3)
  })
})
