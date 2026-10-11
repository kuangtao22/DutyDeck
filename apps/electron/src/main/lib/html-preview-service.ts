import { basename, dirname } from 'node:path'
import { PromaResourceError, registerPromaResourceHandler, revokePromaPathUrl } from './local-file-protocol'
import type { PromaFileProtocolRegistry } from './local-file-protocol'
import type { StableDirectoryNativeHost, StableDirectoryOpenedRoot } from './stable-directory-native-host'

/** 只依赖窗口生命周期，不把 Electron 对象传给原生读取器。 */
interface HtmlPreviewOwner {
  isDestroyed(): boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

interface HtmlPreviewInput {
  owner: HtmlPreviewOwner
  /** 上游已完成文件 guard 的绝对 canonical 路径。 */
  filePath: string
  /** 每次访问（包括缓存命中）重新检查当前 session 的目标资源权限。 */
  authorize: (root: StableDirectoryOpenedRoot, resourcePath: string) => boolean
}

interface HtmlPreviewDependencies {
  run: StableDirectoryNativeHost['run']
  registry?: Pick<PromaFileProtocolRegistry, 'registerResourceHandler' | 'revokePathUrl'>
  maxCachedBytes?: number
}

interface HtmlPreviewLease {
  owner: HtmlPreviewOwner
  controller: AbortController
  url?: string
  bytes: number
  cache: Map<string, Buffer | null>
  pending: Map<string, Promise<Buffer | null>>
}

/** 创建按窗口拥有、按稳定目录身份读取的 HTML 预览服务。 */
export function createHtmlPreviewService(dependencies: HtmlPreviewDependencies) {
  /** 活跃预览包含仍在初始化的请求，防止窗口退出后的迟到注册。 */
  const leases = new Set<HtmlPreviewLease>()
  const owners = new Map<HtmlPreviewOwner, () => void>()
  const registry = dependencies.registry ?? {
    registerResourceHandler: registerPromaResourceHandler,
    revokePathUrl: revokePromaPathUrl,
  }
  /** 缓存及 helper 队列均由整个服务共享预算，不能按页面无限倍增。 */
  let cachedBytes = 0
  let activeReads = 0
  const queue: Array<{ start: () => void; cancel: () => void }> = []

  /** 最多同时运行两个 helper，为其他目录功能保留 host 槽位。 */
  async function limitedRead<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new Error('HTML 预览已关闭')
    if (activeReads >= 2) {
      if (queue.length >= 128) throw new PromaResourceError('HTML 资源请求过多，请刷新后重试', 429)
      await new Promise<void>((resolve, reject) => {
        const item = {
          start: () => { signal.removeEventListener('abort', item.cancel); resolve() },
          cancel: () => {
            const index = queue.indexOf(item)
            if (index >= 0) queue.splice(index, 1)
            reject(new Error('HTML 预览已关闭'))
          },
        }
        queue.push(item)
        signal.addEventListener('abort', item.cancel, { once: true })
      })
    } else {
      activeReads += 1
    }
    try {
      if (signal.aborted) throw new Error('HTML 预览已关闭')
      return await read()
    } finally {
      const next = queue.shift()
      if (next) next.start()
      else activeReads -= 1
    }
  }

  /** 幂等清空页面快照并停止未完成读取，最后一页关闭后移除窗口监听。 */
  function dispose(lease: HtmlPreviewLease): void {
    if (!leases.delete(lease)) return
    lease.controller.abort()
    cachedBytes -= lease.bytes
    lease.bytes = 0
    lease.cache.clear()
    lease.pending.clear()
    if (lease.url) registry.revokePathUrl(lease.url)
    if (![...leases].some((candidate) => candidate.owner === lease.owner)) {
      owners.get(lease.owner)?.()
      owners.delete(lease.owner)
    }
  }

  /** 注册窗口崩溃、销毁及主文档导航清理；iframe 导航不影响其他页面。 */
  function observeOwner(owner: HtmlPreviewOwner): void {
    if (owners.has(owner)) return
    const close = (): void => {
      for (const lease of [...leases]) if (lease.owner === owner) dispose(lease)
    }
    const navigate = (_event: unknown, _url: unknown, inPlace: unknown, mainFrame: unknown): void => {
      if (mainFrame && !inPlace) close()
    }
    owner.on('destroyed', close)
    owner.on('render-process-gone', close)
    owner.on('did-start-navigation', navigate)
    owners.set(owner, () => {
      owner.removeListener('destroyed', close)
      owner.removeListener('render-process-gone', close)
      owner.removeListener('did-start-navigation', navigate)
    })
  }

