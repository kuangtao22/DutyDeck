/**
 * DutyDeck 内置本地模型运行时。
 *
 * 该服务把下载校验、模型资产清单和 llama-server 子进程放在主进程内；
 * renderer 只能通过快照观察状态。首期只允许同时加载一个模型，避免本地
 * GPU/内存竞争把现有 Agent 和媒体任务拖入不可控的资源争抢。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { createServer } from 'node:net'
import { totalmem } from 'node:os'
import { Agent, fetch as undiciFetch } from 'undici'
import type { ChildProcess } from 'node:child_process'
import type {
  LocalModelAsset,
  LocalModelCapabilityEvidence,
  LocalModelCatalogEntry,
  LocalModelDownloadInput,
  LocalModelLifecycleState,
  LocalModelProgressEvent,
  LocalModelRuntimeSnapshot,
  LocalModelSnapshot,
  LocalModelTestInput,
  LocalModelTestResult,
} from '@proma/shared'
import { downloadModelFile } from './local-model-download'
import { getLocalModelDownloadNetworkMessage, type LocalModelDownloadTransport } from './local-model-download-network'
import { LocalModelStore } from './local-model-store'
import type { LocalModelEngineManager } from './local-model-engine-manager'

/** v3 固定关闭 thinking，与首期 Pi 文本输出模式一致。 */
const PROBE_VERSION = 3
const HEALTH_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 2_000

/** 只暴露给主进程内部的 llama-server 连接信息。 */
export interface LocalModelRuntimeEndpoint {
  baseUrl: string
  token: string
  modelId: string
}

/** 整轮 Agent 独占租约；调用方在 finally 中释放。 */
export interface LocalModelLease {
  endpoint: LocalModelRuntimeEndpoint
  contextWindow: number
  maxTokens: number
  release: () => void
}

/** 可替换的子进程最小接口，便于在无本地二进制的测试中验证生命周期。 */
export interface ManagedProcess {
  pid?: number
  kill: (signal?: NodeJS.Signals) => boolean
  once: (event: 'exit' | 'error', listener: (...args: unknown[]) => void) => ManagedProcess
}

export type SpawnProcess = (file: string, args: string[], options: { stdio: 'ignore' }) => ManagedProcess
type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface LocalModelRuntimeDependencies {
  /** 测试用清单存储。 */
  store?: LocalModelStore
  /** 已锁定的模型目录；空目录表示当前发行包尚未携带下载清单。 */
  catalog?: readonly LocalModelCatalogEntry[]
  /** 当前发行包中受管的 llama-server 路径。 */
  enginePath?: string
  /** 随包可信版本，必须与实际引擎一致。 */
  engineVersion?: string
  /** 按需安装的用户引擎；存在时优先于静态随包引擎。 */
  engineManager?: LocalModelEngineManager
  /** 注入网络实现以验证取消、断点和错误。 */
  fetch?: FetchFunction
  /** 仅用于远程 GGUF 下载；回环健康检查和能力测试继续独立直连。 */
  createDownloadTransport?: () => Promise<LocalModelDownloadTransport>
  /** 注入子进程构造器以隔离真实原生二进制。 */
  spawn?: SpawnProcess
  /** 测试时注入时钟。 */
  now?: () => number
  /** 测试时缩短健康检查和停止等待；生产使用稳定默认值。 */
  healthTimeoutMs?: number
  stopTimeoutMs?: number
  /** 空闲卸载期限，测试可缩短；默认五分钟。 */
  idleUnloadMs?: number
  /** 物理内存总量，不以 macOS 可回收缓存后的 free 值错误拦截。 */
  totalMemory?: () => number
  /** 测试注入端口分配器；生产使用回环临时端口。 */
  findFreePort?: () => Promise<number>
  /** 进度事件只在主进程内部消费。 */
  onProgress?: (event: LocalModelProgressEvent) => void
  /** 状态变化只在主进程内部消费。 */
  onChanged?: (snapshot: LocalModelSnapshot) => void
}

interface TransientOperationState {
  state: Extract<LocalModelLifecycleState, 'downloading' | 'verifying' | 'error'>
  completedBytes?: number
  totalBytes?: number
  message?: string
}

/** llama-server 当前进程的内部句柄。 */
interface RunningServer {
  assetId: string
  endpoint: LocalModelRuntimeEndpoint
  process: ManagedProcess
  engineVersion: string
  backend: LocalModelRuntimeSnapshot['backend']
  exited: boolean
  exit: Promise<void>
}

