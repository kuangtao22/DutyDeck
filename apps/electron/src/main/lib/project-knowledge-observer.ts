import { watch } from 'node:fs'
import { join } from 'node:path'
import type { KnowledgeWorkflow } from '@proma/shared'
import { listAgentWorkspaces } from './agent-workspace-manager'
import { getConfigDir, resolveWorkspaceFilesDir } from './config-paths'
import { getProjectKnowledgeBinding, getProjectKnowledgeService, recoverProjectKnowledge } from './project-knowledge-runtime'
import { replayWorkspaceMemoryOperations } from './project-knowledge-memory-journal'

const SCAN_INTERVAL_MS = 5 * 60_000
const CHANGE_DEBOUNCE_MS = 500

/** Observer 仅依赖可关闭句柄，便于隔离具体文件系统实现。 */
export interface ProjectKnowledgeWatcher {
  close(): void
}

interface ProjectKnowledgeWorkspace {
  id: string
  slug: string
  projectRootPath?: string | null
}

interface ProjectKnowledgeObserverService {
  getSnapshot(workspaceId: string): Promise<{ initialized: boolean; scan: { status: string }; workflow?: KnowledgeWorkflow }>
  startScan(workspaceId: string): Promise<unknown>
  waitForScan(workspaceId: string): Promise<void>
}

/** 注入文件系统、运行时和时钟，使生命周期与失败补偿可独立验证。 */
export interface ProjectKnowledgeObserverDependencies {
  listWorkspaces(): ProjectKnowledgeWorkspace[]
  getConfigRoot(): string
  resolveWorkspaceFilesDir(slug: string): string
  getBinding(workspaceId: string): string
  getService(): ProjectKnowledgeObserverService
  replayMemoryOperations(slug: string): unknown
  recoverKnowledge(workspaceId: string): Promise<void>
  watchRoot(
    root: string,
    onChange: (filename: string | Buffer | null) => void,
    onError: () => void,
  ): ProjectKnowledgeWatcher
  now(): number
  setTimer(callback: () => void, delay: number): unknown
  clearTimer(timer: unknown): void
}

/** 已初始化项目的轻量观察状态，不持有正文缓存。 */
interface ObservedKnowledgeProject {
  /** 动态资料库根事件只刷新真实文档，不重复扫描原始项目。 */
  vaultRoots: string[]
  /** 数据目录和真实项目绑定变化时需要重新建立监听。 */
  binding: string
  /** 文件监听句柄，平台不支持递归时由定时枚举补偿。 */
  watchers: ProjectKnowledgeWatcher[]
  /** 合并短时间内的多次保存事件。 */
  dirty: boolean
  /** 最近一次成功完成扫描的时间。 */
  lastScanAt: number
}

export interface ProjectKnowledgeObserver {
  /** 串行检查所有已建库项目，并补偿失败的恢复或扫描。 */
  tick(): Promise<void>
  /** 停止后续工作并关闭所有监听句柄。 */
  dispose(): void
}

/** 源目录事件排除内部写入，防止知识库自身产生扫描回环。 */
function affectsSource(filename: string | Buffer | null): boolean {
  if (!filename) return true
  return !/(^|[\/\\])(?:\.proma|\.obsidian|\.git|node_modules|dist|build|\.next|target|vendor|\.cache)(?:[\/\\]|$)/.test(filename.toString())
}

