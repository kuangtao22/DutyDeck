/**
 * 存储管理服务
 *
 * 提供磁盘用量统计和临时文件清理功能。
 * 孤儿数据只允许设置面板显式预览和确认，启动时自动清理仅处理归档会话。
 * 由设置面板"磁盘管理"Tab 和启动时自动清理逻辑调用。
 */

import { existsSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { rmSyncWithRetry } from './fs-retry'
import { promises as fsPromises } from 'node:fs'
import { join, basename, relative, isAbsolute, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import {
  getConfigDir,
  getAgentSessionsDir,
  getSdkConfigDir,
  getPiSessionsDir,
  getAgentWorkspacesDir,
  getAttachmentsDir,
  getConversationsDir,
  resolveAgentSessionWorkspacePath,
} from './config-paths'
import { getAgentSessionMeta, listAgentSessions } from './agent-session-manager'
import { deleteAgentSession } from './agent-session-manager'
import { isAgentSessionBusy } from './agent-service'
import { getAgentWorkspace, listAgentWorkspaces } from './agent-workspace-manager'
import {
  executeStorageCleanup as executeStorageCleanupCore,
  previewStorageCleanup as previewStorageCleanupCore,
  type StorageCleanupContext,
  type StorageCleanupSessionSnapshot,
} from './storage-cleanup'
import { buildStorageProjectUsage, type StorageSessionUsageInput } from './storage-usage'
import { measureStorageWorkspace, type StorageWorkspaceSize } from './storage-size'
import type {
  StorageCleanupExecuteRequest,
  StorageCleanupPreview,
  StorageCleanupPreviewOptions,
  StorageCleanupResult,
  StorageProjectUsage,
  StorageOverview,
  StorageSessionWorkspaceTarget,
} from '../../types/settings'

// ─── 类型定义 ───

export type StorageCategoryKey =
  | 'agent-sessions'
  | 'sdk-config'
  | 'workspaces'
  | 'conversations'
  | 'attachments'
  | 'temp-files'

export interface StorageCategory {
  label: string
  key: StorageCategoryKey
  bytes: number
  count: number
  hasOrphans: boolean
  orphanBytes: number
  orphanCount: number
  orphanItems: StorageOrphanItem[]
  orphanItemsTruncated: boolean
}

export interface StorageOrphanItem {
  kind: 'file' | 'directory'
  path: string
  bytes: number
  count: number
}

export interface StorageStats {
  categories: StorageCategory[]
  totalBytes: number
  calculatedAt: number
  sessionProjects: StorageProjectUsage[]
  sizeEstimateIncomplete: boolean
}

export interface CleanupOptions {
  categories: StorageCategoryKey[]
  orphansOnly: boolean
  archivedBeforeDays: number
}

export interface CleanupResult {
  freedBytes: number
  deletedCount: number
  errors: string[]
}

/** 主进程内存中的短期预览缓存；应用重启后预览自然失效，不保存到磁盘。 */
const storageCleanupPreviews = new Map<string, StorageCleanupPreview>()
const STORAGE_PREVIEW_TTL_MS = 60 * 60 * 1000

/**
 * 从会话索引解析现存的受管工作目录，不接受渲染进程提供的路径，也不创建目录。
 * @param sessionId 要打开的会话 ID。
 * @returns 已确认存在的受管目录绝对路径和所属项目 ID。
 */
export async function resolveStorageSessionWorkspace(sessionId: string): Promise<StorageSessionWorkspaceTarget> {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId)) {
    throw new Error('无效的会话 ID')
  }
  /** 会话和工作区都从主进程索引重新读取，避免信任扫描时的过期路径。 */
  const session = getAgentSessionMeta(sessionId)
  /** 只有仍属于某个受管工作区的会话才能打开其工作目录。 */
  const workspace = session?.workspaceId ? getAgentWorkspace(session.workspaceId) : undefined
  if (!workspace) throw new Error('会话或所属项目已不存在')

  /** 工作区 slug 必须是数据根下的单层目录。 */
  const root = resolve(getConfigDir(), 'agent-workspaces')
  /** 使用 resolve 和 relative 同时验证路径层级。 */
  const workspacePath = resolve(root, workspace.slug)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(workspace.slug)
    || relative(root, workspacePath) !== workspace.slug) {
    throw new Error('工作区路径无效')
  }
  /** 只读解析会话目录，避免点击打开时意外创建空目录。 */
  const sessionPath = resolveAgentSessionWorkspacePath(workspace.slug, sessionId)
  for (const directory of [root, workspacePath, sessionPath]) {
    try {
      /** 每一层均拒绝符号链接，防止文件管理器被引到受管目录之外。 */
      const stat = await fsPromises.lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('工作目录路径不是安全的文件夹')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('工作目录不存在，可能已经被清理')
      throw error
    }
  }
  return { path: sessionPath, workspaceId: workspace.id }
}