  /** 首次稳定读取 HTML 后才发布 opaque URL，所有相对资源沿同一根身份授权。 */
  async function create(input: HtmlPreviewInput): Promise<{ url: string }> {
    if (input.owner.isDestroyed()) throw new Error('预览窗口已关闭')
    if (leases.size >= 32) throw new Error('HTML 预览数量已达上限，请关闭不用的预览')
    const lease: HtmlPreviewLease = {
      owner: input.owner, controller: new AbortController(), bytes: 0, cache: new Map(), pending: new Map(),
    }
    leases.add(lease)
    observeOwner(input.owner)
    const directory = dirname(input.filePath)
    /** 首次 authorize 接收的是 helper 已打开的目录身份，不是路径查询结果。 */
    let boundRoot: StableDirectoryOpenedRoot | undefined

    async function readResource(resourcePath: string): Promise<Buffer | null> {
      if (lease.controller.signal.aborted) throw new Error('HTML 预览已关闭')
      if (!resourcePath || /[\\:\0]/.test(resourcePath)
        || resourcePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error('HTML 资源路径无效')
      }
      if (boundRoot) {
        try {
          if (!input.authorize(boundRoot, resourcePath)) throw new Error('资源不在当前会话的授权范围内')
        } catch (cause) {
          throw new PromaResourceError('HTML 资源不在当前会话的授权范围内', 403, { cause })
        }
      }
      if (lease.cache.has(resourcePath)) return lease.cache.get(resourcePath)!
      const pending = lease.pending.get(resourcePath)
      if (pending) return pending
      if (lease.cache.size + lease.pending.size >= 512) throw new PromaResourceError('HTML 页面资源数量超过限制', 429)
      const reading = limitedRead(lease.controller.signal, async () => {
        /** 区分授权拒绝与 helper 自身故障，保留 cause 供主进程诊断。 */
        let authorizationRejected = false
        const result = await dependencies.run({
          mode: 'preview-resource-read', roots: [directory], resourcePath,
          maxFileBytes: 20 * 1024 * 1024, signal: lease.controller.signal,
        }, (roots) => {
          const root = roots[0]
          authorizationRejected = true
          if (roots.length !== 1 || !root?.isDirectory || root.requestedPath !== directory
            || root.canonicalPath !== directory) return false
          if (boundRoot && (root.volume !== boundRoot.volume || root.fileId !== boundRoot.fileId)) return false
          if (!input.authorize(root, resourcePath)) return false
          boundRoot ??= { ...root }
          authorizationRejected = false
          return true
        }).catch((cause: unknown) => {
          throw new PromaResourceError(
            authorizationRejected ? 'HTML 资源未授权或目录已变化，请刷新预览' : 'HTML 预览读取服务不可用，请重试',
            authorizationRejected ? 403 : 503,
            { cause },
          )
        })
        if (lease.controller.signal.aborted) throw new Error('HTML 预览已关闭')
        const outcome = result.resourceReadOutcome
        if (!outcome) throw new PromaResourceError('HTML 预览读取服务返回无效响应', 503)
        if (outcome.status === 'rejected') {
          const oversized = outcome.error.includes('exceeds byte limit')
          throw new PromaResourceError(oversized ? 'HTML 资源超过 20 MiB 上限' : 'HTML 资源读取被拒绝，文件可能已变化或包含链接',
            oversized ? 413 : 403, { cause: new Error(outcome.error) })
        }
        if (outcome.status === 'missing') {
          lease.cache.set(resourcePath, null)
          return null
        }
        if (lease.bytes + outcome.size > 32 * 1024 * 1024
          || cachedBytes + outcome.size > (dependencies.maxCachedBytes ?? 128 * 1024 * 1024)) {
          throw new PromaResourceError('HTML 预览资源超过内存预算，请关闭其他预览后重试', 413)
        }
        const content = Buffer.from(outcome.contentBase64, 'base64')
        lease.bytes += content.byteLength
        cachedBytes += content.byteLength
        lease.cache.set(resourcePath, content)
        return content
      })
      lease.pending.set(resourcePath, reading)
      try { return await reading } finally { lease.pending.delete(resourcePath) }
    }

    try {
      const fileName = basename(input.filePath)
      if (await readResource(fileName) === null) throw new Error('HTML 文件不存在，请刷新文件列表')
      if (input.owner.isDestroyed() || lease.controller.signal.aborted) throw new Error('预览窗口已关闭')
      const baseUrl = registry.registerResourceHandler(readResource, () => dispose(lease))
      lease.url = `${baseUrl}/${encodeURIComponent(fileName)}`
      return { url: lease.url }
    } catch (error) {
      dispose(lease)
      throw error
    }
  }

  /** 只允许创建该 lease 的窗口撤销，其他窗口或任意 URL 均不扩大权限。 */
  function release(owner: HtmlPreviewOwner, url: string): void {
    for (const lease of leases) {
      if (lease.owner === owner && lease.url === url) { dispose(lease); return }
    }
  }

  return { create, release }
}
