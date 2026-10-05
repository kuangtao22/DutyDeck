/**
 * 会话存储清理核心。
 *
 * 该模块只操作 Proma 自己的数据根，先生成带快照信息的候选，再在执行时重新
 * 校验索引、忙碌状态和文件身份。调用方通过依赖注入提供会话列表与删除函数，
 * 因此扫描策略不会直接修改 Agent 会话缓存。
 */

import { promises as fsPromises } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'
import { measureStorageWorkspace, type StorageWorkspaceSize } from './storage-size'
import type {
  StorageCleanupCandidate,
  StorageCleanupMode,
  StorageCleanupPreview,
  StorageCleanupPreviewOptions,
  StorageCleanupResult,
} from '../../types/settings'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_GRACE_PERIOD_MS = 7 * DAY_MS
const DEFAULT_MAX_CANDIDATES = 200
const MAX_SCAN_ENTRIES = 10_000
/** 会话工作台中需要保留的用户资料，清理只回收其它运行产物。 */
const PRESERVED_SESSION_WORKBENCH_ENTRIES = new Set(['.context', 'plan', 'todo.md', 'note.md', 'handoff.md'])

/** 清理模块读取的最小会话快照，不暴露完整会话索引。 */
export interface StorageCleanupSessionSnapshot {
  id: string
  /** 会话标题，用于让用户在确认前识别候选。 */
  title?: string
  archived: boolean
  /** 标星或置顶会话始终不进入自动/手动清理候选。 */
  starred?: boolean
  pinned?: boolean
  updatedAt: number
  workspaceSlug?: string
  /** 受管项目名称；没有工作区时保持未定义。 */
  workspaceName?: string
  piSessionFile?: string
}

/** 清理模块的文件系统和会话依赖。生产环境由 storage-service 注入。 */
export interface StorageCleanupContext {
  agentSessionsDir: string
  agentWorkspacesDir: string
  piSessionsDir: string
  sessions: readonly StorageCleanupSessionSnapshot[]
  runningSessionIds: ReadonlySet<string>
  /** 同一轮占用统计已测量的会话目录；只供只读预览复用。 */
  workspaceSizeCache?: Map<string, StorageWorkspaceSize>
  /** 删除会话时复用 Agent 会话管理器的索引、JSONL 和工作目录语义。 */
  deleteAgentSession: (sessionId: string) => void
  /** 执行阶段重新读取索引，避免确认期间使用旧快照。 */
  getCurrentSessions: () => readonly StorageCleanupSessionSnapshot[]
  /** 执行阶段重新读取运行状态，避免删除排队或恢复中的会话。 */
  getRunningSessionIds: () => ReadonlySet<string>
}

/** 规范化用户传入的清理参数，避免负数或无界扫描。 */
function normalizeOptions(options: StorageCleanupPreviewOptions): Required<StorageCleanupPreviewOptions> {
  const mode: StorageCleanupMode = options.mode === 'orphaned' ? 'orphaned' : 'archived'
  const beforeDays = Number.isFinite(options.beforeDays) ? Math.max(0, options.beforeDays) : 0
  const gracePeriodMs = Number.isFinite(options.gracePeriodMs)
    ? Math.max(0, options.gracePeriodMs ?? 0)
    : DEFAULT_GRACE_PERIOD_MS
  const maxCandidates = Number.isFinite(options.maxCandidates)
    ? Math.max(1, Math.min(2_000, Math.floor(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES)))
    : DEFAULT_MAX_CANDIDATES
  return { mode, beforeDays, gracePeriodMs, maxCandidates }
}

/** 判断路径是否仍严格位于指定根目录内。 */
function isContained(rootPath: string, candidatePath: string): boolean {
  const root = resolve(rootPath)
  const candidate = resolve(candidatePath)
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('/') && !rel.startsWith('\\')
}

/** 仅允许应用生成的单段会话 ID，拒绝路径穿越和隐藏目录语义。 */
function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)
}

