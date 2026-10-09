import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import type { KnowledgeCategory, KnowledgeEntry, KnowledgeSource } from '@proma/shared'
import type {
  ProjectKnowledgeControlledSource,
  ProjectKnowledgeControlledSourceList,
  ProjectKnowledgeSources,
} from '../project-knowledge-sources'
import { normalizeSourceRelativePath, titleFromRelativePath } from './paths'
import { containsKnowledgeSecret } from './sensitive-text'
import {
  MAX_INDEXED_FILE_BYTES,
  readSafeMetadataRevision,
  readSafeTextSnapshot,
} from './source-reader'
import type {
  KnowledgeIndexCache,
  KnowledgeIndexRecord,
  KnowledgeManifest,
  ProjectKnowledgeStore,
  ResolvedKnowledgeProject,
} from './types'

/** 单轮最多登记的来源数，避免异常目录拖住主进程。 */
const MAX_SOURCE_COUNT = 5_000
/** 单轮正文缓存总预算。 */
const MAX_TOTAL_INDEX_BYTES = 16 * 1024 * 1024
/** 同时打开的来源文件上限。 */
const MAX_READ_CONCURRENCY = 8
/** 每批目录项之后让出事件循环。 */
const DISCOVERY_YIELD_INTERVAL = 100

/** 永不递归进入的依赖、产物与内部目录。 */
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.proma', '.obsidian', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage', 'target', 'release',
  '.cache', '.turbo', '.vite', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker',
])
/** 首版可安全作为 UTF-8 文本提取的扩展名。 */
const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.html', '.xml', '.sql',
  '.sh', '.bash', '.zsh', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp',
  '.csv', '.graphql', '.gql', '.vue', '.svelte',
])
/** 首版只登记元数据、不读取正文的资产扩展名。 */
const METADATA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.ppt', '.pptx', '.key', '.pages', '.numbers',
])
/** 明确按名称或扩展名排除的凭据文件。 */
const CREDENTIAL_FILE_PATTERN = /(^|\/)(\.env($|\.)|\.npmrc$|\.yarnrc$|\.pypirc$|\.netrc$|\.git-credentials$|id_(rsa|dsa|ecdsa|ed25519)$|.*(?:secret|credential|credentials|private[-_.]?key).*)(\/|$)|\.(pem|p12|pfx|keystore|jks)$/i

/** 扫描器登记的安全来源候选。 */
interface SourceCandidate {
  sourceKind: 'project-file' | 'memory-file'
  rootPath: string
  absolutePath: string
  relativePath: string
  metadataOnly: boolean
}

/** 单个来源的安全提取结果。 */
type SourceExtractionResult =
  | { status: 'metadata'; candidate: SourceCandidate; revision: string; byteSize: number; text: '' }
  | {
    status: 'text'
    candidate: SourceCandidate
    revision: string
    byteSize: number
    text: string
    sourceTruncated: boolean
  }
  | { status: 'budget-skipped'; candidate: SourceCandidate }
  | { status: 'excluded'; candidate: SourceCandidate }
  | { status: 'sensitive'; candidate: SourceCandidate; revision: string; byteSize: number }
  | { status: 'failed'; candidate: SourceCandidate }

/** 一轮扫描返回的发布结果。 */
export interface KnowledgeScanResult {
  manifest: KnowledgeManifest
  discovered: number
  indexed: number
  skipped: number
  changed: number
  cancelled: boolean
  complete: boolean
  message?: string
}

/** 扫描期间可取消并接收进度更新的依赖。 */
export interface KnowledgeScannerDependencies {
  project: ResolvedKnowledgeProject
  workspaceId: string
  store: ProjectKnowledgeStore
  manifest: KnowledgeManifest
  now: () => number
  isCancelled: () => boolean
  onProgress: (progress: { discovered?: number; indexed?: number; skipped?: number; changed?: number }) => void
  /** 受控业务来源只通过宿主服务纯读接口进入扫描。 */
  controlledSources?: ProjectKnowledgeSources
}

/** 在测试和大量目录中显式让出事件循环。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise))
}

/** 按 UTF-8 字符边界应用总缓存预算。 */
function truncateUtf8ByBytes(text: string, maximumBytes: number): string {
  /** 正文完整 UTF-8 字节。 */
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maximumBytes) return text
  /** 最多回退一个 UTF-8 字符的候选长度。 */
  for (let length = maximumBytes; length >= Math.max(0, maximumBytes - 4); length -= 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    } catch {
      // 继续回退到完整字符边界。
    }
  }
  return ''
}