/** 将当前索引投影为清理所需的最小快照，并解析受管工作区 slug。 */
function getStorageSessionSnapshots(): StorageCleanupSessionSnapshot[] {
  const workspaces = listAgentWorkspaces()
  const workspaceSlugs = new Map(workspaces.map((workspace) => [workspace.id, workspace.slug]))
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  return listAgentSessions().map((session) => ({
    id: session.id,
    title: session.title,
    archived: session.archived === true,
    starred: session.starred === true,
    pinned: session.pinned === true,
    updatedAt: session.updatedAt,
    workspaceSlug: session.workspaceId ? workspaceSlugs.get(session.workspaceId) : undefined,
    workspaceName: session.workspaceId ? workspaceNames.get(session.workspaceId) : undefined,
    piSessionFile: session.piSessionFile,
  }))
}

/**
 * 构建清理核心依赖，所有路径均来自活动数据根和受管索引。
 * @param workspaceSizeCache 本轮占用统计的目录计量缓存；不传则单独扫描。
 * @returns 清理预览或执行使用的当前会话快照和操作函数。
 */
function createStorageCleanupContext(workspaceSizeCache?: Map<string, StorageWorkspaceSize>): StorageCleanupContext {
  const sessions = getStorageSessionSnapshots()
  return {
    agentSessionsDir: getAgentSessionsDir(),
    agentWorkspacesDir: getAgentWorkspacesDir(),
    piSessionsDir: getPiSessionsDir(),
    sessions,
    runningSessionIds: new Set(sessions.filter((session) => isAgentSessionBusy(session.id)).map((session) => session.id)),
    workspaceSizeCache,
    // 归档清理只删除运行产物，保留用户可恢复的工作台资料。
    deleteAgentSession: (sessionId) => deleteAgentSession(sessionId, { preserveSessionArtifacts: true }),
    getCurrentSessions: getStorageSessionSnapshots,
    getRunningSessionIds: () => new Set(getStorageSessionSnapshots().filter((session) => isAgentSessionBusy(session.id)).map((session) => session.id)),
  }
}

/** 删除过期的内存预览，避免用户长期打开设置页时积累候选快照。 */
function pruneStorageCleanupPreviews(now = Date.now()): void {
  for (const [id, preview] of storageCleanupPreviews) {
    if (now - preview.generatedAt > STORAGE_PREVIEW_TTL_MS) storageCleanupPreviews.delete(id)
  }
}

/** 生成只读清理预览，并缓存一个短期确认令牌。 */
export async function previewStorageCleanup(options: StorageCleanupPreviewOptions): Promise<StorageCleanupPreview> {
  const now = Date.now()
  pruneStorageCleanupPreviews(now)
  const context = createStorageCleanupContext()
  const generated = await previewStorageCleanupCore(context, options, now)
  const preview: StorageCleanupPreview = { ...generated, operationId: randomUUID() }
  storageCleanupPreviews.set(preview.operationId, preview)
  return preview
}

/**
 * 同一轮共享会话索引和目录计量，同时生成两枚独立的清理确认令牌。
 * @returns 存储占用、归档预览和孤儿预览；不执行删除。
 */