/** 计算普通文件或目录的实际字节数；目录扫描有硬上限。 */
async function getPathBytes(path: string): Promise<number> {
  let scanned = 0
  const walk = async (current: string): Promise<number> => {
    if (scanned >= MAX_SCAN_ENTRIES) return 0
    const stat = await fsPromises.lstat(current)
    if (stat.isFile()) {
      scanned += 1
      return stat.size
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 0
    const entries = await fsPromises.readdir(current, { withFileTypes: true })
    let total = 0
    for (const entry of entries) {
      if (scanned >= MAX_SCAN_ENTRIES) break
      total += await walk(resolve(current, entry.name))
    }
    return total
  }
  return walk(path)
}

/**
 * 计算会话工作台中可回收条目的大小，保留计划和上下文资料。
 * @param path 会话工作目录。
 * @param cache 同轮统计已读取的目录计量；执行阶段不传入以重新计量。
 * @returns 可回收普通文件的已扫描字节数。
 */
async function getRemovableWorkspaceBytes(
  path: string,
  cache?: Map<string, StorageWorkspaceSize>,
): Promise<number> {
  const cached = cache?.get(path)
  if (cached) return cached.removableBytes
  const measured = await measureStorageWorkspace(path)
  cache?.set(path, measured)
  return measured.removableBytes
}

/** 删除会话工作台中的运行产物并保留用户资料。 */
async function removeRemovableWorkspaceContents(path: string): Promise<number> {
  let freedBytes = 0
  for (const entry of await fsPromises.readdir(path, { withFileTypes: true })) {
    if (PRESERVED_SESSION_WORKBENCH_ENTRIES.has(entry.name)) continue
    const entryPath = resolve(path, entry.name)
    freedBytes += await getPathBytes(entryPath)
    await fsPromises.rm(entryPath, { recursive: true, force: false })
  }
  try {
    if ((await fsPromises.readdir(path)).length === 0) await fsPromises.rm(path, { recursive: true, force: false })
  } catch {
    // 并发删除导致目录消失时视为完成。
  }
  return freedBytes
}

/** 生成候选 ID，执行时不把 renderer 传入的路径当作删除依据。 */
function makeCandidateId(kind: StorageCleanupCandidate['kind'], value: string): string {
  return `${kind}:${value}`
}

/** 将候选加入结果并应用数量上限。 */
async function appendCandidate(
  candidates: StorageCleanupCandidate[],
  candidate: StorageCleanupCandidate,
  maxCandidates: number,
): Promise<boolean> {
  if (candidates.length >= maxCandidates) return false
  candidates.push(candidate)
  return true
}

/** 读取目录中的普通文件候选，跳过符号链接和目录，防止逃逸。 */
async function scanPiArtifacts(
  context: StorageCleanupContext,
  protectedPaths: ReadonlySet<string>,
  cutoff: number,
  candidates: StorageCleanupCandidate[],
  maxCandidates: number,
  errors: string[],
): Promise<boolean> {
  let truncated = false
  let entries
  try {
    entries = await fsPromises.readdir(context.piSessionsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`扫描 Pi artifact 目录失败: ${String(error)}`)
    return false
  }

  for (const entry of entries) {
    if (!entry.name.endsWith('.jsonl')) continue
    const path = resolve(context.piSessionsDir, entry.name)
    if (!isContained(context.piSessionsDir, path)) {
      errors.push(`跳过越界 Pi artifact: ${path}`)
      continue
    }
    try {
      const stat = await fsPromises.lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff) continue
      if (protectedPaths.has(resolve(path))) continue
      const added = await appendCandidate(candidates, {
        kind: 'pi-artifact',
        id: makeCandidateId('pi-artifact', entry.name),
        path,
        bytes: stat.size,
        updatedAt: stat.mtimeMs,
        reason: 'unreferenced-expired',
      }, maxCandidates)
      if (!added) {
        truncated = true
        break
      }
    } catch (error) {
      errors.push(`读取 Pi artifact 失败 (${path}): ${String(error)}`)
    }
  }
  return truncated
}

