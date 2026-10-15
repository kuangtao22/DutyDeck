import { afterAll, expect, mock, test } from 'bun:test'
import type { LocalModelRuntimeDependencies } from './local-model-runtime'
import type { LocalModelEngineManagerDependencies } from './local-model-engine-manager'

/** 记录生产入口装配参数，避免仅测试手工注入时通过、真实安装仍然直连。 */
let engineOptions: LocalModelEngineManagerDependencies | undefined
let runtimeOptions: LocalModelRuntimeDependencies | undefined
mock.module('electron', () => ({ app: { isPackaged: false } }))
mock.module('./config-paths', () => ({ getConfigDir: () => '/tmp/dutydeck-singleton-fixture' }))
mock.module('./proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => undefined }))
mock.module('./local-model-engine-manager', () => ({ LocalModelEngineManager: class {
  constructor(options: LocalModelEngineManagerDependencies) { engineOptions = options }
} }))
mock.module('./local-model-runtime', () => ({ LocalModelRuntime: class {
  constructor(options: LocalModelRuntimeDependencies) { runtimeOptions = options }
  /** 测试替身无需回收真实进程。 */
  shutdown(): void {}
} }))
const { getLocalModelRuntime, shutdownLocalModelRuntime } = await import('./local-model-runtime-singleton')
const { createLocalModelDownloadTransport } = await import('./local-model-download-network')
afterAll(() => { shutdownLocalModelRuntime(); mock.restore() })

test('Given 正式单例 When 装配引擎和模型 Then 都接入动态代理且不覆盖回环 fetch', () => {
  getLocalModelRuntime()
  expect(engineOptions?.createDownloadTransport).toBe(createLocalModelDownloadTransport)
  expect(runtimeOptions?.createDownloadTransport).toBe(createLocalModelDownloadTransport)
  expect(runtimeOptions?.fetch).toBeUndefined()
})