export async function scanStorageOverview(): Promise<StorageOverview> {
  pruneStorageCleanupPreviews()
  const workspaceSizeCache = new Map<string, StorageWorkspaceSize>()
  const context = createStorageCleanupContext(workspaceSizeCache)
  const stats = await calculateStorageStats(context)
  const now = Date.now()
  /** 与旧设置页相同的候选期限和数量上限。 */
  const options = { beforeDays: 0, gracePeriodMs: 7 * 24 * 60 * 60 * 1000, maxCandidates: 2_000 }
  const archived = await previewStorageCleanupCore(context, { ...options, mode: 'archived' }, now)
  const orphaned = await previewStorageCleanupCore(context, { ...options, mode: 'orphaned' }, now)
  const archivedPreview: StorageCleanupPreview = { ...archived, operationId: randomUUID() }
  const orphanPreview: StorageCleanupPreview = { ...orphaned, operationId: randomUUID() }
  storageCleanupPreviews.set(archivedPreview.operationId, archivedPreview)
  storageCleanupPreviews.set(orphanPreview.operationId, orphanPreview)
  return { stats, archivedPreview, orphanPreview }
}

/** 执行主进程缓存的清理预览；请求只允许选择预览中已有的候选 ID。 */
export async function executeStorageCleanup(request: StorageCleanupExecuteRequest): Promise<StorageCleanupResult> {
  pruneStorageCleanupPreviews()
  const preview = storageCleanupPreviews.get(request.operationId)
  if (!preview) {
    return {
      operationId: request.operationId,
      freedBytes: 0,
      deletedCount: 0,
      skippedCount: 0,
      errors: ['清理预览已过期，请重新扫描后再执行'],
    }
  }
  const result = await executeStorageCleanupCore(preview, createStorageCleanupContext(), request.candidateIds)
  storageCleanupPreviews.delete(request.operationId)
  return result
}

// ─── 工具函数 ───

// 扫描时跳过的已知大型目录，防止超大工作区阻塞主进程事件循环
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.nuxt', '.git', 'dist', 'build',
  '.cache', '__pycache__', '.venv', 'venv', '.tox', 'target', '.gradle',
  '.turbo', '.parcel-cache', '.svelte-kit', '.output',
])

// 单次扫描最大文件数上限，防止超大工作区导致无限递归
const MAX_FILE_SCAN = 100_000
const STAT_CONCURRENCY = 16
const WORKSPACE_CONCURRENCY = 4
const MAX_ORPHAN_ITEM_PREVIEW = 80

// 孤儿目录无法可靠区分用户仍需保留的会话工作资料，默认不展示也不允许删除。
const ORPHAN_DATA_CLEANUP_ENABLED = false

const WORKSPACE_METADATA_DIRS = new Set([
  'workspace-files',
  'skills',
  'skills-inactive',
  '.claude',
])

// 历史会话保留 `.context/`；新 workbench 根布局保留私有任务资料，附件仍可清理。
const PRESERVED_ORPHAN_SESSION_ENTRIES = new Set([
  '.context',
  'plan',
  'todo.md',
  'note.md',
  'handoff.md',
])

function isWorkspaceMetadataDir(entryName: string): boolean {
  return WORKSPACE_METADATA_DIRS.has(entryName)
}

function displayStoragePath(filePath: string): string {
  const configDir = getConfigDir()
  const rel = relative(configDir, filePath)
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    return `~/${basename(configDir)}/${rel.split(/[\\/]/).join('/')}`
  }
  return filePath
}

function addOrphanItem(items: StorageOrphanItem[], item: StorageOrphanItem): boolean {
  if (items.length >= MAX_ORPHAN_ITEM_PREVIEW) return true
  items.push(item)
  return false
}

