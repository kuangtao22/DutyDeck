import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalModelEngineManager } from './local-model-engine-manager'

/** 每项真实下载器测试使用独立临时目录，避免触碰用户引擎。 */
const networkRoots: string[] = []
afterEach(() => { for (const root of networkRoots.splice(0)) rmSync(root, { recursive: true, force: true }) })

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
  test('Given HTTP 错误响应仍在传输 When 拒绝下载 Then 先取消响应流再关闭代理', async () => {
    /** 未结束的响应能检出遗忘 body.cancel 导致连接回收挂起的问题。 */
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-engine-http-error-'))
    networkRoots.push(root)
    const events: string[] = []
    const { manager } = createManager({ configDir: root, downloadArchive: undefined,
      createDownloadTransport: async () => ({
        fetch: async () => new Response(new ReadableStream({ cancel: () => { events.push('cancel') } }), { status: 503 }),
        close: async () => { events.push('close') },
      }),
    })
    await expect(manager.download()).rejects.toThrow('HTTP 503')
    expect(events).toEqual(['cancel', 'close'])
  })

  test('Given 下载使用代理 When 安装成功 Then 使用代理响应并释放连接', async () => {
    /** 独立目录与清单等长的测试归档，校验/解包继续使用受控替身。 */
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-engine-network-'))
    networkRoots.push(root)
    /** 记录传输层的使用和回收，不允许意外直连。 */
    let requests = 0
    let closed = 0
    const { manager } = createManager({ configDir: root, downloadArchive: undefined,
      fetch: async () => { throw new Error('不应绕过代理') },
      createDownloadTransport: async () => ({
        fetch: async () => { requests++; return new Response(new Uint8Array(11971406)) },
        close: async () => { closed++ },
      }),
    })
    await manager.download()
    expect(manager.snapshot().state).toBe('installed')
    expect(requests).toBe(1)
    expect(closed).toBe(1)
  })

  test('Given 网络 DNS 错误 When 下载失败 Then IPC 和快照都有脱敏中文原因', async () => {
    /** 底层异常包含敏感请求信息，界面只能暴露原因分类。 */
    const cause = Object.assign(new Error('https://user:password@example.invalid/?token=secret'), { code: 'ENOTFOUND' })
    const { manager } = createManager({ downloadArchive: async () => { throw new TypeError('fetch failed', { cause }) } })
    await expect(manager.download()).rejects.toThrow('DNS')
    expect(manager.snapshot().message).toContain('ENOTFOUND')
    expect(manager.snapshot().message).not.toContain('secret')
    expect(manager.snapshot().message).not.toContain('password')
  })

  test('Given 代理尚在解析 When 用户取消 Then 不发出请求并释放迟到连接', async () => {
    /** 可控解析门，用于模拟系统代理检测尚未完成。 */
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let downloaded = 0
    let closed = 0
    const { manager } = createManager({
      createDownloadTransport: async () => { await gate; return { fetch, close: async () => { closed++ } } },
      downloadArchive: async () => { downloaded++; return Buffer.from('fixture') },
    })
    const pending = manager.download()
    manager.cancelDownload()
    release()
    await expect(pending).rejects.toThrow('取消')
    expect(downloaded).toBe(0)
    expect(closed).toBe(1)
  })

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
