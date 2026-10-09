import { existsSync, lstatSync, readFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname } from 'node:path'
import type { KnowledgeEntry } from '@proma/shared'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { writeJsonFileAtomic, writeTextFileAtomic } from '../safe-file'
import {
  assertEntryRevisionDirectory,
  assertKnowledgeCacheDirectories,
  assertKnowledgeDirectories,
  ensureKnowledgeCacheDirectories,
  ensureEntryRevisionDirectory,
  getEntryContentPath,
  ensureKnowledgeDirectories,
  getEntryRevisionPath,
  getIndexPath,
  getKnowledgeLockPath,
  getManifestPath,
  validateResolvedProject,
} from './paths'
import { containsKnowledgeSecret } from './sensitive-text'
import type {
  KnowledgeEntryCommit,
  KnowledgeIndexCache,
  KnowledgeManifest,
  KnowledgeTransactionUpdate,
  ProjectKnowledgeServiceDependencies,
  ProjectKnowledgeStore,
  ResolvedKnowledgeProject,
} from './types'

/** 权威 JSON 文件的保守读取上限。 */
const MAX_METADATA_BYTES = 4 * 1024 * 1024
/** 索引正文总预算之外预留 JSON 结构开销。 */
const MAX_INDEX_BYTES = 20 * 1024 * 1024
/** 单条受管正文的保守持久化上限。 */
const MAX_MANAGED_CONTENT_BYTES = 2 * 1024 * 1024
/** 进程内最多保留的项目条目目录缓存数。 */
const MAX_ENTRIES_CACHE_PROJECTS = 32

/** 用于缓存解析结果的文件身份。 */
interface ParsedFileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

/** 已按文件身份缓存的解析结果。 */
interface ParsedFileCache<T> {
  identity: ParsedFileIdentity
  value: T
}

/** 单项目当前条目水位的解析缓存，纯状态 revision 可直接复用。 */
interface ParsedEntriesCache {
  indexRevision: number
  entriesSignature: string
  entries: KnowledgeEntry[]
}

/** 将 stat 缩减为缓存需要的文件身份。 */
function toParsedFileIdentity(stat: Stats): ParsedFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  }
}

/** 判断文件身份是否仍与缓存一致。 */
function sameParsedFileIdentity(left: ParsedFileIdentity, right: ParsedFileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

/** 将缓存正文裁剪到 UTF-8 字符边界。 */
function truncateIndexText(content: string): string {
  /** 完整正文 UTF-8 字节。 */
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length <= 256 * 1024) return content
  for (let length = 256 * 1024; length >= 256 * 1024 - 4; length -= 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    } catch {
      // 回退到完整字符边界。
    }
  }
  return ''
}

/** 判断未知值是否为严格清单。 */
function isKnowledgeManifest(value: unknown): value is KnowledgeManifest {
  if (!value || typeof value !== 'object') return false
  /** 待校验的字段对象。 */
  const candidate = value as Partial<KnowledgeManifest>
  return candidate.schemaVersion === 1
    && typeof candidate.projectId === 'string'
    && Number.isSafeInteger(candidate.revision)
    && Number(candidate.revision) >= 0
    && (candidate.indexRevision === undefined || (
      Number.isSafeInteger(candidate.indexRevision)
      && Number(candidate.indexRevision) >= 0
      && Number(candidate.indexRevision) <= Number(candidate.revision)
    ))
    && typeof candidate.updatedAt === 'number'
    && (candidate.vaultCommitId === undefined || typeof candidate.vaultCommitId === 'string')
    && Boolean(candidate.entries)
    && typeof candidate.entries === 'object'
    && Object.entries(candidate.entries ?? {}).every(([entryId, revision]) => (
      /^[a-f0-9]{32}$/.test(entryId) && typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision)
    ))
    && (candidate.redirects === undefined || (
      typeof candidate.redirects === 'object'
      && Object.entries(candidate.redirects).every(([entryId, targets]) => (
        /^[a-f0-9]{32}$/.test(entryId)
        && Array.isArray(targets)
        && targets.length > 0
        && targets.every((target) => typeof target === 'string' && /^[a-f0-9]{32}$/.test(target))
      ))
    ))
    && (candidate.excludedSources === undefined || (
      Array.isArray(candidate.excludedSources)
      && candidate.excludedSources.every((sourceId) => typeof sourceId === 'string' && sourceId.length <= 1_000)
    ))
}