async function getDirSize(
  dirPath: string,
  options: { skipTopLevelDirs?: Set<string> } = {}
): Promise<{ bytes: number; count: number }> {
  let bytes = 0
  let count = 0
  if (!existsSync(dirPath)) return { bytes, count }

  // limit 对象通过闭包在整个递归树内共享，作为全局文件计数上限
  const limit = { remaining: MAX_FILE_SCAN }

  async function walk(dir: string, depth: number): Promise<void> {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      /** 普通文件并发读取元数据，目录仍逐层遍历以保持全树上限。 */
      const files = entries.filter((entry) => entry.isFile())
      for (let index = 0; index < files.length && limit.remaining > 0; index += STAT_CONCURRENCY) {
        const batch = files.slice(index, index + Math.min(STAT_CONCURRENCY, limit.remaining))
        const sizes = await Promise.all(batch.map(async (entry) => {
          try {
            const stat = await fsPromises.lstat(join(dir, entry.name))
            return stat.isFile() && !stat.isSymbolicLink() ? stat.size : null
          } catch {
            return null
          }
        }))
        for (const size of sizes) {
          if (size === null) continue
          bytes += size
          count++
          limit.remaining--
        }
      }
      for (const entry of entries) {
        if (limit.remaining <= 0) return
        const fullPath = join(dir, entry.name)
        try {
          if (entry.isDirectory()) {
            if (depth === 0 && options.skipTopLevelDirs?.has(entry.name)) continue
            if (SKIP_DIRS.has(entry.name)) continue
            await walk(fullPath, depth + 1)
          }
        } catch { /* skip inaccessible */ }
      }
    } catch { /* skip inaccessible dir */ }
  }

  await walk(dirPath, 0)
  return { bytes, count }
}

function safeUnlink(filePath: string): number {
  try {
    const size = statSync(filePath).size
    unlinkSync(filePath)
    return size
  } catch {
    return 0
  }
}

async function safeRmDir(dirPath: string): Promise<number> {
  try {
    const { bytes } = await getDirSize(dirPath)
    rmSyncWithRetry(dirPath, { recursive: true, force: true })
    return bytes
  } catch {
    return 0
  }
}

async function cleanupOrphanSessionWorkspaceDir(sessionDir: string): Promise<number> {
  let freedBytes = 0
  let deletedAny = false

  try {
    const entries = await fsPromises.readdir(sessionDir)
    for (const entry of entries) {
      if (PRESERVED_ORPHAN_SESSION_ENTRIES.has(entry)) continue
      const entryPath = join(sessionDir, entry)
      try {
        const stat = await fsPromises.lstat(entryPath)
        if (stat.isDirectory()) {
          freedBytes += await safeRmDir(entryPath)
          deletedAny = true
        } else if (stat.isFile()) {
          const freed = safeUnlink(entryPath)
          freedBytes += freed
          deletedAny = true
        }
      } catch { /* skip */ }
    }

    const remaining = await fsPromises.readdir(sessionDir)
    if (remaining.length === 0) {
      rmSyncWithRetry(sessionDir, { recursive: true, force: true })
    }
  } catch {
    return 0
  }

  return deletedAny ? freedBytes : 0
}

// ─── 统计 ───

/** 获取当前索引中的会话 ID，兼容旧版孤儿清理入口。 */
function getActiveSessionIds(): Set<string> {
  return new Set(listAgentSessions().map((s) => s.id))
}

/** 获取当前索引中的项目 slug，兼容旧版孤儿清理入口。 */
function getActiveWorkspaceSlugs(): Set<string> {
  return new Set(listAgentWorkspaces().map((w) => w.slug))
}