/** 创建可测试的项目知识观察器；只有恢复与监听均结束后才发布初始化状态。 */
export function createProjectKnowledgeObserver(dependencies: ProjectKnowledgeObserverDependencies): ProjectKnowledgeObserver {
  const observed = new Map<string, ObservedKnowledgeProject>()
  let busy = false
  let rerunRequested = false
  let disposed = false
  let debounceTimer: unknown

  /** 文件变化统一走单个 500ms 去抖任务，避免保存风暴触发重复扫描。 */
  const scheduleDebouncedTick = (): void => {
    if (disposed) return
    if (debounceTimer !== undefined) dependencies.clearTimer(debounceTimer)
    debounceTimer = dependencies.setTimer(() => {
      debounceTimer = undefined
      void tick()
    }, CHANGE_DEBOUNCE_MS)
  }

  /** 关闭一代监听句柄；重复关闭由 Map 生命周期保证不会发生。 */
  const closeObserved = (item: ObservedKnowledgeProject): void => {
    for (const watcher of item.watchers) watcher.close()
    item.watchers.length = 0
  }

  /** 为绑定建立新状态；恢复失败时不写入 observed，下一轮会完整重试。 */
  const initialize = async (
    key: string,
    workspace: ProjectKnowledgeWorkspace,
    binding: string,
    vaultRoots: string[],
  ): Promise<ObservedKnowledgeProject | undefined> => {
    dependencies.replayMemoryOperations(workspace.slug)
    await dependencies.recoverKnowledge(workspace.id)
    if (disposed) return undefined

    const item: ObservedKnowledgeProject = { binding, vaultRoots, watchers: [], dirty: true, lastScanAt: 0 }
    const roots = [
      workspace.projectRootPath ?? dependencies.resolveWorkspaceFilesDir(workspace.slug),
      join(dependencies.getConfigRoot(), 'agent-workspaces', workspace.slug, 'memory'),
    ]
    for (const root of roots) {
      if (disposed) break
      try {
        let watcher: ProjectKnowledgeWatcher
        watcher = dependencies.watchRoot(root, (filename) => {
          if (disposed || observed.get(key) !== item || !affectsSource(filename)) return
          /** project-root watcher 的知识目录事件由下一次 snapshot 做有界文件同步。 */
          const changedPath = filename?.toString().replaceAll('\\', '/')
          const isVaultChange = root === roots[0] && changedPath && item.vaultRoots.some((vaultRoot) => (
            changedPath === vaultRoot || changedPath.startsWith(`${vaultRoot}/`)
          ))
          if (!isVaultChange) item.dirty = true
          scheduleDebouncedTick()
        }, () => {
          if (disposed || observed.get(key) !== item) return
          item.dirty = true
          watcher.close()
          item.watchers = item.watchers.filter((candidate) => candidate !== watcher)
          scheduleDebouncedTick()
        })
        item.watchers.push(watcher)
      } catch {
        // 不支持递归监听或目录尚未存在时，定时枚举负责补偿。
      }
    }
    if (disposed) {
      closeObserved(item)
      return undefined
    }
    observed.set(key, item)
    return item
  }

  /** 定时任务串行；并发触发会在当前轮结束后补跑一次。 */
  const tick = async (): Promise<void> => {
    if (disposed) return
    if (busy) {
      rerunRequested = true
      return
    }
    busy = true
    try {
      const workspaces = dependencies.listWorkspaces()
      const active = new Set<string>()
      for (const workspace of workspaces) {
        if (disposed) break
        const key = `${dependencies.getConfigRoot()}\0${workspace.id}`
        active.add(key)
        try {
          const service = dependencies.getService()
          const snapshot = await service.getSnapshot(workspace.id)
          if (disposed) break
          if (!snapshot.initialized) continue

          const binding = dependencies.getBinding(workspace.id)
          /** 每次读取最新计划，目录定制后不固守默认路径。 */
          const vaultRoots = [snapshot.workflow?.approved?.rootRelativePath, snapshot.workflow?.proposal?.rootRelativePath]
            .filter((path): path is string => Boolean(path))
          let item = observed.get(key)
          if (item?.binding !== binding) {
            if (item) closeObserved(item)
            observed.delete(key)
            item = await initialize(key, workspace, binding, vaultRoots)
            if (disposed || !item) break
          }
          item.vaultRoots = vaultRoots

          if (snapshot.scan.status === 'running' || (!item.dirty && dependencies.now() - item.lastScanAt < SCAN_INTERVAL_MS)) continue

          item.dirty = false
          try {
            await service.startScan(workspace.id)
            if (disposed) break
            await service.waitForScan(workspace.id)
            if (disposed) break
            item.lastScanAt = dependencies.now()
          } catch {
            item.dirty = true
          }
        } catch {
          // 离线项目、归属冲突或迁移保持原状态，下次重新验证。
        }
      }
      if (!disposed) {
        for (const [key, item] of observed) {
          if (active.has(key)) continue
          closeObserved(item)
          observed.delete(key)
        }
      }
    } finally {
      busy = false
      if (!disposed && rerunRequested) {
        rerunRequested = false
        void tick()
      }
    }
  }

  return {
    tick,
    dispose: () => {
      if (disposed) return
      disposed = true
      rerunRequested = false
      if (debounceTimer !== undefined) dependencies.clearTimer(debounceTimer)
      debounceTimer = undefined
      for (const item of observed.values()) closeObserved(item)
      observed.clear()
    },
  }
}

/** 启动后只恢复已建库项目；新会话检索不会调用此扫描器。 */
export function startProjectKnowledgeObservation(): () => void {
  const observer = createProjectKnowledgeObserver({
    listWorkspaces: listAgentWorkspaces,
    getConfigRoot: getConfigDir,
    resolveWorkspaceFilesDir,
    getBinding: getProjectKnowledgeBinding,
    getService: getProjectKnowledgeService,
    replayMemoryOperations: replayWorkspaceMemoryOperations,
    recoverKnowledge: recoverProjectKnowledge,
    watchRoot: (root, onChange, onError) => {
      const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => onChange(filename))
      watcher.on('error', onError)
      return watcher
    },
    now: Date.now,
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  })
  /** 让应用首屏与渠道初始化先完成，再进行项目后台枚举。 */
  const initial = setTimeout(() => { void observer.tick() }, 10_000)
  const interval = setInterval(() => { void observer.tick() }, 15_000)
  initial.unref()
  interval.unref()
  return () => {
    clearTimeout(initial)
    clearInterval(interval)
    observer.dispose()
  }
}
