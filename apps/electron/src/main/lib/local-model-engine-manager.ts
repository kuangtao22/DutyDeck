/**
 * DutyDeck 本地 llama.cpp 环境管理器。
 *
 * 引擎是所有 GGUF 模型共享的一次性依赖；本模块只负责按需下载、校验和
 * 原子安装，不负责启动推理进程。renderer 只能看到脱敏快照。
 */
import { constants } from 'node:fs'
import { mkdir, open, readFile, rm, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LocalModelEngineSnapshot, LocalModelEngineState } from '@proma/shared'
import {
  ENGINE_ASSETS,
  installEngine,
  verifyArchive,
  type EngineAsset,
} from '../../../scripts/prepare-local-model-engine'
import { LOCAL_MODEL_ENGINE_VERSION, resolveBundledLocalModelEngine } from './local-model-engine'

/** GitHub Release 以及最终 release-assets 主机是唯一允许的引擎来源。 */
const TRUSTED_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])

interface EngineResolution {
  enginePath?: string
  engineVersion?: string
  message?: string
}

interface EngineDownloadState {
  state: Extract<LocalModelEngineState, 'downloading' | 'verifying' | 'installing' | 'error'>
  downloadedBytes?: number
  message?: string
}

/** 可替换依赖，测试可验证取消、断点、校验和原子安装。 */
export interface LocalModelEngineManagerDependencies {
  configDir: string
  bundledRoot?: string
  platform?: string
  arch?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  now?: () => number
  resolve?: (root: string, platform: string, arch: string) => EngineResolution
  downloadArchive?: (asset: EngineAsset, path: string, signal: AbortSignal, progress: (completedBytes: number) => void) => Promise<Buffer>
  installArchive?: (archive: Buffer, asset: EngineAsset, root: string) => Promise<void>
  verifyArchive?: (archive: Buffer, asset: EngineAsset) => void
  onChanged?: (snapshot: LocalModelEngineSnapshot) => void
}

/** 管理用户选择的 llama.cpp 下载、校验和安装。 */
export class LocalModelEngineManager {
  private readonly configDir: string
  private readonly bundledRoot?: string
  private readonly platform: string
  private readonly arch: string
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  private readonly now: () => number
  private readonly resolveImpl: (root: string, platform: string, arch: string) => EngineResolution
  private readonly downloadArchiveImpl: (asset: EngineAsset, path: string, signal: AbortSignal, progress: (completedBytes: number) => void) => Promise<Buffer>
  private readonly installArchiveImpl: (archive: Buffer, asset: EngineAsset, root: string) => Promise<void>
  private readonly verifyArchiveImpl: (archive: Buffer, asset: EngineAsset) => void
  private readonly onChanged?: (snapshot: LocalModelEngineSnapshot) => void
  private readonly target: string
  private readonly engineRoot: string
  private readonly asset?: EngineAsset
  private controller?: AbortController
  private transient?: EngineDownloadState
  private closed = false
  private readonly listeners = new Set<(snapshot: LocalModelEngineSnapshot) => void>()

  constructor(dependencies: LocalModelEngineManagerDependencies) {
    this.configDir = dependencies.configDir
    this.bundledRoot = dependencies.bundledRoot
    this.platform = dependencies.platform ?? process.platform
    this.arch = dependencies.arch ?? process.arch
    this.target = `${this.platform}-${this.arch}`
    this.engineRoot = join(this.configDir, 'engines', 'llama.cpp', LOCAL_MODEL_ENGINE_VERSION, this.target)
    this.asset = ENGINE_ASSETS.find((candidate) => candidate.target === this.target)
    this.fetchImpl = dependencies.fetch ?? fetch
    this.now = dependencies.now ?? Date.now
    this.resolveImpl = dependencies.resolve ?? resolveBundledLocalModelEngine
    this.downloadArchiveImpl = dependencies.downloadArchive ?? ((asset, path, signal, progress) => downloadEngineArchive(asset, path, signal, this.fetchImpl, progress))
    this.installArchiveImpl = dependencies.installArchive ?? (async (archive, asset, root) => { await mkdir(root, { recursive: true }); await installEngine(archive, asset, root) })
    this.verifyArchiveImpl = dependencies.verifyArchive ?? verifyArchive
    this.onChanged = dependencies.onChanged
  }