/** 判断未知值是否为共享合同兼容的条目。 */
function isKnowledgeEntry(value: unknown): value is KnowledgeEntry {
  if (!value || typeof value !== 'object') return false
  /** 待校验的条目对象。 */
  const candidate = value as Partial<KnowledgeEntry>
  return typeof candidate.id === 'string'
    && typeof candidate.revision === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.summary === 'string'
    && typeof candidate.source === 'object'
    && candidate.source !== null
    && typeof candidate.source.id === 'string'
    && typeof candidate.source.revision === 'string'
}

/** 有界读取并解析 JSON。 */
function readBoundedJson(filePath: string, maximumBytes = MAX_METADATA_BYTES): {
  identity: ParsedFileIdentity
  value: unknown
} {
  /** JSON 文件元数据。 */
  const stat = lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximumBytes) {
    throw new Error('知识库元数据过大或类型非法')
  }
  return {
    identity: toParsedFileIdentity(stat),
    value: JSON.parse(readFileSync(filePath, 'utf8')) as unknown,
  }
}

/** 创建可供后续阶段复用的知识版本 Store。 */
export function createProjectKnowledgeStore(
  dependencies: ProjectKnowledgeServiceDependencies,
): ProjectKnowledgeStore {
  /** 当前 Store 使用的时钟。 */
  const now = dependencies.now ?? Date.now
  /** 按 manifest 文件身份缓存的解析结果。 */
  const manifestCache = new Map<string, ParsedFileCache<KnowledgeManifest>>()
  /** 每个项目只保留当前条目水位，避免维护状态 revision 触发全量 entry IO。 */
  const entriesCache = new Map<string, ParsedEntriesCache>()
  /** 按索引文件身份缓存的解析结果。 */
  const indexCache = new Map<string, ParsedFileCache<KnowledgeIndexCache>>()

  /** 读取权威清单，不存在时不创建目录。 */
  function readManifest(project: ResolvedKnowledgeProject): KnowledgeManifest | null {
    validateResolvedProject(project)
    /** 当前项目的清单路径。 */
    const manifestPath = getManifestPath(project)
    if (!existsSync(manifestPath)) return null
    /** 清单完整父链必须保持为实际目录。 */
    assertKnowledgeDirectories(project)
    /** 清单当前文件身份。 */
    const currentIdentity = toParsedFileIdentity(lstatSync(manifestPath))
    /** 文件身份未变化时复用已经校验的清单。 */
    const cached = manifestCache.get(manifestPath)
    if (cached && sameParsedFileIdentity(cached.identity, currentIdentity)) {
      if (cached.value.projectId !== project.projectId) throw new Error('知识库归属冲突')
      return cached.value
    }
    /** 待校验的清单内容与读取身份。 */
    const parsed = readBoundedJson(manifestPath)
    const value = parsed.value
    if (!isKnowledgeManifest(value)) throw new Error('知识库清单损坏')
    if (value.projectId !== project.projectId) throw new Error('知识库归属冲突')
    manifestCache.set(manifestPath, { identity: parsed.identity, value })
    return value
  }

  /** 在跨进程锁内首次建立空清单。 */
  async function initialize(project: ResolvedKnowledgeProject, workspaceId?: string): Promise<KnowledgeManifest> {
    ensureKnowledgeDirectories(project)
    /** 当前项目的短临界区锁释放函数。 */
    const release = acquireMediaFileLock(getKnowledgeLockPath(project))
    try {
      /** 锁内重新读取，防止双项目同时抢占同一根。 */
      const existing = readManifest(project)
      if (existing) return existing
      if (workspaceId && dependencies.assertWritable) await dependencies.assertWritable(workspaceId)
      /** 首次发布的空清单。 */
      const manifest: KnowledgeManifest = {
        schemaVersion: 1,
        projectId: project.projectId,
        revision: 0,
        entries: {},
        updatedAt: now(),
      }
      writeJsonFileAtomic(getManifestPath(project), manifest)
      /** 写后失效，下一次读取按正式文件身份缓存。 */
      manifestCache.delete(getManifestPath(project))
      return manifest
    } finally {
      release()
    }
  }

  /** 读取清单指向的不可变条目。 */
  function readEntries(project: ResolvedKnowledgeProject, manifest: KnowledgeManifest): KnowledgeEntry[] {
    if (manifest.projectId !== project.projectId) throw new Error('知识库归属冲突')
    /** 项目清单路径也是条目缓存的稳定项目身份。 */
    const cacheKey = getManifestPath(project)
    /** 当前条目映射签名，防止外部损坏清单伪造相同水位。 */
    const entriesSignature = JSON.stringify(manifest.entries)
    /** 纯状态 revision 保持不变的条目水位。 */
    const indexRevision = manifest.indexRevision ?? manifest.revision
    /** warm search 跨 manifest 对象复用同一不可变条目集合。 */
    const cached = entriesCache.get(cacheKey)
    if (cached?.indexRevision === indexRevision && cached.entriesSignature === entriesSignature) {
      /** 命中时移到 Map 尾部，维持最近使用顺序。 */
      entriesCache.delete(cacheKey)
      entriesCache.set(cacheKey, cached)
      return [...cached.entries]
    }
    /** 当前清单引用的全部不可变条目。 */
    const entries = Object.entries(manifest.entries).map(([entryId, revision]) => {
      /** 当前清单引用的条目文件。 */
      const entryPath = assertEntryRevisionDirectory(project, entryId, revision)
      /** 待校验的不可变条目。 */
      const value = readBoundedJson(entryPath).value
      if (!isKnowledgeEntry(value) || value.id !== entryId || value.revision !== revision) {
        throw new Error('知识条目版本损坏')
      }
      return value
    })
    entriesCache.set(cacheKey, { indexRevision, entriesSignature, entries })
    if (entriesCache.size > MAX_ENTRIES_CACHE_PROJECTS) {
      /** 淘汰最久未使用的项目条目目录。 */
      const oldestKey = entriesCache.keys().next().value
      if (oldestKey) entriesCache.delete(oldestKey)
    }
    return [...entries]
  }

  /** 按稳定 ID 读取当前条目。 */
  function readEntry(
    project: ResolvedKnowledgeProject,
    manifest: KnowledgeManifest,
    entryId: string,
  ): KnowledgeEntry {
    if (manifest.projectId !== project.projectId) throw new Error('知识库归属冲突')
    /** 当前条目版本。 */
    const revision = manifest.entries[entryId]
    if (!revision) throw new Error('知识条目不存在')
    /** 当前条目版本文件。 */
    const entryPath = assertEntryRevisionDirectory(project, entryId, revision)
    /** 当前项目条目缓存。 */
    const cached = entriesCache.get(getManifestPath(project))
    /** 映射签名和水位均匹配时才复用目标条目。 */
    const cachedEntry = cached?.indexRevision === (manifest.indexRevision ?? manifest.revision)
      && cached.entriesSignature === JSON.stringify(manifest.entries)
      ? cached.entries.find((candidate) => candidate.id === entryId)
      : undefined
    if (cachedEntry) return cachedEntry
    /** 未建立条目缓存时只读取目标不可变版本。 */
    const value = readBoundedJson(entryPath).value
    if (!isKnowledgeEntry(value) || value.id !== entryId || value.revision !== revision) {
      throw new Error('知识条目版本损坏')
    }
    return value
  }

  /** 读取清单固定版本对应的不可变受管正文。 */
  function readContent(
    project: ResolvedKnowledgeProject,
    manifest: KnowledgeManifest,
    entryId: string,
  ): string | null {
    if (manifest.projectId !== project.projectId) throw new Error('知识库归属冲突')
    /** 当前条目 revision。 */
    const revision = manifest.entries[entryId]
    if (!revision) throw new Error('知识条目不存在')
    assertEntryRevisionDirectory(project, entryId, revision)
    /** 当前不可变正文路径。 */
    const contentPath = getEntryContentPath(project, entryId, revision)
    if (!existsSync(contentPath)) return null
    /** 正文文件必须保持为单链接普通文件。 */
    const stat = lstatSync(contentPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_MANAGED_CONTENT_BYTES) {
      throw new Error('受管知识正文损坏或过大')
    }
    return readFileSync(contentPath, 'utf8')
  }

  /** 在持锁状态写入不可变依赖并单次推进 manifest。 */
  function publishLocked(
    project: ResolvedKnowledgeProject,
    current: KnowledgeManifest,
    update: KnowledgeTransactionUpdate,
  ): KnowledgeManifest {
    /** 待发布条目提交。 */
    const commits = update.commits ?? []
    /** 是否包含条目之外的显式状态更新。 */
    const hasStateUpdate = update.workflow !== undefined || update.maintenance !== undefined
      || update.operations !== undefined
      || update.redirects !== undefined
      || update.excludedSources !== undefined
      || update.vaultCommitId !== undefined
    if (commits.length === 0 && !hasStateUpdate) return current
    /** 当前条目水位的可重建索引，用于条目提交时做增量更新。 */
    let currentIndex: KnowledgeIndexCache | null = null
    if (commits.length > 0) {
      try {
        currentIndex = readIndex(project, current.indexRevision ?? current.revision)
      } catch {
        // 缓存损坏不阻止权威事务。
      }
    }
    /** 下一版持久化排除来源。 */
    const excludedSources = update.excludedSources ?? current.excludedSources ?? []
    /** 下一版清单引用映射。 */
    const nextEntries = { ...current.entries }
    for (const commit of commits) {
      /** 即将发布的不可变条目。 */
      const entry = commit.entry
      if (!isKnowledgeEntry(entry) || !/^[a-f0-9]{32}$/.test(entry.id) || !/^[a-f0-9]{64}$/.test(entry.revision)) {
        throw new Error('待提交知识条目非法')
      }
      if (Buffer.byteLength(JSON.stringify(entry, null, 2), 'utf8') > MAX_METADATA_BYTES) {
        throw new Error('知识条目元数据超过大小上限')
      }
      if (excludedSources.includes(entry.source.id) && entry.state !== 'archived') {
        throw new Error('知识来源已被拒绝，不能重新发布')
      }
      if (commit.content !== undefined) {
        if (entry.source.kind !== 'managed' && entry.source.kind !== 'conversation') {
          throw new Error('外部来源不能写入受管正文')
        }
        if (Buffer.byteLength(commit.content, 'utf8') > MAX_MANAGED_CONTENT_BYTES) throw new Error('受管知识正文过大')
        if (containsKnowledgeSecret(commit.content)) throw new Error('受管知识正文含敏感内容')
      }
      nextEntries[entry.id] = entry.revision
    }
    /** 单次原子发布的下一版清单。 */
    const nextManifest: KnowledgeManifest = {
      workflow: update.workflow ?? current.workflow,
      schemaVersion: 1,
      projectId: project.projectId,
      revision: current.revision + 1,
      indexRevision: commits.length > 0
        ? current.revision + 1
        : current.indexRevision ?? current.revision,
      entries: nextEntries,
      updatedAt: now(),
      vaultCommitId: update.vaultCommitId ?? current.vaultCommitId,
      maintenance: update.maintenance ?? current.maintenance,
      operations: update.operations ?? current.operations,
      redirects: update.redirects ?? current.redirects,
      excludedSources,
    }
    if (Buffer.byteLength(JSON.stringify(nextManifest, null, 2), 'utf8') > MAX_METADATA_BYTES) {
      throw new Error('知识库清单超过大小上限')
    }
    for (const commit of commits) {
      /** 当前不可变版本文件。 */
      const entryPath = ensureEntryRevisionDirectory(project, commit.entry.id, commit.entry.revision)
      /** 当前不可变受管正文路径。 */
      const contentPath = getEntryContentPath(project, commit.entry.id, commit.entry.revision)
      if (commit.content !== undefined) {
        if (!existsSync(contentPath)) writeTextFileAtomic(contentPath, commit.content)
        else if (readFileSync(contentPath, 'utf8') !== commit.content) throw new Error('知识正文不可变版本冲突')
      }
      if ((commit.entry.source.kind === 'managed' || commit.entry.source.kind === 'conversation')
        && !existsSync(contentPath)) throw new Error('受管知识条目缺少正文')
      if (!existsSync(entryPath)) writeJsonFileAtomic(entryPath, commit.entry)
      else {
        /** 同 revision 已存在时必须内容完全一致，禁止覆盖不可变版本。 */
        const existing = readBoundedJson(entryPath).value
        if (JSON.stringify(existing) !== JSON.stringify(commit.entry)) throw new Error('知识条目不可变版本冲突')
      }
    }
    writeJsonFileAtomic(getManifestPath(project), nextManifest)
    manifestCache.delete(getManifestPath(project))
    /** manifest 已成为权威版本，锁内清理调用方的短事务资源。 */
    try { update.onCommitted?.() } catch {
      // manifest 已提交，收尾失败留给下次锁内恢复，不能回滚已发布状态。
    }
    if (currentIndex) {
      /** 复制旧记录并按本事务受管正文增量更新。 */
      const records = { ...currentIndex.records }
      for (const commit of commits) {
        if (commit.content === undefined) {
          if (records[commit.entry.id]?.entryRevision !== commit.entry.revision) delete records[commit.entry.id]
          continue
        }
        records[commit.entry.id] = {
          entryId: commit.entry.id,
          entryRevision: commit.entry.revision,
          text: truncateIndexText(commit.content),
        }
      }
      try {
        writeIndex(project, {
          schemaVersion: 1,
          projectId: project.projectId,
          manifestRevision: nextManifest.indexRevision ?? nextManifest.revision,
          records,
        })
      } catch {
        // manifest 已正式发布；缓存失败由搜索回退与后续扫描恢复。
      }
    }
    return nextManifest
  }

  /** 先写不可变条目版本，再原子推进 manifest。 */
  async function commitEntries(
    project: ResolvedKnowledgeProject,
    expectedRevision: number,
    commits: KnowledgeEntryCommit[],
    workspaceId?: string,
  ): Promise<KnowledgeManifest> {
    ensureKnowledgeDirectories(project)
    /** 当前提交持有的跨进程锁释放函数。 */
    const release = acquireMediaFileLock(getKnowledgeLockPath(project))
    try {
      /** 锁内再次解析宿主写门禁。 */
      if (workspaceId && dependencies.assertWritable) await dependencies.assertWritable(workspaceId)
      /** 锁内权威基线。 */
      const current = readManifest(project)
      if (!current) throw new Error('知识库尚未初始化')
      if (current.revision !== expectedRevision) throw new Error('知识库版本冲突')
      return publishLocked(project, current, { commits })
    } finally {
      release()
    }
  }

  /** 在同一知识锁内读取权威状态、执行同步决策并发布。 */
  async function transact(
    project: ResolvedKnowledgeProject,
    workspaceId: string,
    update: Parameters<ProjectKnowledgeStore['transact']>[2],
  ): Promise<KnowledgeManifest> {
    ensureKnowledgeDirectories(project)
    /** 当前事务持有的跨进程锁释放函数。 */
    const release = acquireMediaFileLock(getKnowledgeLockPath(project))
    try {
      if (dependencies.assertWritable) await dependencies.assertWritable(workspaceId)
      /** 锁内最新权威清单。 */
      const current = readManifest(project)
      if (!current) throw new Error('知识库尚未初始化')
      /** 同步 callback 看到的条目集合。 */
      const transactionCurrent = { manifest: current, entries: readEntries(project, current) }
      /** callback 返回的同步更新。 */
      const transactionUpdate = update(transactionCurrent)
      if (transactionUpdate && typeof transactionUpdate === 'object' && 'then' in transactionUpdate) {
        throw new Error('知识事务 callback 必须同步完成')
      }
      try {
        return publishLocked(project, current, transactionUpdate)
      } catch (error) {
        /** 可见文件等事务外资源必须在知识锁释放前恢复。 */
        transactionUpdate.onAborted?.()
        throw error
      }
    } finally {
      release()
    }
  }

  /** 读取与当前 manifest 精确匹配的可重建索引。 */
  function readIndexUnchecked(project: ResolvedKnowledgeProject, manifestRevision: number): KnowledgeIndexCache | null {
    validateResolvedProject(project)
    /** 当前项目的索引路径。 */
    const indexPath = getIndexPath(project)
    if (!existsSync(indexPath)) return null
    assertKnowledgeCacheDirectories(project)
    /** 当前索引文件身份。 */
    const currentIdentity = toParsedFileIdentity(lstatSync(indexPath))
    /** 文件身份未变化时复用已经校验的索引。 */
    const cached = indexCache.get(indexPath)
    if (cached && sameParsedFileIdentity(cached.identity, currentIdentity)) {
      return cached.value.manifestRevision === manifestRevision ? cached.value : null
    }
    /** 待校验的索引对象。 */
    const parsed = readBoundedJson(indexPath, MAX_INDEX_BYTES)
    const value = parsed.value
    if (!value || typeof value !== 'object') return null
    /** 缓存字段对象。 */
    const cache = value as Partial<KnowledgeIndexCache>
    if (cache.schemaVersion !== 1
      || cache.projectId !== project.projectId
      || cache.manifestRevision !== manifestRevision
      || !cache.records
      || typeof cache.records !== 'object') return null
    /** 每条索引记录必须与映射键和值类型一致。 */
    const recordsAreValid = Object.entries(cache.records).every(([entryId, record]) => (
      /^[a-f0-9]{32}$/.test(entryId)
      && Boolean(record)
      && typeof record === 'object'
      && (record as Partial<KnowledgeIndexCache['records'][string]>).entryId === entryId
      && typeof (record as Partial<KnowledgeIndexCache['records'][string]>).entryRevision === 'string'
      && typeof (record as Partial<KnowledgeIndexCache['records'][string]>).text === 'string'
    ))
    if (!recordsAreValid) return null
    /** 已完整校验的索引缓存。 */
    const validated = cache as KnowledgeIndexCache
    indexCache.set(indexPath, { identity: parsed.identity, value: validated })
    return validated
  }

  /** 损坏或被置换的缓存按缺失处理，不阻塞权威知识读取。 */
  function readIndex(project: ResolvedKnowledgeProject, manifestRevision: number): KnowledgeIndexCache | null {
    try { return readIndexUnchecked(project, manifestRevision) } catch { return null }
  }

  /** 原子写入可丢失索引缓存。 */
  function writeIndex(project: ResolvedKnowledgeProject, cache: KnowledgeIndexCache): void {
    ensureKnowledgeCacheDirectories(project)
    writeJsonFileAtomic(getIndexPath(project), cache)
    indexCache.delete(getIndexPath(project))
  }

  return {
    readManifest,
    initialize,
    readEntries,
    readEntry,
    readContent,
    commitEntries,
    transact,
    readIndex,
    writeIndex,
  }
}
