import { describe, expect, test } from 'bun:test'
import { LocalModelEngineManager } from './local-model-engine-manager'

/** 使用受控依赖验证按需引擎安装，不下载真实 GitHub 归档。 */
function createManager(overrides: Partial<ConstructorParameters<typeof LocalModelEngineManager>[0]> = {}) {
  let installed = false
  const manager = new LocalModelEngineManager({
    configDir: '/tmp/dutydeck-engine-test',
    platform: 'darwin',
    arch: 'arm64',
    resolve: () => installed ? { enginePath: '/tmp/llama-server', engineVersion: 'b11429@test' } : { message: '未安装' },
    downloadArchive: async (_asset, _path, _signal, progress) => { progress(12); return Buffer.from('fixture') },
    verifyArchive: () => undefined,
    installArchive: async () => { installed = true },
    ...overrides,
  })
  return { manager, setInstalled: (value: boolean) => { installed = value } }
}

describe('LocalModelEngineManager', () => {
  test('Given 未安装 When 读取 Then 模型环境明确锁定为待安装', () => {
    const { manager } = createManager()
    expect(manager.snapshot()).toMatchObject({ state: 'not-installed', available: false, source: 'none' })
    expect(manager.resolveEngine().enginePath).toBeUndefined()
  })

  test('Given 用户确认安装 When 下载校验完成 Then 只返回已校验环境', async () => {
    const { manager } = createManager()
    await manager.download()
    expect(manager.snapshot()).toMatchObject({ state: 'installed', available: true, source: 'user' })
    expect(manager.resolveEngine()).toEqual({ enginePath: '/tmp/llama-server', engineVersion: 'b11429@test' })
  })

  test('Given 引擎下载在途 When 用户取消 Then 状态进入可重试错误且不宣称可用', async () => {
    let rejectDownload!: (error: Error) => void
    const { manager } = createManager({
      downloadArchive: async (_asset, _path, signal) => await new Promise<Buffer>((_resolve, reject) => {
        rejectDownload = reject
        signal.addEventListener('abort', () => reject(new Error('取消')), { once: true })
      }),
    })
    const pending = manager.download()
    expect(manager.snapshot().state).toBe('downloading')
    manager.cancelDownload()
    rejectDownload(new Error('取消'))
    await expect(pending).rejects.toThrow()
    expect(manager.snapshot()).toMatchObject({ state: 'error', available: false })
  })

  test('Given 不支持平台 When 安装 Then 拒绝且不创建环境', async () => {
    const { manager } = createManager({ platform: 'plan9', arch: 'arm64' })
    expect(manager.snapshot()).toMatchObject({ state: 'error', available: false })
    await expect(manager.download()).rejects.toThrow('不支持')
  })
})