  /** 返回当前引擎状态；已安装状态必须通过 manifest 和文件哈希复核。 */
  snapshot(): LocalModelEngineSnapshot {
    const transient = this.transient
    if (transient) {
      return {
        state: transient.state,
        available: false,
        version: LOCAL_MODEL_ENGINE_VERSION,
        platform: this.platform,
        arch: this.arch,
        source: 'none',
        sizeBytes: this.asset?.size,
        downloadedBytes: transient.downloadedBytes,
        ...(transient.message ? { message: transient.message } : {}),
      }
    }
    const resolution = this.resolveInstalled()
    if (resolution.source !== 'none') {
      return {
        state: 'installed',
        available: true,
        version: resolution.engineVersion ?? LOCAL_MODEL_ENGINE_VERSION,
        platform: this.platform,
        arch: this.arch,
        source: resolution.source,
        sizeBytes: this.asset?.size,
      }
    }
    if (!this.asset) {
      return { state: 'error', available: false, platform: this.platform, arch: this.arch, source: 'none', message: '当前平台暂不支持 DutyDeck 本地运行环境' }
    }
    return { state: 'not-installed', available: false, version: LOCAL_MODEL_ENGINE_VERSION, platform: this.platform, arch: this.arch, source: 'none', sizeBytes: this.asset.size, message: '需要先安装本地运行环境' }
  }

  /** 返回主进程启动 llama-server 所需的已校验路径。 */
  resolveEngine(): EngineResolution {
    const resolution = this.resolveInstalled()
    if (resolution.source === 'none') return { message: this.snapshot().message }
    return { enginePath: resolution.enginePath, engineVersion: resolution.engineVersion ?? LOCAL_MODEL_ENGINE_VERSION }
  }