/** 生成归档会话、工作目录和未引用 Pi artifact 的只读预览。 */
export async function previewStorageCleanup(
  context: StorageCleanupContext,
  options: StorageCleanupPreviewOptions,
  now = Date.now(),
): Promise<Omit<StorageCleanupPreview, 'operationId'>> {
  const normalized = normalizeOptions(options)
  const candidates: StorageCleanupCandidate[] = []
  const errors: string[] = []
  let truncated = false
  /** 目录大小达到文件上限时，候选大小是已扫描部分的估算值。 */
  let sizeEstimateIncomplete = false
  const workspaceSizeCache = context.workspaceSizeCache ?? new Map<string, StorageWorkspaceSize>()
  const sessionCutoff = now - normalized.beforeDays * DAY_MS
  const artifactCutoff = now - normalized.gracePeriodMs
  const sessionsById = new Map(context.sessions.map((session) => [session.id, session]))
  const expiringSessionIds = new Set(
    context.sessions
      .filter((session) => normalized.mode === 'archived' && session.archived && !session.starred && !session.pinned && !context.runningSessionIds.has(session.id) && session.updatedAt <= sessionCutoff)
      .map((session) => session.id),
  )

  if (normalized.mode === 'archived') {
    for (const session of context.sessions) {
      if (!session.archived || session.starred || session.pinned || context.runningSessionIds.has(session.id) || session.updatedAt > sessionCutoff) continue
      if (!isSafeSessionId(session.id)) {
        errors.push(`跳过非法会话 ID: ${session.id}`)
        continue
      }
      const messagePath = resolve(context.agentSessionsDir, `${session.id}.jsonl`)
      if (isContained(context.agentSessionsDir, messagePath)) {
        try {
          const stat = await fsPromises.lstat(messagePath)
          if (stat.isFile() && !stat.isSymbolicLink()) {
            const added = await appendCandidate(candidates, {
              kind: 'agent-session',
              id: makeCandidateId('agent-session', session.id),
              path: messagePath,
              bytes: stat.size,
              updatedAt: session.updatedAt,
              reason: 'archived-expired',
              workspaceSlug: session.workspaceSlug,
              sessionTitle: session.title,
              workspaceName: session.workspaceName,
              sessionId: session.id,
            }, normalized.maxCandidates)
            if (!added) {
              truncated = true
              break
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`读取会话 JSONL 失败 (${session.id}): ${String(error)}`)
        }
      }

      if (session.workspaceSlug && isSafeSessionId(session.id)) {
        const workspacePath = resolve(context.agentWorkspacesDir, session.workspaceSlug, session.id)
        if (isContained(context.agentWorkspacesDir, workspacePath)) {
          try {
            const stat = await fsPromises.lstat(workspacePath)
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
              const bytes = await getRemovableWorkspaceBytes(workspacePath, workspaceSizeCache)
              sizeEstimateIncomplete ||= workspaceSizeCache.get(workspacePath)?.truncated === true
              if (bytes <= 0) continue
              const added = await appendCandidate(candidates, {
                kind: 'workspace-session',
                id: makeCandidateId('workspace-session', `${session.workspaceSlug}:${session.id}`),
                path: workspacePath,
                bytes,
                updatedAt: session.updatedAt,
                reason: 'archived-expired',
                workspaceSlug: session.workspaceSlug,
                sessionTitle: session.title,
                workspaceName: session.workspaceName,
                sessionId: session.id,
              }, normalized.maxCandidates)
              if (!added) {
                truncated = true
                break
              }
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`读取会话工作目录失败 (${session.id}): ${String(error)}`)
          }
        }
      }
    }
  } else {
    // 孤儿模式只扫描 Proma 管理目录，并保留工作区级资料；该模式不会触碰外部项目根。
    try {
      const entries = await fsPromises.readdir(context.agentSessionsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.name.endsWith('.jsonl')) continue
        const id = basename(entry.name, '.jsonl')
        if (sessionsById.has(id) || !isSafeSessionId(id)) continue
        const path = resolve(context.agentSessionsDir, entry.name)
        const stat = await fsPromises.lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > artifactCutoff) continue
        const added = await appendCandidate(candidates, {
          kind: 'agent-session',
          id: makeCandidateId('agent-session', id),
          path,
          bytes: stat.size,
          updatedAt: stat.mtimeMs,
          reason: 'missing-index',
          sessionId: id,
        }, normalized.maxCandidates)
        if (!added) { truncated = true; break }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`扫描孤儿会话 JSONL 失败: ${String(error)}`)
    }
    try {
      const workspaceEntries = await fsPromises.readdir(context.agentWorkspacesDir, { withFileTypes: true })
      const preservedWorkspaceEntries = new Set(['workspace-files', 'skills', 'skills-inactive', '.claude'])
      for (const workspaceEntry of workspaceEntries) {
        if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()) continue
        const workspaceSlug = workspaceEntry.name
        const workspaceRoot = resolve(context.agentWorkspacesDir, workspaceSlug)
        const knownIds = new Set(context.sessions.filter((session) => session.workspaceSlug === workspaceSlug).map((session) => session.id))
        const sessionEntries = await fsPromises.readdir(workspaceRoot, { withFileTypes: true })
        for (const sessionEntry of sessionEntries) {
          if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink() || preservedWorkspaceEntries.has(sessionEntry.name)) continue
          if (knownIds.has(sessionEntry.name) || !isSafeSessionId(sessionEntry.name)) continue
          const path = resolve(workspaceRoot, sessionEntry.name)
          const stat = await fsPromises.lstat(path)
          if (stat.mtimeMs > artifactCutoff) continue
          const bytes = await getRemovableWorkspaceBytes(path, workspaceSizeCache)
          sizeEstimateIncomplete ||= workspaceSizeCache.get(path)?.truncated === true
          if (bytes <= 0) continue
          const added = await appendCandidate(candidates, {
            kind: 'workspace-session',
            id: makeCandidateId('workspace-session', `${workspaceSlug}:${sessionEntry.name}`),
            path,
            bytes,
            updatedAt: stat.mtimeMs,
            reason: 'missing-index',
            workspaceSlug,
            sessionId: sessionEntry.name,
          }, normalized.maxCandidates)
          if (!added) { truncated = true; break }
        }
        if (truncated) break
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`扫描孤儿工作目录失败: ${String(error)}`)
    }
  }

  const protectedPiPaths = new Set<string>()
  for (const session of context.sessions) {
    if (!session.piSessionFile || !isContained(context.piSessionsDir, session.piSessionFile)) continue
    // 归档候选的 artifact 可以在会话成功删除后回收；其它会话的引用始终保护。
    if (!expiringSessionIds.has(session.id)) protectedPiPaths.add(resolve(session.piSessionFile))
  }
  if (!truncated) {
    truncated = await scanPiArtifacts(
      context,
      protectedPiPaths,
      artifactCutoff,
      candidates,
      normalized.maxCandidates,
      errors,
    )
  }

  const reclaimableBytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0)
  return {
    generatedAt: now,
    mode: normalized.mode,
    gracePeriodMs: normalized.gracePeriodMs,
    candidates,
    reclaimableBytes,
    truncated,
    sizeEstimateIncomplete,
    errors,
  }
}