async function calcAgentSessionsCategory(
  sessionSnapshots: readonly StorageCleanupSessionSnapshot[],
  sessionUsage: Map<string, StorageSessionUsageInput>,
): Promise<StorageCategory> {
  const dir = getAgentSessionsDir()
  const activeIds = new Set(sessionSnapshots.map((session) => session.id))
  let bytes = 0, count = 0, orphanBytes = 0, orphanCount = 0
  const orphanItems: StorageOrphanItem[] = []
  let orphanItemsTruncated = false

  if (existsSync(dir)) {
    try {
      const files = await fsPromises.readdir(dir)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const fullPath = join(dir, file)
        try {
          const stat = await fsPromises.stat(fullPath)
          const id = basename(file, '.jsonl')
          bytes += stat.size
          count++
          const usage = sessionUsage.get(id)
          if (usage) usage.transcriptBytes = stat.size
          if (ORPHAN_DATA_CLEANUP_ENABLED && !activeIds.has(id)) {
            orphanBytes += stat.size
            orphanCount++
            orphanItemsTruncated = addOrphanItem(orphanItems, {
              kind: 'file',
              path: displayStoragePath(fullPath),
              bytes: stat.size,
              count: 1,
            }) || orphanItemsTruncated
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return {
    label: 'Agent 会话记录',
    key: 'agent-sessions',
    bytes, count,
    hasOrphans: orphanCount > 0,
    orphanBytes, orphanCount,
    orphanItems, orphanItemsTruncated,
  }
}

async function calcSdkConfigCategory(): Promise<StorageCategory> {
  const sdkDir = getSdkConfigDir()
  let bytes = 0, count = 0, orphanBytes = 0, orphanCount = 0
  const orphanItems: StorageOrphanItem[] = []
  let orphanItemsTruncated = false

  // sdk-config 其他子目录（sessions, backups 等）
  if (existsSync(sdkDir)) {
    try {
      const entries = await fsPromises.readdir(sdkDir)
      for (const entry of entries) {
        // Claude legacy artifacts are intentionally retained but no longer managed by Pi.
        if (entry === 'projects' || entry === 'file-history') continue
        const fullPath = join(sdkDir, entry)
        try {
          const stat = await fsPromises.lstat(fullPath)
          if (stat.isDirectory()) {
            const sub = await getDirSize(fullPath)
            bytes += sub.bytes
            count += sub.count
          } else {
            bytes += stat.size
            count++
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return {
    label: 'SDK 会话数据',
    key: 'sdk-config',
    bytes, count,
    hasOrphans: orphanCount > 0,
    orphanBytes, orphanCount,
    orphanItems, orphanItemsTruncated,
  }
}

async function calcWorkspacesCategory(
  sessionSnapshots: readonly StorageCleanupSessionSnapshot[],
  sessionUsage: Map<string, StorageSessionUsageInput>,
  workspaceSizeCache: Map<string, StorageWorkspaceSize>,
): Promise<StorageCategory> {
  const wsDir = getAgentWorkspacesDir()
  const activeIds = new Set(sessionSnapshots.map((session) => session.id))
  const activeSlugs = new Set(sessionSnapshots.flatMap((session) => session.workspaceSlug ? [session.workspaceSlug] : []))
  let bytes = 0, count = 0, orphanBytes = 0, orphanCount = 0
  const orphanItems: StorageOrphanItem[] = []
  let orphanItemsTruncated = false

  if (existsSync(wsDir)) {
    try {
      const slugs = await fsPromises.readdir(wsDir)
      for (const slug of slugs) {
        const slugDir = join(wsDir, slug)
        try {
          if (!(await fsPromises.lstat(slugDir)).isDirectory()) continue
          const entries = await fsPromises.readdir(slugDir)
          for (let index = 0; index < entries.length; index += WORKSPACE_CONCURRENCY) {
            await Promise.all(entries.slice(index, index + WORKSPACE_CONCURRENCY).map(async (entry) => {
              const entryPath = join(slugDir, entry)
              try {
                const stat = await fsPromises.lstat(entryPath)
                if (!stat.isDirectory()) {
                  if (stat.isFile()) {
                    bytes += stat.size
                    count++
                  }
                  return
                }
                // 工作区级元目录不属于会话目录，不能按 orphan session 清理。
                if (isWorkspaceMetadataDir(entry)) {
                  const sub = await getDirSize(entryPath)
                  bytes += sub.bytes
                  count += sub.count
                  return
                }
                const sub = await measureStorageWorkspace(entryPath)
                workspaceSizeCache.set(entryPath, sub)
                bytes += sub.bytes
                count += sub.count
                const usage = sessionUsage.get(entry)
                if (usage) usage.workspaceBytes = sub.bytes
                // session 目录的 ID 不在活跃列表中 → 孤儿
                if (ORPHAN_DATA_CLEANUP_ENABLED && !activeIds.has(entry) && !activeSlugs.has(entry) && sub.removableCount > 0) {
                  orphanBytes += sub.removableBytes
                  orphanCount++
                  orphanItemsTruncated = addOrphanItem(orphanItems, {
                    kind: 'directory',
                    path: displayStoragePath(entryPath),
                    bytes: sub.removableBytes,
                    count: sub.removableCount,
                  }) || orphanItemsTruncated
                }
              } catch { /* skip */ }
            }))
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return {
    label: '项目与会话数据',
    key: 'workspaces',
    bytes, count,
    hasOrphans: orphanCount > 0,
    orphanBytes, orphanCount,
    orphanItems, orphanItemsTruncated,
  }
}

async function calcConversationsCategory(): Promise<StorageCategory> {
  const dir = getConversationsDir()
  const { bytes, count } = await getDirSize(dir)
  return {
    label: '对话记录',
    key: 'conversations',
    bytes, count,
    hasOrphans: false,
    orphanBytes: 0, orphanCount: 0,
    orphanItems: [], orphanItemsTruncated: false,
  }
}

async function calcAttachmentsCategory(): Promise<StorageCategory> {
  const dir = getAttachmentsDir()
  const { bytes, count } = await getDirSize(dir)
  return {
    label: '附件文件',
    key: 'attachments',
    bytes, count,
    hasOrphans: false,
    orphanBytes: 0, orphanCount: 0,
    orphanItems: [], orphanItemsTruncated: false,
  }
}

async function calcTempFilesCategory(): Promise<StorageCategory> {
  const previewDir = join(tmpdir(), 'proma-preview')
  const installerDir = join(app.getPath('temp'), 'proma-installers')
  const [preview, installer] = await Promise.all([
    getDirSize(previewDir),
    getDirSize(installerDir),
  ])
  return {
    label: '临时预览/安装文件',
    key: 'temp-files',
    bytes: preview.bytes + installer.bytes,
    count: preview.count + installer.count,
    hasOrphans: false,
    orphanBytes: 0, orphanCount: 0,
    orphanItems: [], orphanItemsTruncated: false,
  }
}

/**
 * 计算各分类和项目会话占用。
 * @param context 可选的同轮清理上下文，用于复用索引及目录计量。
 * @returns 当前存储分类、会话明细与大小估算标记。
 */
export async function calculateStorageStats(context?: StorageCleanupContext): Promise<StorageStats> {
  const sessionSnapshots = context?.sessions ?? getStorageSessionSnapshots()
  const workspaceSizeCache = context?.workspaceSizeCache ?? new Map<string, StorageWorkspaceSize>()
  const sessionUsage = new Map<string, StorageSessionUsageInput>(sessionSnapshots.map((session) => [session.id, {
    sessionId: session.id,
    title: session.title,
    workspaceSlug: session.workspaceSlug,
    workspaceName: session.workspaceName,
    transcriptBytes: 0,
    workspaceBytes: 0,
    updatedAt: session.updatedAt,
    archived: session.archived,
    starred: session.starred,
    pinned: session.pinned,
  }]))
  const categories = await Promise.all([
    calcAgentSessionsCategory(sessionSnapshots, sessionUsage),
    calcSdkConfigCategory(),
    calcWorkspacesCategory(sessionSnapshots, sessionUsage, workspaceSizeCache),
    calcConversationsCategory(),
    calcAttachmentsCategory(),
    calcTempFilesCategory(),
  ])
  return {
    categories,
    totalBytes: categories.reduce((sum, c) => sum + c.bytes, 0),
    calculatedAt: Date.now(),
    sessionProjects: buildStorageProjectUsage([...sessionUsage.values()]),
    sizeEstimateIncomplete: [...workspaceSizeCache.values()].some((size) => size.truncated),
  }
}

// ─── 清理 ───

export async function cleanupTempFiles(): Promise<CleanupResult> {
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  const previewDir = join(tmpdir(), 'proma-preview')
  if (existsSync(previewDir)) {
    try {
      const files = await fsPromises.readdir(previewDir)
      for (const file of files) {
        const freed = safeUnlink(join(previewDir, file))
        if (freed > 0) { freedBytes += freed; deletedCount++ }
      }
    } catch (e) {
      errors.push(`清理预览文件失败: ${e}`)
    }
  }

  const installerDir = join(app.getPath('temp'), 'proma-installers')
  if (existsSync(installerDir)) {
    try {
      const files = await fsPromises.readdir(installerDir)
      for (const file of files) {
        const freed = safeUnlink(join(installerDir, file))
        if (freed > 0) { freedBytes += freed; deletedCount++ }
      }
    } catch (e) {
      errors.push(`清理安装文件失败: ${e}`)
    }
  }

  if (freedBytes > 0) {
    console.log(`[存储清理] 临时文件: 释放 ${(freedBytes / 1024 / 1024).toFixed(1)} MB, 删除 ${deletedCount} 个文件`)
  }
  return { freedBytes, deletedCount, errors }
}

async function cleanupOrphanAgentSessions(): Promise<CleanupResult> {
  const dir = getAgentSessionsDir()
  const activeIds = getActiveSessionIds()
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  if (!existsSync(dir)) return { freedBytes, deletedCount, errors }

  try {
    const files = await fsPromises.readdir(dir)
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const id = basename(file, '.jsonl')
      if (activeIds.has(id)) continue
      const freed = safeUnlink(join(dir, file))
      if (freed > 0) { freedBytes += freed; deletedCount++ }
    }
  } catch (e) {
    errors.push(`清理孤儿会话文件失败: ${e}`)
  }

  return { freedBytes, deletedCount, errors }
}

async function cleanupOrphanWorkspaces(): Promise<CleanupResult> {
  const wsDir = getAgentWorkspacesDir()
  const activeIds = getActiveSessionIds()
  const activeSlugs = getActiveWorkspaceSlugs()
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  if (!existsSync(wsDir)) return { freedBytes, deletedCount, errors }

  try {
    const slugs = await fsPromises.readdir(wsDir)
    for (const slug of slugs) {
      const slugDir = join(wsDir, slug)
      try {
        if (!(await fsPromises.lstat(slugDir)).isDirectory()) continue
        const entries = await fsPromises.readdir(slugDir)
        for (const entry of entries) {
          if (isWorkspaceMetadataDir(entry)) continue
          const entryPath = join(slugDir, entry)
          try {
            if (!(await fsPromises.lstat(entryPath)).isDirectory()) continue
            if (activeIds.has(entry) || activeSlugs.has(entry)) continue
            const freed = await cleanupOrphanSessionWorkspaceDir(entryPath)
            if (freed > 0) { freedBytes += freed; deletedCount++ }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch (e) {
    errors.push(`清理孤儿项目配置目录失败: ${e}`)
  }

  return { freedBytes, deletedCount, errors }
}

export async function cleanupStorage(options: CleanupOptions): Promise<CleanupResult> {
  if (options.orphansOnly && !ORPHAN_DATA_CLEANUP_ENABLED) {
    return {
      freedBytes: 0,
      deletedCount: 0,
      errors: ['孤儿数据清理功能已默认关闭，未删除任何数据'],
    }
  }

  let totalFreed = 0, totalDeleted = 0
  const allErrors: string[] = []

  const merge = (r: CleanupResult) => {
    totalFreed += r.freedBytes
    totalDeleted += r.deletedCount
    allErrors.push(...r.errors)
  }

  for (const cat of options.categories) {
    if (cat === 'temp-files') {
      merge(await cleanupTempFiles())
      continue
    }

    if (options.orphansOnly) {
      switch (cat) {
        case 'agent-sessions': merge(await cleanupOrphanAgentSessions()); break
        case 'workspaces': merge(await cleanupOrphanWorkspaces()); break
      }
    } else if (options.archivedBeforeDays > 0) {
      if (cat === 'agent-sessions' || cat === 'sdk-config') {
        const preview = await previewStorageCleanup({
          mode: 'archived',
          beforeDays: options.archivedBeforeDays,
          // 启动自动清理沿用同一保留周期，避免刚归档的 artifact 被提前回收。
          gracePeriodMs: options.archivedBeforeDays * 24 * 60 * 60 * 1000,
          maxCandidates: 200,
        })
        const result = await executeStorageCleanup({
          operationId: preview.operationId,
          candidateIds: preview.candidates.map((candidate) => candidate.id),
        })
        merge({ freedBytes: result.freedBytes, deletedCount: result.deletedCount, errors: result.errors })
      }
    }
  }

  if (totalFreed > 0) {
    console.log(`[存储清理] 总计释放 ${(totalFreed / 1024 / 1024).toFixed(1)} MB, 删除 ${totalDeleted} 项`)
  }
  return { freedBytes: totalFreed, deletedCount: totalDeleted, errors: allErrors }
}