  /** 订阅状态变化，返回取消订阅函数。 */
  subscribe(listener: (snapshot: LocalModelEngineSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 安装当前平台固定版本的引擎；重复调用保持幂等。 */
  async download(): Promise<LocalModelEngineSnapshot> {
    if (this.closed) throw new Error('本地运行时已关闭')
    if (!this.asset) throw new Error('当前平台暂不支持 DutyDeck 本地运行环境')
    if (this.controller) throw new Error('本地运行环境正在下载')
    if (this.resolveInstalled().source === 'user') return this.snapshot()
    const controller = new AbortController()
    const stagingPath = join(this.engineRoot, 'staging', `${this.asset.name}.part`)
    this.controller = controller
    this.transient = { state: 'downloading', downloadedBytes: 0 }
    this.emitChanged()
    try {
      const archive = await this.downloadArchiveImpl(this.asset, stagingPath, controller.signal, (downloadedBytes) => {
        this.transient = { state: 'downloading', downloadedBytes }
        this.emitChanged()
      })
      controller.signal.throwIfAborted()
      this.transient = { state: 'verifying', downloadedBytes: archive.length, message: '正在校验引擎归档 SHA-256' }
      this.emitChanged()
      this.verifyArchiveImpl(archive, this.asset)
      controller.signal.throwIfAborted()
      this.transient = { state: 'installing', downloadedBytes: archive.length, message: '正在安装本地运行环境' }
      this.emitChanged()
      await this.installArchiveImpl(archive, this.asset, this.engineRoot)
      await rm(stagingPath, { force: true })
      this.transient = undefined
      this.emitChanged()
      return this.snapshot()
    } catch (error) {
      const aborted = controller.signal.aborted
      if (!aborted && error instanceof Error && error.message.includes('SHA-256')) await rm(stagingPath, { force: true })
      this.transient = { state: 'error', message: aborted ? '安装已取消，可继续下载' : toErrorMessage(error) }
      this.emitChanged()
      throw error
    } finally {
      if (this.controller === controller) this.controller = undefined
    }
  }

  /** 取消引擎下载；保留已写入的部分，下一次安装可继续。 */
  cancelDownload(): void {
    this.controller?.abort(new Error('本地运行环境安装已取消'))
  }

  /** 应用退出时终止下载，避免后台写入。 */
  shutdown(): void {
    this.closed = true
    this.controller?.abort(new Error('本地运行时已关闭'))
    this.controller = undefined
    this.listeners.clear()
  }

  private resolveInstalled(): EngineResolution & { source: 'user' | 'bundled' | 'none' } {
    const user = this.resolveImpl(this.engineRoot, this.platform, this.arch)
    if (user.enginePath) return { ...user, source: 'user' }
    if (this.bundledRoot) {
      const bundled = this.resolveImpl(this.bundledRoot, this.platform, this.arch)
      if (bundled.enginePath) return { ...bundled, source: 'bundled' }
    }
    return { source: 'none', message: user.message }
  }

  private emitChanged(): void {
    const snapshot = this.snapshot()
    for (const listener of [this.onChanged, ...this.listeners]) {
      try { listener?.(snapshot) } catch { /* 观察者错误不能中断安装。 */ }
    }
  }
}

/** 受限下载：支持 Range 续传、HTTPS 主机校验、大小上限和可取消写入。 */
async function downloadEngineArchive(asset: EngineAsset, path: string, signal: AbortSignal, fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, progress: (completedBytes: number) => void): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true })
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const saved = await file.stat()
    if (!saved.isFile()) throw new Error('本地运行环境临时文件类型非法')
    let completed = saved.size
    if (completed > asset.size) { await file.truncate(0); completed = 0 }
    const disk = await statfs(dirname(path))
    if (disk.bavail * disk.bsize < asset.size - completed) throw new Error('磁盘可用空间不足')
    signal.throwIfAborted()
    if (completed === asset.size) return await readFile(path)
    const response = await fetchImpl(asset.browser_download_url, { signal, redirect: 'follow', headers: completed ? { Range: `bytes=${completed}-` } : {} })
    signal.throwIfAborted()
    const finalUrl = response.url ? new URL(response.url) : new URL(asset.browser_download_url)
    if (finalUrl.protocol !== 'https:' || !TRUSTED_HOSTS.has(finalUrl.hostname)) throw new Error('引擎下载来源不受信任')
    if (!response.ok || !response.body) throw new Error(`本地运行环境下载失败（HTTP ${response.status}）`)
    if (response.status === 206) {
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
      if (!range || Number(range[1]) !== completed || Number(range[2]) !== asset.size - 1 || Number(range[3]) !== asset.size) throw new Error('引擎续传 Content-Range 不匹配')
    } else if (response.status === 200) {
      await file.truncate(0); completed = 0
    } else throw new Error('引擎下载响应状态非法')
    reader = response.body.getReader()
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      if (completed + chunk.value.byteLength > asset.size) throw new Error('引擎下载超过清单大小上限')
      let written = 0
      while (written < chunk.value.byteLength) {
        const result = await file.write(chunk.value, written, chunk.value.byteLength - written, completed + written)
        if (!result.bytesWritten) throw new Error('引擎文件写入无进展')
        written += result.bytesWritten
      }
      completed += written
      progress(completed)
    }
    signal.throwIfAborted()
    if (completed !== asset.size) throw new Error('引擎下载未完成，可继续下载以续传')
    await file.sync()
    return await readFile(path)
  } finally {
    await reader?.cancel().catch(() => undefined)
    await file.close()
  }
}

/** 将未知错误收敛为可展示诊断，避免泄漏请求头或本地路径。 */
function toErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]').replace(/\/Users\/[^\s)]+/g, '[path]').slice(0, 500)
}