/** 执行预览中的候选，删除前重新验证当前索引与文件身份。 */
export async function executeStorageCleanup(
  preview: StorageCleanupPreview,
  context: StorageCleanupContext,
  candidateIds: readonly string[],
): Promise<StorageCleanupResult> {
  const selectedIds = new Set(candidateIds)
  const candidates = preview.candidates.filter((candidate) => selectedIds.has(candidate.id))
  let freedBytes = 0
  let deletedCount = 0
  let skippedCount = 0
  const errors = [...preview.errors]
  const deletedSessionIds = new Set<string>()
  const currentSessions = () => context.getCurrentSessions()
  const runningIds = () => context.getRunningSessionIds()

  // 先处理 Agent 会话；deleteAgentSession 会同时清理其工作目录，后续重复候选只计 skipped。
  const ordered = [...candidates].sort((a, b) => Number(a.kind !== 'agent-session') - Number(b.kind !== 'agent-session'))
  for (const candidate of ordered) {
    if (candidate.kind === 'agent-session' && candidate.sessionId) {
      const session = currentSessions().find((item) => item.id === candidate.sessionId)
      if (preview.mode === 'archived' && (!session || !session.archived || session.starred || session.pinned || session.updatedAt !== candidate.updatedAt || runningIds().has(candidate.sessionId))) {
        skippedCount += 1
        continue
      }
      if (preview.mode === 'orphaned' && session) {
        skippedCount += 1
        continue
      }
      if (!isContained(context.agentSessionsDir, candidate.path) || !isSafeSessionId(candidate.sessionId)) {
        errors.push(`跳过越界会话候选: ${candidate.path}`)
        skippedCount += 1
        continue
      }
      try {
        const stat = await fsPromises.lstat(candidate.path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.bytes) {
          skippedCount += 1
          continue
        }
        if (preview.mode === 'orphaned') {
          await fsPromises.unlink(candidate.path)
          freedBytes += stat.size
          deletedCount += 1
          continue
        }
        let relatedWorkspaceBytes = 0
        let relatedPiBytes = 0
        if (session?.workspaceSlug) {
          const workspacePath = resolve(context.agentWorkspacesDir, session.workspaceSlug, candidate.sessionId)
          if (isContained(context.agentWorkspacesDir, workspacePath)) {
            try { relatedWorkspaceBytes = await getRemovableWorkspaceBytes(workspacePath) } catch { relatedWorkspaceBytes = 0 }
          }
        }
        if (session?.piSessionFile && isContained(context.piSessionsDir, session.piSessionFile)) {
          const piPath = resolve(session.piSessionFile)
          const sharedByAnotherSession = currentSessions().some((item) => item.id !== session.id && item.piSessionFile && resolve(item.piSessionFile) === piPath)
          if (!sharedByAnotherSession) {
            try {
              const piStat = await fsPromises.lstat(piPath)
              if (piStat.isFile() && !piStat.isSymbolicLink()) relatedPiBytes = piStat.size
            } catch { /* artifact 已不存在时不影响会话删除 */ }
          }
        }
        context.deleteAgentSession(candidate.sessionId)
        freedBytes += candidate.bytes + relatedWorkspaceBytes + relatedPiBytes
        deletedCount += 1
        deletedSessionIds.add(candidate.sessionId)
      } catch (error) {
        errors.push(`删除会话失败 (${candidate.sessionId}): ${String(error)}`)
        skippedCount += 1
      }
      continue
    }

    if (candidate.kind === 'workspace-session' && candidate.sessionId) {
      if (deletedSessionIds.has(candidate.sessionId)) {
        skippedCount += 1
        continue
      }
      if (preview.mode === 'archived') {
        const session = currentSessions().find((item) => item.id === candidate.sessionId)
        const messagePath = resolve(context.agentSessionsDir, `${candidate.sessionId}.jsonl`)
        // JSONL 仍存在时由 deleteAgentSession 统一删除；仅剩工作目录时允许单独回收。
        if (session && (await fsPromises.lstat(messagePath).then(() => true).catch(() => false))) {
          skippedCount += 1
          continue
        }
        if (!session || session.updatedAt !== candidate.updatedAt || !session.archived || session.starred || session.pinned || runningIds().has(candidate.sessionId)) {
          skippedCount += 1
          continue
        }
      }
      if (!candidate.workspaceSlug || !isSafeSessionId(candidate.sessionId)) {
        skippedCount += 1
        continue
      }
      const path = resolve(context.agentWorkspacesDir, candidate.workspaceSlug, candidate.sessionId)
      if (path !== resolve(candidate.path) || !isContained(context.agentWorkspacesDir, path)) {
        errors.push(`跳过越界工作目录候选: ${candidate.path}`)
        skippedCount += 1
        continue
      }
      try {
        const stat = await fsPromises.lstat(path)
        if (!stat.isDirectory() || stat.isSymbolicLink()) { skippedCount += 1; continue }
        const bytes = await removeRemovableWorkspaceContents(path)
        freedBytes += bytes
        deletedCount += 1
      } catch (error) {
        errors.push(`删除工作目录失败 (${path}): ${String(error)}`)
        skippedCount += 1
      }
      continue
    }

    if (candidate.kind === 'pi-artifact') {
      const path = resolve(candidate.path)
      if (!isContained(context.piSessionsDir, path) || !path.endsWith('.jsonl')) {
        errors.push(`跳过越界 Pi artifact: ${candidate.path}`)
        skippedCount += 1
        continue
      }
      const referenced = new Set<string>()
      for (const session of currentSessions()) {
        if (session.piSessionFile && isContained(context.piSessionsDir, session.piSessionFile)) referenced.add(resolve(session.piSessionFile))
      }
      if (referenced.has(path)) {
        skippedCount += 1
        continue
      }
      try {
        const stat = await fsPromises.lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.bytes || stat.mtimeMs !== candidate.updatedAt) {
          skippedCount += 1
          continue
        }
        await fsPromises.unlink(path)
        freedBytes += stat.size
        deletedCount += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') skippedCount += 1
        else {
          errors.push(`删除 Pi artifact 失败 (${path}): ${String(error)}`)
          skippedCount += 1
        }
      }
    }
  }

  return { operationId: preview.operationId, freedBytes, deletedCount, skippedCount, errors }
}