/** 管理 DutyDeck 本地模型资产下载、校验、加载和探测。 */
export class LocalModelRuntime {
  private readonly store: LocalModelStore
  private readonly catalog: readonly LocalModelCatalogEntry[]
  private readonly enginePath: string | undefined
  private readonly engineVersion: string | undefined
  private readonly engineManager?: LocalModelEngineManager
  /** 生命周期操作的取消控制与代数，隔离迟到的健康响应。 */
  private lifecycle?: AbortController
  private startAbort?: AbortController
  private transition?: Promise<LocalModelRuntimeSnapshot>
  private stopping?: Promise<void>
  private closed = false
  /** 同一已选模型可由父子 Agent 同时引用，推理由引擎 parallel=1 串行。 */
  private leaseCount = 0
  private leaseAssetId?: string
  /** 能力探测必须独占，不能插入真实 Agent 工具往返。 */
  private testing = false
  /** 区分任务触发与用户手动加载，最后任务取消只回收自己发起的加载。 */
  private leaseLoading = false
  private readonly fetchImpl: FetchFunction
  /** 每次下载独立创建并释放连接，使代理设置修改在重试时生效。 */
  private readonly createDownloadTransport?: () => Promise<LocalModelDownloadTransport>
  /** 回环探测独立直连 dispatcher，不继承 Pi 或环境代理。 */
  private readonly directAgent?: Agent
  private readonly localFetchImpl: FetchFunction
  private readonly spawnImpl: SpawnProcess
  private readonly now: () => number
  private readonly healthTimeoutMs: number
  private readonly stopTimeoutMs: number
  private readonly idleUnloadMs: number
  private readonly totalMemory: () => number
  private idleTimer?: ReturnType<typeof setTimeout>
  private readonly findFreePortImpl: () => Promise<number>
  private readonly onProgress?: (event: LocalModelProgressEvent) => void
  private readonly onChanged?: (snapshot: LocalModelSnapshot) => void
  private readonly snapshotListeners = new Set<(snapshot: LocalModelSnapshot) => void>()
  private readonly progressListeners = new Set<(event: LocalModelProgressEvent) => void>()
  private readonly transient = new Map<string, TransientOperationState>()
  private readonly downloadControllers = new Map<string, AbortController>()
  /** 停止中的进程仍保留所有权，以便退出钩子强制回收。 */
  private readonly terminating = new Set<RunningServer>()
  private server: RunningServer | undefined
  private runtime: LocalModelRuntimeSnapshot = { state: 'idle', endpointReady: false }

  constructor(dependencies: LocalModelRuntimeDependencies = {}) {
    this.store = dependencies.store ?? new LocalModelStore()
    this.catalog = (dependencies.catalog ?? []).map((entry) => Object.freeze({ ...entry }))
    this.enginePath = dependencies.enginePath
    this.engineVersion = dependencies.engineVersion
    this.engineManager = dependencies.engineManager
    this.fetchImpl = dependencies.fetch ?? fetch
    this.createDownloadTransport = dependencies.createDownloadTransport
    this.directAgent = dependencies.fetch ? undefined : new Agent({ allowH2: false })
    this.localFetchImpl = dependencies.fetch ?? ((input, init) => undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...init, dispatcher: this.directAgent, redirect: 'error' } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>)
    this.spawnImpl = dependencies.spawn ?? ((file, args, options) => nodeSpawn(file, args, options) as ManagedProcess)
    this.now = dependencies.now ?? Date.now
    this.healthTimeoutMs = dependencies.healthTimeoutMs ?? HEALTH_TIMEOUT_MS
    this.stopTimeoutMs = dependencies.stopTimeoutMs ?? STOP_TIMEOUT_MS
    this.idleUnloadMs = dependencies.idleUnloadMs ?? 300_000
    this.totalMemory = dependencies.totalMemory ?? totalmem
    this.findFreePortImpl = dependencies.findFreePort ?? findFreePort
    this.onProgress = dependencies.onProgress
    this.onChanged = dependencies.onChanged
    this.engineManager?.subscribe(() => this.emitChanged())
    if (new Set(this.catalog.map((entry) => entry.assetId)).size !== this.catalog.length) throw new Error('模型目录存在重复资产 ID')
    for (const entry of this.catalog) {
      this.store.resolveAssetFilePath(entry.assetId, this.resolveFileName(entry))
      if (entry.assetId === 'staging') throw new Error('模型资产 ID 使用保留目录')
      if (new URL(entry.downloadUrl).protocol !== 'https:' || !/^[a-fA-F0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0 || !Number.isSafeInteger(entry.contextWindow) || entry.contextWindow < 256 || !Number.isSafeInteger(entry.maxTokens) || entry.maxTokens < 1 || entry.maxTokens >= entry.contextWindow || !Number.isSafeInteger(entry.diskBytes) || entry.diskBytes < entry.sizeBytes || !Number.isSafeInteger(entry.memoryBytes) || entry.memoryBytes <= 0) throw new Error('模型目录元数据无效')
    }
    for (const asset of this.store.listAssets()) {
      if (['starting', 'running', 'stopping'].includes(asset.status)) this.store.updateStatus(asset.assetId, 'installed')
    }
  }