/** 根据相对路径判断是否属于凭据。 */
function isCredentialPath(relativePath: string): boolean {
  return CREDENTIAL_FILE_PATTERN.test(relativePath)
}

/** 解析首版支持的来源类型。 */
function resolveSourceMode(relativePath: string): 'text' | 'metadata' | null {
  /** 文件的小写扩展名。 */
  const extension = extname(relativePath).toLowerCase()
  /** 常见无扩展名工程入口仍按文本读取。 */
  const baseName = relativePath.split('/').at(-1)?.toLowerCase() ?? ''
  if (TEXT_EXTENSIONS.has(extension) || ['readme', 'license', 'makefile', 'dockerfile', 'agents.md'].includes(baseName)) {
    return 'text'
  }
  if (METADATA_EXTENSIONS.has(extension)) return 'metadata'
  return null
}

/** 分批枚举一个可信根，遇到读取错误时标记不完整。 */
async function discoverRoot(
  rootPath: string,
  sourceKind: SourceCandidate['sourceKind'],
  dependencies: KnowledgeScannerDependencies,
  candidates: SourceCandidate[],
): Promise<{ skipped: number; complete: boolean }> {
  /** 待遍历的实际目录栈。 */
  const pendingDirectories = [rootPath]
  /** 因排除、预算或错误跳过的数量。 */
  let skipped = 0
  /** 是否完整枚举了本次授权范围。 */
  let complete = true
  /** 自上次 yield 后处理的目录项数量。 */
  let processedSinceYield = 0
  /** 知识正文和附件不能再次被当作原始来源循环提炼。 */
  const vaultRoots = sourceKind === 'project-file'
    ? [dependencies.manifest.workflow?.approved?.rootRelativePath,
      dependencies.manifest.workflow?.proposal?.rootRelativePath].filter((path): path is string => Boolean(path))
    : []

  while (pendingDirectories.length > 0 && !dependencies.isCancelled()) {
    /** 当前实际目录。 */
    const directoryPath = pendingDirectories.pop()
    if (!directoryPath) break
    try {
      /** 使用异步目录迭代避免一次载入超大目录。 */
      const directory = await opendir(directoryPath)
      for await (const directoryEntry of directory) {
        if (dependencies.isCancelled()) break
        processedSinceYield += 1
        if (processedSinceYield >= DISCOVERY_YIELD_INTERVAL) {
          processedSinceYield = 0
          await yieldToEventLoop()
        }
        /** 当前候选的绝对路径。 */
        const absolutePath = join(directoryPath, directoryEntry.name)
        /** 当前候选相对来源根的稳定路径。 */
        const relativePath = normalizeSourceRelativePath(relative(rootPath, absolutePath))
        if (vaultRoots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`))) {
          skipped += 1
          continue
        }
        if (directoryEntry.isSymbolicLink()) {
          skipped += 1
          continue
        }
        if (directoryEntry.isDirectory()) {
          if (EXCLUDED_DIRECTORIES.has(directoryEntry.name.toLowerCase())) skipped += 1
          else pendingDirectories.push(absolutePath)
          continue
        }
        if (!directoryEntry.isFile()) {
          skipped += 1
          continue
        }
        if (isCredentialPath(relativePath)) {
          skipped += 1
          continue
        }
        /** 当前来源的提取模式。 */
        const sourceMode = resolveSourceMode(relativePath)
        if (!sourceMode) {
          skipped += 1
          continue
        }
        if (candidates.length >= MAX_SOURCE_COUNT) {
          skipped += 1
          complete = false
          continue
        }
        candidates.push({
          sourceKind,
          rootPath,
          absolutePath,
          relativePath,
          metadataOnly: sourceMode === 'metadata',
        })
        dependencies.onProgress({ discovered: candidates.length })
      }
    } catch {
      skipped += 1
      complete = false
    }
  }
  return { skipped, complete }
}

/** 从标题、路径和正文推断初始业务分类。 */
function classifyEntry(relativePath: string, sourceKind: SourceCandidate['sourceKind']): KnowledgeCategory {
  /** 用于轻量分类的小写路径。 */
  const path = relativePath.toLowerCase()
  if (sourceKind === 'memory-file' || /decision|决策/.test(path)) return 'decisions'
  if (/readme|overview|介绍|总览/.test(path)) return 'overview'
  if (/plan|roadmap|需求|规划/.test(path)) return 'planning'
  if (/design|ux|ui|视觉|交互/.test(path)) return 'design'
  if (/guide|manual|tutorial|使用|指南/.test(path)) return 'guides'
  if (/api|src|test|架构|技术|接口/.test(path)) return 'engineering'
  return 'business'
}

/** 提取 Markdown 首个标题，否则使用文件名。 */
function resolveTitle(relativePath: string, text: string): string {
  /** 首个 Markdown 标题匹配。 */
  const heading = text.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim()
  return heading || titleFromRelativePath(relativePath)
}

/** 由来源根类型与路径派生稳定条目 ID。 */
function createEntryId(candidate: SourceCandidate): string {
  return createHash('sha256')
    .update(candidate.sourceKind)
    .update('\0')
    .update(candidate.relativePath)
    .digest('hex')
    .slice(0, 32)
}

/** 由受控服务类型与稳定来源身份派生条目 ID。 */
function createControlledEntryId(source: ProjectKnowledgeControlledSource): string {
  return createHash('sha256')
    .update(source.kind)
    .update('\0')
    .update(source.sourceId)
    .digest('hex')
    .slice(0, 32)
}

/** 对不含 revision 的条目字段生成不可变版本。 */
function createEntryRevision(entry: Omit<KnowledgeEntry, 'revision'>): string {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex')
}

/** 构造外部来源条目，不复制来源正文。 */
function createEntry(
  candidate: SourceCandidate,
  sourceRevision: string,
  byteSize: number,
  indexedBytes: number,
  truncated: boolean,
  title: string,
  now: number,
  freshness: KnowledgeEntry['freshness'] = 'current',
): KnowledgeEntry {
  /** 稳定来源描述。 */
  const source: KnowledgeSource = {
    kind: candidate.sourceKind,
    id: `${candidate.sourceKind}:${candidate.relativePath}`,
    relativePath: candidate.relativePath,
    revision: sourceRevision,
  }
  /** 不含自身 revision 的条目内容。 */
  const base: Omit<KnowledgeEntry, 'revision'> = {
    id: createEntryId(candidate),
    title,
    category: classifyEntry(candidate.relativePath, candidate.sourceKind),
    kind: candidate.metadataOnly ? 'asset' : 'document',
    state: 'indexed',
    freshness,
    summary: `${candidate.sourceKind === 'memory-file' ? '项目记忆' : '项目文件'}：${candidate.relativePath}`,
    source,
    byteSize,
    indexedBytes,
    truncated,
    metadataOnly: candidate.metadataOnly,
    updatedAt: now,
  }
  return { ...base, revision: createEntryRevision(base) }
}

/** 构造 Canvas/API 受控来源条目，不保存绝对路径或原服务私有数据。 */
function createControlledEntry(
  sourceSnapshot: ProjectKnowledgeControlledSource,
  indexedBytes: number,
): KnowledgeEntry {
  /** 受控来源的稳定定位与当前版本。 */
  const source: KnowledgeSource = {
    kind: sourceSnapshot.kind,
    id: sourceSnapshot.sourceId,
    revision: sourceSnapshot.revision,
  }
  /** 不含自身 revision 的受控条目。 */
  const base: Omit<KnowledgeEntry, 'revision'> = {
    id: createControlledEntryId(sourceSnapshot),
    title: sourceSnapshot.title,
    category: sourceSnapshot.kind === 'api' ? 'engineering' : 'design',
    kind: sourceSnapshot.metadataOnly ? 'asset' : 'document',
    state: 'indexed',
    freshness: 'current',
    summary: sourceSnapshot.summary,
    source,
    byteSize: sourceSnapshot.byteSize,
    indexedBytes,
    truncated: sourceSnapshot.truncated || indexedBytes < Buffer.byteLength(sourceSnapshot.content, 'utf8'),
    metadataOnly: sourceSnapshot.metadataOnly,
    updatedAt: sourceSnapshot.updatedAt,
  }
  return { ...base, revision: createEntryRevision(base) }
}

/** 为已删除来源创建新条目版本并保留引用。 */
function createUnavailableEntry(entry: KnowledgeEntry, now: number): KnowledgeEntry {
  /** 不含自身 revision 的失效条目。 */
  const base: Omit<KnowledgeEntry, 'revision'> = {
    ...entry,
    freshness: 'unavailable',
    indexedBytes: 0,
    truncated: false,
    updatedAt: now,
  }
  return { ...base, revision: createEntryRevision(base) }
}

/** 执行一轮有界、可取消的项目与 memory 扫描。 */
export async function scanProjectKnowledge(
  dependencies: KnowledgeScannerDependencies,
): Promise<KnowledgeScanResult> {
  /** 本轮所有安全来源候选。 */
  const candidates: SourceCandidate[] = []
  /** 项目根发现结果。 */
  const projectDiscovery = await discoverRoot(
    dependencies.project.projectRoot,
    'project-file',
    dependencies,
    candidates,
  )
  /** memory 根发现结果。 */
  const memoryDiscovery = dependencies.isCancelled()
    ? { skipped: 0, complete: false }
    : existsSync(dependencies.project.memoryRoot)
      ? await discoverRoot(dependencies.project.memoryRoot, 'memory-file', dependencies, candidates)
      : { skipped: 0, complete: true }
  /** 本轮受控业务来源目录；未注入适配器时不改变既有文件扫描语义。 */
  let controlledList: ProjectKnowledgeControlledSourceList = {
    sources: [],
    total: 0,
    truncated: false,
    skipped: 0,
  }
  /** 受控来源目录是否完整，决定能否推断旧来源已删除。 */
  let controlledDiscoveryComplete = false
  if (!dependencies.isCancelled() && dependencies.controlledSources) {
    try {
      controlledList = await dependencies.controlledSources.list(dependencies.project.projectId)
      controlledDiscoveryComplete = !controlledList.truncated && controlledList.skipped === 0
    } catch {
      controlledList.skipped = 1
    }
  }
  /** 因受控目录上限未返回的来源数量。 */
  const omittedControlledSources = Math.max(0, controlledList.total - controlledList.sources.length)
  /** 本轮因排除、错误或预算跳过数量。 */
  let skipped = projectDiscovery.skipped + memoryDiscovery.skipped
    + controlledList.skipped + omittedControlledSources
  /** 本轮实际枚举到的文件与受控来源数量。 */
  const discovered = candidates.length + controlledList.sources.length
  dependencies.onProgress({ discovered, skipped })
  if (dependencies.isCancelled()) {
    return {
      manifest: dependencies.manifest,
      discovered,
      indexed: 0,
      skipped,
      changed: 0,
      cancelled: true,
      complete: false,
    }
  }

  /** 上一版全部条目。 */
  const previousEntries = dependencies.store.readEntries(dependencies.project, dependencies.manifest)
  /** 按来源稳定身份查询旧条目。 */
  const previousBySource = new Map(previousEntries.map((entry) => [entry.source.id, entry]))
  /** 上一版可复用索引。 */
  const previousIndex = dependencies.store.readIndex(
    dependencies.project,
    dependencies.manifest.indexRevision ?? dependencies.manifest.revision,
  )
  /** 本轮待发布条目。 */
  const nextEntries = new Map(previousEntries.map((entry) => [entry.id, entry]))
  /** 本轮可重建正文索引。 */
  const nextRecords: Record<string, KnowledgeIndexRecord> = {}
  /** 本轮成功观察到的来源身份。 */
  const observedSourceIds = new Set<string>()
  /** 当前正文缓存预算用量。 */
  let indexedBudget = 0
  /** 受控来源目录已完成安全投影读取，先预占其真实正文字节。 */
  let readBudget = controlledList.sources.reduce((total, source) => total + source.indexedBytes, 0)
  /** 成功提取正文的来源数。 */
  let indexed = 0
  /** 实际发生变化的条目数。 */
  let changed = 0
  /** 来源读取是否全部完成；失败时禁止推断未观察来源已删除。 */
  let extractionComplete = true

  /** 扫描不得丢弃持续维护正文；受控目录不完整时暂存旧缓存等待 fresh-read 复核。 */
  for (const previous of previousEntries) {
    if ((dependencies.manifest.excludedSources ?? []).includes(previous.source.id)) continue
    /** 上一版非文件条目的已发布缓存。 */
    const cached = previousIndex?.records[previous.id]
    /** 受管正文可从不可变版本恢复；Canvas/API 只复用精确版本的可丢失缓存。 */
    const sourceText = previous.source.kind === 'conversation' || previous.source.kind === 'managed'
      ? cached?.entryRevision === previous.revision
        ? cached.text
        : dependencies.store.readContent(dependencies.project, dependencies.manifest, previous.id) ?? ''
      : previous.source.kind === 'canvas' || previous.source.kind === 'api'
        ? cached?.entryRevision === previous.revision ? cached.text : ''
        : ''
    if (!sourceText) continue
    /** 在同一总预算内保留受管正文索引。 */
    const remainingBudget = Math.max(0, MAX_TOTAL_INDEX_BYTES - indexedBudget)
    /** 预算内的受管索引正文。 */
    const indexedText = truncateUtf8ByBytes(sourceText, remainingBudget)
    if (!indexedText) continue
    nextRecords[previous.id] = {
      entryId: previous.id,
      entryRevision: previous.revision,
      text: indexedText,
    }
    indexedBudget += Buffer.byteLength(indexedText, 'utf8')
  }

  for (let batchStart = 0; batchStart < candidates.length; batchStart += MAX_READ_CONCURRENCY) {
    if (dependencies.isCancelled()) break
    /** 当前最多八项的读取批次。 */
    const batch = candidates.slice(batchStart, batchStart + MAX_READ_CONCURRENCY)
    /** 当前批次各来源的安全读取结果。 */
    const results: SourceExtractionResult[] = await Promise.all(batch.map((candidate): Promise<SourceExtractionResult> => {
      try {
        /** 持久化排除来源不再读取或索引。 */
        const sourceId = `${candidate.sourceKind}:${candidate.relativePath}`
        if ((dependencies.manifest.excludedSources ?? []).includes(sourceId)) {
          return Promise.resolve({ status: 'excluded', candidate })
        }
        /** no-follow 元数据预检同时给读取预算提供可信文件大小。 */
        const metadata = readSafeMetadataRevision(candidate.absolutePath)
        if (candidate.metadataOnly) {
          return Promise.resolve({
            status: 'metadata',
            candidate,
            revision: metadata.revision,
            byteSize: metadata.byteSize,
            text: '',
          })
        }
        /** 在启动并发读取前预留完整单文件提取预算，避免同批超额读取。 */
        const requiredBytes = Math.min(metadata.byteSize, MAX_INDEXED_FILE_BYTES)
        if (readBudget + requiredBytes > MAX_TOTAL_INDEX_BYTES) {
          return Promise.resolve({ status: 'budget-skipped', candidate })
        }
        readBudget += requiredBytes
        return readSafeTextSnapshot(candidate.absolutePath).then((snapshot): SourceExtractionResult => (
          containsKnowledgeSecret(snapshot.text)
            ? { status: 'sensitive', candidate, revision: snapshot.revision, byteSize: snapshot.byteSize }
            : {
              status: 'text',
              candidate,
              revision: snapshot.revision,
              byteSize: snapshot.byteSize,
              text: snapshot.text,
              sourceTruncated: snapshot.truncated,
            }
        )).catch(() => ({ status: 'failed' as const, candidate }))
      } catch {
        return Promise.resolve({ status: 'failed', candidate })
      }
    }))

    for (const result of results) {
      /** 当前来源的稳定身份。 */
      const sourceId = `${result.candidate.sourceKind}:${result.candidate.relativePath}`
      /** 已发现来源即使提取失败，也不能被误判为删除。 */
      observedSourceIds.add(sourceId)
      /** 旧版同一来源条目。 */
      const previous = previousBySource.get(sourceId)
      if (result.status === 'failed' || result.status === 'budget-skipped' || result.status === 'excluded') {
        skipped += 1
        if (result.status === 'failed') extractionComplete = false
        continue
      }
      if (result.status === 'sensitive') {
        skipped += 1
        if (previous) {
          /** 敏感内容只发布失效元数据，绝不保存正文或摘要。 */
          const sensitiveBase: Omit<KnowledgeEntry, 'revision'> = {
            ...previous,
            freshness: 'changed',
            source: { ...previous.source, revision: result.revision },
            byteSize: result.byteSize,
            indexedBytes: 0,
            truncated: true,
            updatedAt: dependencies.now(),
          }
          /** 敏感来源的新失效版本。 */
          const sensitiveEntry = { ...sensitiveBase, revision: createEntryRevision(sensitiveBase) }
          nextEntries.set(sensitiveEntry.id, sensitiveEntry)
          delete nextRecords[sensitiveEntry.id]
          changed += 1
        }
        continue
      }
      /** 当前来源版本。 */
      const sourceRevision = result.revision
      /** 当前来源字节数。 */
      const byteSize = result.byteSize
      if (previous?.source.revision === sourceRevision && previous.freshness === 'current') {
        nextEntries.set(previous.id, previous)
        /** 只有精确条目版本匹配时才复用旧缓存。 */
        const cached = previousIndex?.records[previous.id]
        /** 缓存丢失或预算变化时使用本轮已安全读取的正文重建。 */
        const sourceText = cached?.entryRevision === previous.revision ? cached.text : result.text
        /** 当前缓存剩余预算。 */
        const remainingBudget = Math.max(0, MAX_TOTAL_INDEX_BYTES - indexedBudget)
        /** 按总预算裁剪的可复用正文。 */
        const indexedText = sourceText ? truncateUtf8ByBytes(sourceText, remainingBudget) : ''
        if (indexedText) {
          nextRecords[previous.id] = {
            entryId: previous.id,
            entryRevision: previous.revision,
            text: indexedText,
          }
          indexedBudget += Buffer.byteLength(indexedText, 'utf8')
          indexed += 1
        }
        continue
      }
      /** 当前文本在总缓存预算内的可用字节。 */
      const remainingBudget = Math.max(0, MAX_TOTAL_INDEX_BYTES - indexedBudget)
      /** 按总预算进一步裁剪的正文。 */
      const indexedText = result.text ? truncateUtf8ByBytes(result.text, remainingBudget) : ''
      /** 当前来源实际进入缓存的字节数。 */
      const indexedBytes = Buffer.byteLength(indexedText, 'utf8')
      indexedBudget += indexedBytes
      if (indexedBytes > 0) indexed += 1
      /** 新条目的标题。 */
      const title = resolveTitle(result.candidate.relativePath, indexedText)
      /** 当前来源的新不可变条目。 */
      const entry = createEntry(
        result.candidate,
        sourceRevision,
        byteSize,
        indexedBytes,
        (result.status === 'text' && result.sourceTruncated) || indexedBytes < Buffer.byteLength(result.text, 'utf8'),
        title,
        dependencies.now(),
      )
      nextEntries.set(entry.id, entry)
      if (indexedText) nextRecords[entry.id] = { entryId: entry.id, entryRevision: entry.revision, text: indexedText }
      changed += 1
    }
    dependencies.onProgress({ indexed, skipped, changed })
    await yieldToEventLoop()
  }

  for (const sourceSnapshot of controlledList.sources) {
    if (dependencies.isCancelled()) break
    /** 受控来源即使被排除，也已被本轮目录实际观察到。 */
    observedSourceIds.add(sourceSnapshot.sourceId)
    /** 同一受控来源上一版条目。 */
    const previous = previousBySource.get(sourceSnapshot.sourceId)
    if ((dependencies.manifest.excludedSources ?? []).includes(sourceSnapshot.sourceId)) {
      skipped += 1
      continue
    }
    if (containsKnowledgeSecret(`${sourceSnapshot.title}\n${sourceSnapshot.summary}\n${sourceSnapshot.content}`)) {
      skipped += 1
      if (previous) {
        /** 来源变敏感后只发布变化状态，删除旧索引正文。 */
        const sensitiveBase: Omit<KnowledgeEntry, 'revision'> = {
          ...previous,
          freshness: 'changed',
          source: { ...previous.source, revision: sourceSnapshot.revision },
          indexedBytes: 0,
          truncated: true,
          updatedAt: dependencies.now(),
        }
        const sensitiveEntry = { ...sensitiveBase, revision: createEntryRevision(sensitiveBase) }
        nextEntries.set(sensitiveEntry.id, sensitiveEntry)
        delete nextRecords[sensitiveEntry.id]
        changed += 1
      }
      continue
    }
    /** 受控安全投影进入同一索引总预算，不能挤占到负数。 */
    const remainingBudget = Math.max(0, MAX_TOTAL_INDEX_BYTES - indexedBudget)
    /** 当前安全投影在全局预算内的正文。 */
    const indexedText = sourceSnapshot.metadataOnly
      ? ''
      : truncateUtf8ByBytes(sourceSnapshot.content, remainingBudget)
    /** 实际进入缓存的受控正文字节。 */
    const indexedBytes = Buffer.byteLength(indexedText, 'utf8')
    indexedBudget += indexedBytes
    if (indexedBytes > 0) indexed += 1

    if (previous?.source.revision === sourceSnapshot.revision && previous.freshness === 'current') {
      nextEntries.set(previous.id, previous)
      if (indexedText) {
        nextRecords[previous.id] = {
          entryId: previous.id,
          entryRevision: previous.revision,
          text: indexedText,
        }
      }
      continue
    }

    /** 新增或变化后的受控来源条目。 */
    const entry = createControlledEntry(sourceSnapshot, indexedBytes)
    nextEntries.set(entry.id, entry)
    if (indexedText) nextRecords[entry.id] = { entryId: entry.id, entryRevision: entry.revision, text: indexedText }
    changed += 1
    dependencies.onProgress({ indexed, skipped, changed })
    await yieldToEventLoop()
  }

  if (dependencies.isCancelled()) {
    return {
      manifest: dependencies.manifest,
      discovered,
      indexed,
      skipped,
      changed: 0,
      cancelled: true,
      complete: false,
    }
  }

  /** 文件范围只有完整枚举和提取后，才能推断未观察来源已删除。 */
  const fileDiscoveryComplete = projectDiscovery.complete && memoryDiscovery.complete && extractionComplete
  if (fileDiscoveryComplete) {
    for (const previous of previousEntries) {
      if (previous.source.kind !== 'project-file' && previous.source.kind !== 'memory-file') continue
      if (observedSourceIds.has(previous.source.id) || previous.freshness === 'unavailable') continue
      /** 来源删除后的不可变版本。 */
      const unavailable = createUnavailableEntry(previous, dependencies.now())
      nextEntries.set(unavailable.id, unavailable)
      delete nextRecords[unavailable.id]
      changed += 1
    }
  }
  if (dependencies.controlledSources && controlledDiscoveryComplete) {
    for (const previous of previousEntries) {
      if (previous.source.kind !== 'canvas' && previous.source.kind !== 'api') continue
      if (observedSourceIds.has(previous.source.id) || previous.freshness === 'unavailable') continue
      /** 受控服务完整目录中消失的来源发布为不可用。 */
      const unavailable = createUnavailableEntry(previous, dependencies.now())
      nextEntries.set(unavailable.id, unavailable)
      delete nextRecords[unavailable.id]
      changed += 1
    }
  }

  /** 只提交相对当前 manifest 发生变化的条目版本。 */
  const commits = [...nextEntries.values()]
    .filter((entry) => dependencies.manifest.entries[entry.id] !== entry.revision)
    .map((entry) => ({ entry }))
  /** 无变化时保持 manifest revision。 */
  const manifest = commits.length > 0
    ? await dependencies.store.commitEntries(
      dependencies.project,
      dependencies.manifest.revision,
      commits,
      dependencies.workspaceId,
    )
    : dependencies.manifest
  /** 与发布清单精确绑定的可重建缓存。 */
  const cache: KnowledgeIndexCache = {
    schemaVersion: 1,
    projectId: dependencies.project.projectId,
    manifestRevision: manifest.indexRevision ?? manifest.revision,
    records: nextRecords,
  }
  /** 缓存写失败不回滚已发布权威清单。 */
  let message: string | undefined
  try {
    dependencies.store.writeIndex(dependencies.project, cache)
  } catch {
    message = '知识目录已更新，但本地检索缓存写入失败，可重新扫描恢复'
  }
  return {
    manifest,
    discovered,
    indexed,
    skipped,
    changed,
    cancelled: false,
    complete: fileDiscoveryComplete && (!dependencies.controlledSources || controlledDiscoveryComplete),
    message,
  }
}