  /** 返回 renderer 可消费的脱敏快照。 */
  listSnapshot(): LocalModelSnapshot {
    const assetsById = new Map(this.store.listAssets().map((asset) => [asset.assetId, asset]))
    const assets = this.catalog.map((entry) => {
      const saved = assetsById.get(entry.assetId)
      const operation = this.transient.get(entry.assetId)
      if (saved && !operation) return { ...saved, capability: saved.capability.state === 'available' && !this.capabilityMatches(saved) ? { state: 'unknown' as const } : saved.capability }
      return this.toVisibleAsset(entry, saved, operation)
    })
    for (const saved of assetsById.values()) {
      if (!this.catalog.some((entry) => entry.assetId === saved.assetId)) assets.push({ ...saved, enabled: false, capability: { state: 'unknown' } })
    }
    const engine = this.engineSnapshot()
    return {
      catalog: this.catalog.map((entry) => ({ ...entry })),
      assets,
      runtime: { ...this.runtime, busy: this.leaseCount > 0 || this.testing || !!this.transition || !!this.stopping },
      engine,
      updatedAt: this.now(),
    }
  }

  /** 下载并安装用户选择的本地引擎环境。 */
  async downloadEngine(): Promise<void> {
    if (!this.engineManager) throw new Error('当前版本未启用按需本地运行环境')
    await this.engineManager.download()
  }

  /** 取消引擎环境下载，保留可续传的临时文件。 */
  cancelEngineDownload(): void {
    this.engineManager?.cancelDownload()
  }

  /** 订阅状态变化；返回取消订阅函数，避免窗口销毁后保留 renderer 回调。 */
  subscribe(listener: (snapshot: LocalModelSnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  /** 订阅下载进度；进度事件同样不包含本地路径。 */
  subscribeProgress(listener: (event: LocalModelProgressEvent) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  /** 下载指定目录项，只有哈希校验成功后才登记为 installed。 */
  async download(input: LocalModelDownloadInput): Promise<LocalModelAsset> {
    if (this.closed) throw new Error('本地运行时已关闭')
    this.assertEngineReadyForModelOperation()
    const entry = this.requireCatalogEntry(input.assetId)
    if (this.server?.assetId === entry.assetId || this.transition) throw new Error('模型正在使用中，不能重新下载')
    if (this.downloadControllers.has(entry.assetId)) throw new Error('该模型已经在下载中')
    const controller = new AbortController()
    const stagingDir = join(this.store.ensureModelsDir(), 'staging')
    const stagingPath = join(stagingDir, `${entry.assetId}.part`)
    const fileName = this.resolveFileName(entry)
    const finalDir = join(this.store.ensureModelsDir(), entry.assetId)
    const finalPath = this.store.resolveAssetFilePath(entry.assetId, fileName)
    this.store.assertNotSymlink(stagingDir)
    this.store.assertNotSymlink(stagingPath)
    mkdirSync(stagingDir, { recursive: true })
    this.downloadControllers.set(entry.assetId, controller)
    this.transient.set(entry.assetId, { state: 'downloading', totalBytes: entry.sizeBytes })
    this.emitChanged()

    /** 本次远程下载连接；本地完整文件恢复时不创建网络资源。 */
    let transport: LocalModelDownloadTransport | undefined
    try {
      // 崩溃可能发生于 rename 后、清单提交前，先验证正式文件以幂等恢复。
      if (existsSync(finalPath)) {
        let valid = false
        try { await this.store.verifyFile(this.installationData(entry), controller.signal); valid = true }
        catch { controller.signal.throwIfAborted() }
        if (valid) {
          const existing = this.store.getAsset(entry.assetId)
          const recovered = await this.store.markInstalled({ ...this.installationData(entry), ...(existing && existing.sha256 === entry.sha256 ? { enabled: existing.enabled, capability: existing.capability } : {}) }, controller.signal)
          this.transient.delete(entry.assetId)
          this.emitChanged()
          return recovered
        }
      }
      if (this.createDownloadTransport) transport = await this.createDownloadTransport()
      controller.signal.throwIfAborted()
      await downloadModelFile(entry, stagingPath, controller.signal, transport?.fetch ?? this.fetchImpl, (completedBytes) => {
        this.transient.set(entry.assetId, { state: 'downloading', completedBytes, totalBytes: entry.sizeBytes })
        this.emitProgress({ assetId: entry.assetId, state: 'downloading', completedBytes, totalBytes: entry.sizeBytes })
      })
      controller.signal.throwIfAborted()
      this.transient.set(entry.assetId, { state: 'verifying' })
      this.emitProgress({ assetId: entry.assetId, state: 'verifying', message: '正在校验 SHA-256' })
      try { await this.store.verifyFile({ assetId: 'staging', fileName: `${entry.assetId}.part`, sha256: entry.sha256, sizeBytes: entry.sizeBytes }, controller.signal) }
      catch (error) { this.removeStagingFile(stagingPath); throw error }
      controller.signal.throwIfAborted()
      this.store.assertNotSymlink(finalDir)
      mkdirSync(finalDir, { recursive: true })
      this.store.resolveAssetFilePath(entry.assetId, fileName)
      await rename(stagingPath, finalPath)
      const installed = await this.store.markInstalled(this.installationData(entry), controller.signal)
      this.transient.delete(entry.assetId)
      this.emitChanged()
      return installed
    } catch (error) {
      const message = controller.signal.aborted ? '下载已取消，可继续下载' : getLocalModelDownloadNetworkMessage(error) ?? toErrorMessage(error)
      this.transient.set(entry.assetId, { state: 'error', message })
      const saved = this.store.getAsset(entry.assetId)
      if (saved) this.store.updateStatus(entry.assetId, 'error', message)
      this.emitChanged()
      throw new Error(message, { cause: error })
    } finally {
      await transport?.close().catch(() => undefined)
      this.downloadControllers.delete(entry.assetId)
    }
  }

  /** 从可信目录构造安装记录；任何磁盘恢复仍须经过 store 的哈希验证。 */
  private installationData(entry: LocalModelCatalogEntry): Omit<LocalModelAsset, 'status' | 'updatedAt'> {
    return { assetId: entry.assetId, modelId: entry.modelId, name: entry.name, family: entry.family,
      revision: entry.revision, fileName: this.resolveFileName(entry), sha256: entry.sha256, sizeBytes: entry.sizeBytes,
      enabled: false, capability: { state: 'unknown' } }
  }

  /** 取消下载，保留有效部分文件供下次校验续传。 */
  cancelDownload(input: LocalModelDownloadInput): void {
    this.downloadControllers.get(input.assetId)?.abort()
  }

  /** UI 手动启动；模型被任务引用时拒绝切换。 */
  async start(input: { assetId: string }): Promise<LocalModelRuntimeSnapshot> {
    if (this.leaseCount > 0 || this.testing) throw new Error('本地模型正被任务占用')
    if (this.transition || this.stopping) throw new Error('本地模型正在切换，请稍后重试')
    this.assertEngineReadyForModelOperation()
    this.cancelIdleUnload()
    return this.startManaged(input.assetId)
  }

  /** 启动唯一受管进程，取消后任何迟到结果都不能重新置为 running。 */
  private async startManaged(assetId: string): Promise<LocalModelRuntimeSnapshot> {
    if (this.closed) throw new Error('本地运行时已关闭')
    let asset: LocalModelAsset
    const entry = this.requireCatalogEntry(assetId)
    try { asset = this.requireInstalledAsset(assetId) }
    catch (error) {
      const saved = this.store.getAsset(assetId)
      const message = toErrorMessage(error)
      if (saved) this.store.updateStatus(assetId, 'error', message)
      this.runtime = { state: 'error', endpointReady: false, assetId, message }
      this.emitChanged()
      throw error
    }
    if (this.server?.assetId === assetId && this.runtime.endpointReady) return { ...this.runtime }
    const controller = new AbortController()
    this.startAbort = controller
    const work = async (): Promise<LocalModelRuntimeSnapshot> => {
      try {
        if (this.server) await this.stopManaged(false)
        controller.signal.throwIfAborted()
        if (this.closed) throw new Error('本地运行时已关闭')
        this.lifecycle = controller
        const engine = this.resolveEngine()
        if (!engine.enginePath || !engine.engineVersion?.trim()) throw new Error(engine.message ?? 'DutyDeck 本地运行环境尚未安装')
        if (entry.memoryBytes > this.totalMemory()) throw new Error('设备物理内存不足以加载该模型，请选择更小的量化模型')
        await this.store.verifyFile(asset, controller.signal)
        const port = await this.findFreePortImpl()
        controller.signal.throwIfAborted()
        this.runtime = { state: 'starting', endpointReady: false, assetId }
        this.store.updateStatus(assetId, 'starting')
        this.emitChanged()
        const token = randomUUID()
        const child = this.spawnImpl(engine.enginePath, [
          '--model', this.store.resolveAssetFilePath(assetId, asset.fileName), '--alias', asset.modelId,
          '--host', '127.0.0.1', '--port', String(port), '--api-key', token,
          '--ctx-size', String(entry.contextWindow), '--parallel', '1', '--jinja',
          '--chat-template-kwargs', '{"enable_thinking":false}', '--reasoning-budget', '0',
          ...(entry.chatTemplate ? ['--chat-template', entry.chatTemplate] : []),
        ], { stdio: 'ignore' })
        let resolveExit!: () => void
        const server: RunningServer = { assetId, process: child, endpoint: { baseUrl: `http://127.0.0.1:${port}/v1`, token, modelId: asset.modelId }, engineVersion: engine.engineVersion, backend: 'unknown', exited: false, exit: new Promise<void>((resolve) => { resolveExit = resolve }) }
        this.server = server
        const failed = (message: string): void => {
          server.exited = true; this.terminating.delete(server); resolveExit()
          if (this.server !== server) return
          this.server = undefined
          controller.abort(new Error(message))
          this.runtime = { state: 'error', endpointReady: false, assetId, message }
          this.store.updateStatus(assetId, 'error', message)
          this.emitChanged()
        }
        child.once('exit', () => failed('本地引擎进程已退出'))
        child.once('error', () => failed('本地引擎进程启动失败'))
        await this.waitForHealth(server.endpoint, controller.signal)
        controller.signal.throwIfAborted()
        if (this.server !== server || server.exited) throw new Error('本地引擎已退出')
        this.runtime = { state: 'running', endpointReady: true, assetId, engineVersion: engine.engineVersion, backend: 'unknown', message: `模型已加载，无任务使用 ${Math.ceil(this.idleUnloadMs / 1000)} 秒后自动卸载` }
        this.store.updateStatus(assetId, 'running')
        this.emitChanged()
        return { ...this.runtime }
      } catch (error) {
        if (!controller.signal.aborted) {
          await this.stopManaged(false)
          const message = toErrorMessage(error)
          this.runtime = { state: 'error', endpointReady: false, assetId, message }
          this.store.updateStatus(assetId, 'error', message)
          this.emitChanged()
        }
        throw error
      }
    }
    const pending = work()
    this.transition = pending
    try { return await pending } finally { if (this.transition === pending) this.transition = undefined; if (this.startAbort === controller) this.startAbort = undefined; this.scheduleIdleUnload(); this.emitChanged() }
  }

  /** 停止时等真实 exit；只有到期仍存活才升级 SIGKILL。 */
  private async stopManaged(cancelStart = true): Promise<void> {
    this.cancelIdleUnload()
    if (cancelStart) this.startAbort?.abort(new Error('本地模型启动已取消'))
    if (this.stopping) return this.stopping
    this.lifecycle?.abort(new Error('本地模型启动已取消'))
    const server = this.server
    this.server = undefined
    const work = async (): Promise<void> => {
      if (server && !server.exited) {
        this.terminating.add(server)
        this.runtime = { state: 'stopping', endpointReady: false, assetId: server.assetId }
        this.emitChanged()
        server.process.kill('SIGTERM')
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([server.exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, this.stopTimeoutMs) })])
        clearTimeout(timer)
        if (!server.exited) server.process.kill('SIGKILL')
        // SIGKILL 不代表 exit 已确认，必须等回执后才允许下一进程启动。
        if (!server.exited) {
          await Promise.race([server.exit, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('本地引擎尚未退出')), this.stopTimeoutMs) })]).finally(() => clearTimeout(timer))
        }
        if (this.store.getAsset(server.assetId)) this.store.updateStatus(server.assetId, 'installed')
      }
      this.runtime = { state: 'idle', endpointReady: false }
      this.emitChanged()
    }
    const pending = work()
    this.stopping = pending
    try { await pending } catch (error) { this.shutdown(); this.runtime = { state: 'error', endpointReady: false, message: toErrorMessage(error) }; throw error } finally { this.stopping = undefined; this.emitChanged() }
  }

  /** 拒绝中断正在生成的整轮 Agent；加载中允许取消。 */
  async stop(): Promise<void> {
    if (this.leaseCount > 0 || this.testing) throw new Error('本地模型正被任务占用')
    await this.stopManaged()
  }

  /** 退出回收同步入口，不依赖异步 before-quit 的完成顺序。 */
  shutdown(): void {
    this.cancelIdleUnload()
    this.closed = true
    this.startAbort?.abort(new Error('本地运行时已关闭'))
    this.lifecycle?.abort(new Error('本地运行时已关闭'))
    for (const controller of this.downloadControllers.values()) controller.abort()
    for (const server of this.terminating) if (!server.exited) server.process.kill('SIGKILL')
    const active = this.server
    this.server = undefined
    active?.process.kill('SIGKILL')
    void this.directAgent?.destroy().catch(() => undefined)
    this.engineManager?.shutdown()
    this.runtime = { state: 'idle', endpointReady: false }
  }

  /** 新任务、切换或退出撤销已有卸载定时器。 */
  private cancelIdleUnload(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /** 仅在无任务、无测试且引擎已就绪时计划卸载，不中断在用模型。 */
  private scheduleIdleUnload(): void {
    this.cancelIdleUnload()
    if (this.closed || this.leaseCount > 0 || this.testing || this.transition || !this.server || !this.runtime.endpointReady) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (!this.leaseCount && !this.testing && !this.transition) void this.stopManaged().catch(() => undefined)
    }, this.idleUnloadMs)
    this.idleTimer.unref()
  }

  /** 测试独占资格；真实任务或其它测试期间立即拒绝，不隐藏排队。 */
  private lockTest(): () => void {
    if (this.closed) throw new Error('本地运行时已关闭')
    if (this.leaseCount > 0 || this.testing || this.transition || this.stopping) throw new Error('本地模型正被任务占用或正在切换')
    this.cancelIdleUnload()
    this.testing = true
    this.emitChanged()
    let released = false
    return () => { if (released) return; released = true; this.testing = false; this.scheduleIdleUnload(); this.emitChanged() }
  }

  /** 给整轮 Agent 引用模型；同模型父子任务共享加载，不同模型立即拒绝避免等待死锁。 */
  async acquire(assetId: string, signal?: AbortSignal): Promise<LocalModelLease> {
    if (this.closed) throw new Error('本地运行时已关闭')
    signal?.throwIfAborted()
    if (this.testing) throw new Error('本地模型正被能力测试占用')
    if (this.leaseCount > 0 && this.leaseAssetId !== assetId) throw new Error('本地模型正被其它任务占用，不能加载不同模型')
    this.cancelIdleUnload()
    this.leaseCount++
    this.leaseAssetId = assetId
    this.emitChanged()
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.leaseCount--
      if (this.leaseCount === 0) { this.leaseAssetId = undefined; this.scheduleIdleUnload() }
      this.emitChanged()
    }
    try {
      signal?.throwIfAborted()
      const asset = this.requireInstalledAsset(assetId)
      if (!asset.enabled || !this.capabilityMatches(asset)) throw new Error('本地模型尚未启用或能力检查已失效，请重新测试')
      await this.ready(assetId, signal, true)
      signal?.throwIfAborted()
      const entry = this.requireCatalogEntry(assetId)
      if (!this.server) throw new Error('本地模型运行时未就绪')
      return { endpoint: { ...this.server.endpoint }, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens, release }
    } catch (error) { release(); if (!this.leaseCount && this.leaseLoading && this.transition) void this.stopManaged().catch(() => undefined); throw error }
  }

  /** 仅供本服务内部生命周期调用，不将裸端点交给无租约请求。 */
  private async ready(assetId: string, signal?: AbortSignal, forLease = false): Promise<void> {
    if (this.stopping) await waitWithSignal(this.stopping, signal)
    if (this.transition) await waitWithSignal(this.transition, signal)
    signal?.throwIfAborted()
    this.leaseLoading = forLease
    const pending = this.startManaged(assetId)
    void pending.then(() => { this.leaseLoading = false }, () => { this.leaseLoading = false })
    await waitWithSignal(pending, signal)
  }

  /** 返回固定资产 ID 的可信目录项，不接受 modelId 别名。 */
  getModelCatalogEntry(assetId: string): LocalModelCatalogEntry | undefined {
    return { ...this.requireCatalogEntry(assetId) }
  }

  /** 比较探测完整输入，旧版本或任一运行参数改变均失效。 */
  private capabilityMatches(asset: LocalModelAsset): boolean {
    const entry = this.catalog.find((item) => item.assetId === asset.assetId)
    const evidence = asset.capability as LocalModelCapabilityEvidence & { contextWindow?: number }
    const engine = this.resolveEngine()
    return !!engine.enginePath && !!engine.engineVersion && !!entry && asset.sha256 === entry.sha256 && evidence.state === 'available' && evidence.assetSha256 === entry.sha256 && evidence.engineVersion === engine.engineVersion && evidence.chatTemplate === (entry.chatTemplate ?? 'gguf-embedded') && evidence.contextWindow === entry.contextWindow && evidence.probeVersion === PROBE_VERSION
  }

  /** 固定执行聊天、工具调用及结果往返、严格 JSON 三项；不允许输入跳过检查。 */
  async test(input: LocalModelTestInput): Promise<LocalModelTestResult> {
    this.assertEngineReadyForModelOperation()
    const release = this.lockTest()
    let reason: LocalModelCapabilityEvidence['reason'] = 'load-failed'
    let asset: LocalModelAsset | undefined
    let entry: LocalModelCatalogEntry | undefined
    let evidence: (LocalModelCapabilityEvidence & { contextWindow: number }) | undefined
    try {
      asset = this.requireInstalledAsset(input.assetId)
      entry = this.requireCatalogEntry(input.assetId)
      evidence = { state: 'unavailable', assetSha256: asset.sha256, engineVersion: this.resolveEngine().engineVersion,
        chatTemplate: entry.chatTemplate ?? 'gguf-embedded', contextWindow: entry.contextWindow,
        probeVersion: PROBE_VERSION, checkedAt: this.now() }

      await this.ready(asset!.assetId)
      const endpoint = this.server!.endpoint
      reason = 'chat-failed'
      const reply = extractReply(await this.request(endpoint, { messages: [{ role: 'user', content: input.prompt || 'Say hello.' }] }))
      if (!reply) throw new Error('普通回复测试失败')
      reason = 'tool-call-failed'
      const messages: Array<Record<string, unknown>> = [{ role: 'user', content: 'Call dutydeck_probe with value 7. After receiving its result, reply with exactly the result token.' }]
      const tools = [{ type: 'function', function: { name: 'dutydeck_probe', description: 'Return a result token.', parameters: { type: 'object', properties: { value: { type: 'integer', enum: [7] } }, required: ['value'], additionalProperties: false } } }]
      const response = await this.request(endpoint, { messages, tools, tool_choice: { type: 'function', function: { name: 'dutydeck_probe' } } })
      const message = extractMessage(response)
      const calls = message?.tool_calls
      if (!Array.isArray(calls) || calls.length !== 1) throw new Error('工具调用测试失败')
      const call = calls[0] as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }
      if (typeof call.id !== 'string' || !call.id || call.type !== 'function' || call.function?.name !== 'dutydeck_probe' || typeof call.function.arguments !== 'string') throw new Error('工具调用结构无效')
      const args: unknown = JSON.parse(call.function.arguments)
      if (!args || typeof args !== 'object' || Array.isArray(args) || (args as Record<string, unknown>).value !== 7 || Object.keys(args).length !== 1) throw new Error('工具调用参数无效')
      const token = `probe_${randomUUID().replaceAll('-', '')}`
      const roundtrip = extractReply(await this.request(endpoint, { messages: [...messages, { ...message, role: 'assistant' }, { role: 'tool', tool_call_id: call.id, content: token }], tools, tool_choice: 'none' }))
      if (roundtrip?.trim() !== token) throw new Error('工具结果往返测试失败')
      reason = 'json-failed'
      const json = extractReply(await this.request(endpoint, { messages: [{ role: 'user', content: 'Return exactly {"ok":true,"value":7} as JSON.' }], response_format: { type: 'json_object' } }))
      const parsed: unknown = json ? JSON.parse(json) : null
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>).ok !== true || (parsed as Record<string, unknown>).value !== 7 || Object.keys(parsed).length !== 2) throw new Error('JSON 输出测试失败')
      if (this.closed || !this.server || !this.runtime.endpointReady) throw new Error('本地运行时已关闭或进程退出')
      evidence.state = 'available'
      const checked = this.store.updateCapability(asset!.assetId, evidence!)
      this.emitChanged()
      return { success: true, assetId: asset!.assetId, reply, toolCallSupported: true, jsonSupported: true, capability: checked.capability, message: '普通回复、工具往返与 JSON 检查通过' }
    } catch (error) {
      if (!asset || !evidence) { release(); throw error }
      if (toErrorMessage(error).includes('内存不足')) reason = 'memory'
      const checked = this.store.updateCapability(asset.assetId, { ...evidence, reason })
      this.emitChanged()
      return { success: false, assetId: asset!.assetId, capability: checked.capability, message: toErrorMessage(error) }
    } finally { release() }
  }

  /** 仅开启已安装资产；不会因为测试通过而隐式启用。 */
  setEnabled(assetId: string, enabled: boolean): LocalModelAsset {
    if (enabled) this.assertEngineReadyForModelOperation()
    const installed = this.requireInstalledAsset(assetId)
    if (enabled && !this.capabilityMatches(installed)) throw new Error('请先完成当前模型和引擎的能力测试')
    const asset = this.store.setEnabled(assetId, enabled)
    this.emitChanged()
    return asset
  }

  /** 返回主进程内部受管请求，附带短期 token。 */
  private async request(endpoint: LocalModelRuntimeEndpoint, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.localFetchImpl(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: endpoint.modelId, temperature: 0, max_tokens: 512, ...body }),
      signal: AbortSignal.any([AbortSignal.timeout(this.healthTimeoutMs), ...(this.lifecycle ? [this.lifecycle.signal] : [])]),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`本地模型请求失败（HTTP ${response.status}）`) }
    if (!response.body) throw new Error('本地模型返回空响应')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const chunk = await reader.read()
        this.lifecycle?.signal.throwIfAborted()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > 1024 * 1024) throw new Error('本地模型探测响应超过大小上限')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
    const text = Buffer.concat(chunks).toString('utf8')
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      throw new Error('本地模型返回不是有效 JSON', { cause: error })
    }
  }

  /** 轮询本地健康端点，避免模型尚未加载就把端点交给 Pi。 */
  private async waitForHealth(endpoint: LocalModelRuntimeEndpoint, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      try {
        const response = await this.localFetchImpl(`${endpoint.baseUrl.replace(/\/v1$/, '')}/health`, {
          headers: { Authorization: `Bearer ${endpoint.token}` },
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
        })
        signal.throwIfAborted()
        await response.body?.cancel()
        if (response.ok) return
      } catch {
        signal.throwIfAborted()
        // 启动窗口内连接失败是预期状态，直到截止时间再报告稳定错误。
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('本地模型加载超时，请检查内存和引擎日志')
  }

  /** 将目录项或进行中任务转换为 renderer 可见资产。 */
  private toVisibleAsset(entry: LocalModelCatalogEntry, saved?: LocalModelAsset, operation?: TransientOperationState): LocalModelAsset {
    return {
      assetId: entry.assetId, modelId: entry.modelId, name: entry.name, family: entry.family,
      revision: entry.revision, fileName: this.resolveFileName(entry), sha256: entry.sha256,
      sizeBytes: entry.sizeBytes, status: operation?.state ?? saved?.status ?? 'not-installed',
      enabled: saved?.enabled ?? false, capability: saved?.capability ?? { state: 'unknown' },
      updatedAt: saved?.updatedAt ?? this.now(),
      ...(operation?.message ? { lastError: operation.message } : {}),
    }
  }

  /** 只允许清单中的稳定资产 ID 进入下载或启动。 */
  private requireCatalogEntry(assetId: string): LocalModelCatalogEntry {
    const entry = this.catalog.find((candidate) => candidate.assetId === assetId)
    if (!entry) throw new Error(`本地模型目录不存在: ${assetId}`)
    return entry
  }

  /** 只允许清单已登记并存在于磁盘的模型启动。 */
  private requireInstalledAsset(assetId: string): LocalModelAsset {
    const entry = this.requireCatalogEntry(assetId)
    const asset = this.store.getAsset(assetId)
    if (!asset || !['installed', 'starting', 'running', 'stopping', 'error'].includes(asset.status) || this.downloadControllers.has(assetId) || asset.sha256 !== entry.sha256 || asset.sizeBytes !== entry.sizeBytes || asset.modelId !== entry.modelId || asset.revision !== entry.revision || asset.fileName !== this.resolveFileName(entry)) {
      throw new Error(`本地模型尚未完成下载和校验: ${assetId}`)
    }
    const filePath = this.store.resolveAssetFilePath(asset.assetId, asset.fileName)
    if (!existsSync(filePath)) throw new Error(`本地模型文件缺失，请重新下载: ${asset.assetId}`)
    return asset
  }

  /** 从下载 URL 推导单段文件名，禁止清单把路径写入模型资产。 */
  private resolveFileName(entry: LocalModelCatalogEntry): string {
    const candidate = basename(new URL(entry.downloadUrl).pathname)
    return candidate && candidate !== '.' && candidate !== '..' ? candidate : `${entry.assetId}.gguf`
  }

  /** 删除 staging 文件；错误路径不会影响正式资产。 */
  private removeStagingFile(path: string): void {
    try { if (existsSync(path)) rmSync(path, { force: true }) } catch { /* 清理失败由下一次启动恢复流程处理。 */ }
  }

  /** 读取当前引擎快照；旧测试未注入 manager 时继续支持静态引擎依赖。 */
  private engineSnapshot(): LocalModelSnapshot['engine'] {
    if (this.engineManager) return this.engineManager.snapshot()
    const available = !!this.enginePath && !!this.engineVersion?.trim()
    return {
      state: available ? 'installed' : 'not-installed',
      available,
      platform: process.platform,
      arch: process.arch,
      source: available ? 'bundled' : 'none',
      version: this.engineVersion,
      ...(!available ? { message: '当前未提供经过校验的本地运行环境' } : {}),
    }
  }

  /** 解析实际启动路径；用户按需安装的引擎优先于随包引擎。 */
  private resolveEngine(): { enginePath?: string; engineVersion?: string; message?: string } {
    return this.engineManager?.resolveEngine() ?? { enginePath: this.enginePath, engineVersion: this.engineVersion, ...(!this.enginePath || !this.engineVersion?.trim() ? { message: '当前未提供经过校验的本地运行环境' } : {}) }
  }

  /** 生产运行时启用按需引擎时，模型操作必须先经过引擎路径和版本校验。 */
  private assertEngineReadyForModelOperation(): void {
    if (!this.engineManager) return
    const engine = this.resolveEngine()
    if (!engine.enginePath || !engine.engineVersion?.trim()) throw new Error(engine.message ?? '本地运行环境尚未安装或校验失败')
  }

  /** 向主进程内部观察者发送最新状态。 */
  private emitChanged(): void {
    const snapshot = this.listSnapshot()
    for (const listener of [this.onChanged, ...this.snapshotListeners]) { try { listener?.(snapshot) } catch { /* 观察者错误不能破坏受管生命周期。 */ } }
  }

  /** 向主进程内部观察者发送下载进度。 */
  private emitProgress(event: LocalModelProgressEvent): void {
    for (const listener of [this.onProgress, ...this.progressListeners]) { try { listener?.(event) } catch { /* 观察者错误不能中断文件写入。 */ } }
  }
}

/** 可取消地等待已有生命周期操作；取消等待不抢占其它调用方的手动启动。 */
async function waitWithSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return pending
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([pending, cancelled]) } finally { signal.removeEventListener('abort', abort) }
}

/** 从 OpenAI 兼容响应读取第一条文本内容。 */
function extractReply(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const message = (choices[0] as { message?: unknown } | undefined)?.message
  if (!message || typeof message !== 'object') return undefined
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' && content.trim() ? content.trim() : undefined
}

/** 读取响应消息，交由工具能力验证严格检查字段。 */
function extractMessage(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const choices = (value as { choices?: unknown }).choices
  const message = Array.isArray(choices) ? (choices[0] as { message?: unknown } | undefined)?.message : undefined
  return message && typeof message === 'object' ? message as Record<string, unknown> : undefined
}

/** 将未知异常收敛成不会泄漏 token 的短诊断。 */
function toErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]').slice(0, 500)
}

/** 申请一个尚未监听的回环端口，避免静态端口与用户服务冲突。 */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : undefined
      server.close((error) => {
        if (error || port === undefined) reject(error ?? new Error('无法申请本地端口'))
        else resolve(port)
      })
    })
  })
}

/** 保留 node:child_process 的类型引用，确保打包前检查不会把 native 进程误当 renderer API。 */
export type LocalModelChildProcess = ChildProcess
