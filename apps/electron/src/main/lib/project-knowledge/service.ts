import type {
  KnowledgeEntry,
  KnowledgeReadInput,
  KnowledgeReadResult,
  KnowledgeReviewInput,
  KnowledgeScanProgress,
  KnowledgeSearchHit,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
  KnowledgePlanProposalInput,
  KnowledgePlanConfirmInput,
  KnowledgeOutlineInput,
  KnowledgeDocumentWriteInput,
  KnowledgeWorkflowPauseInput,
  KnowledgeAssetCopyInput,
  KnowledgeAssetCopyResult,
  KnowledgeSourceKind,
} from '@proma/shared'
import { KNOWLEDGE_SOURCE_KINDS } from '@proma/shared'
import {
  organizeManagedKnowledge,
  reviewManagedKnowledge,
  undoManagedKnowledge,
} from './organizer'
import { resolveSourcePath, validateResolvedProject } from './paths'
import { scanProjectKnowledge } from './scanner'
import { containsKnowledgeSecret } from './sensitive-text'
import {
  MAX_READ_PAGE_BYTES,
  readSafeMetadataRevision,
  readSafeTextPage,
  verifySafeSourceIdentity,
} from './source-reader'
import { createProjectKnowledgeStore } from './store'
import { createKnowledgeVault, readVaultDocument } from './vault'
import { copyKnowledgeAsset } from './assets'
import type {
  KnowledgeManifest,
  KnowledgeScanTask,
  KnowledgeIndexCache,
  ProjectKnowledgeServiceDependencies,
  ProjectKnowledgeStore,
  ResolvedKnowledgeProject,
} from './types'

/** 空闲时对外展示的扫描状态。 */
const IDLE_SCAN: KnowledgeScanProgress = {
  status: 'idle',
  discovered: 0,
  indexed: 0,
  skipped: 0,
  changed: 0,
}
/** 1A 尚未启用的维护设置，明确保留真实默认值。 */
const DEFAULT_MAINTENANCE = {
  enabled: false,
  dailyJobLimit: 20,
  generation: 0,
} as const
/** 搜索最多接受的查询字符数。 */
const MAX_QUERY_LENGTH = 2_000
/** 单次读取允许跟随的最大重定向层数，避免损坏清单形成无界循环。 */
const MAX_REDIRECT_DEPTH = 16
/** 单个索引允许缓存的倒排词项数，异常高基数正文回退为逐条候选。 */
const MAX_INVERTED_TERMS = 200_000

/** 只有受管正文和对话提炼条目属于知识层；原文件始终属于来源层。 */
function isDistilledKnowledge(entry: KnowledgeEntry): boolean {
  return entry.source.kind === 'managed' || entry.source.kind === 'conversation'
}

/** 兼容已建库项目的旧来源状态，不改写不可变版本或伪造确认。 */
function presentSourceState(entry: KnowledgeEntry): KnowledgeEntry {
  return !isDistilledKnowledge(entry) && (entry.state === 'confirmed' || entry.state === 'draft')
    ? { ...entry, state: 'indexed' }
    : entry
}

/** 仅完整正文确实引用的旧知识版本退出默认目录，原件和历史仍可直接读取。 */
function migratedLegacyIds(manifest: KnowledgeManifest | null, entries: KnowledgeEntry[]): Set<string> {
  /** 已完整生成的主题条目，部分完成不能提前隐藏旧资料。 */
  const readyIds = new Set(manifest?.workflow?.outline?.items
    .filter((item) => item.status === 'ready').map((item) => item.entryId) ?? [])
  /** 来源当前版本的查找表。 */
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  /** 只隐藏精确迁移版本；原件随后变化则重新出现供补整理。 */
  const migrated = new Set<string>()
  for (const entry of entries) {
    if (!entry.document || !readyIds.has(entry.id) || entry.state === 'archived') continue
    for (const reference of entry.evidence ?? []) {
      /** 普通项目源码并非可迁移碎片，始终保留来源定位。 */
      const source = byId.get(reference.entryId)
      if (source && !source.document && isDistilledKnowledge(source) && source.revision === reference.revision) {
        migrated.add(source.id)
      }
    }
  }
  return migrated
}

/** 单个可重建索引对应的进程内倒排候选。 */
interface KnowledgeInvertedIndex {
  byTerm: Map<string, Set<string>>
  /** 超出词项预算的条目仍参与查询，避免静默漏检。 */
  overflowEntryIds: Set<string>
}

/** 中英文工程词的首版本地别名，不引入模型或外部依赖。 */
const SEARCH_ALIASES: ReadonlyArray<ReadonlyArray<string>> = [
  ['order', '订单'],
  ['payment', '支付'],
  ['checkout', '结算'],
  ['api', '接口'],
  ['design', '设计'],
  ['guide', '指南', '使用'],
  ['decision', '决策'],
  ['architecture', '架构'],
  ['plan', '规划'],
  ['test', '测试'],
  ['login', 'auth', 'authentication', '登录', '鉴权', '认证'],
]

/** 项目知识核心服务公开合同。 */
export interface ProjectKnowledgeService {
  /** 将已登记资产复制进已确认资料库，返回可移植相对链接。 */
  copyAsset: (input: KnowledgeAssetCopyInput) => Promise<KnowledgeAssetCopyResult>
  /** 保存待用户确认的分组提案，不生成正式正文。 */
  proposePlan: (input: KnowledgePlanProposalInput) => Promise<KnowledgeSnapshot>
  /** 仅由宿主 UI 确认用户所见版本和选中分组。 */
  confirmPlan: (input: KnowledgePlanConfirmInput) => Promise<KnowledgeSnapshot>
  /** 在已确认范围内保存真实文件大纲。 */
  saveOutline: (input: KnowledgeOutlineInput) => Promise<KnowledgeSnapshot>
  /** 依据大纲及磁盘版本保存自包含正文。 */
  writeDocument: (input: KnowledgeDocumentWriteInput) => Promise<KnowledgeSnapshot>
  /** 用户暂停或恢复已确认范围的维护。 */
  pauseWorkflow: (input: KnowledgeWorkflowPauseInput) => Promise<KnowledgeSnapshot>
  getSnapshot: (workspaceId: string) => Promise<KnowledgeSnapshot>
  startScan: (workspaceId: string) => Promise<KnowledgeSnapshot>
  cancelScan: (workspaceId: string) => Promise<KnowledgeSnapshot>
  search: (input: KnowledgeSearchInput) => Promise<KnowledgeSearchResult>
  read: (input: KnowledgeReadInput) => Promise<KnowledgeReadResult>
  reviewEntry: (input: KnowledgeReviewInput) => Promise<KnowledgeSnapshot>
  organize: (workspaceId: string) => Promise<KnowledgeSnapshot>
  undo: (workspaceId: string, operationId: string) => Promise<KnowledgeSnapshot>
  /** 等待已登记扫描任务结束；无任务时立即返回。 */
  waitForScan: (workspaceId: string) => Promise<void>
  /** 后续 1B/1C 复用的显式版本存储扩展点。 */
  store: ProjectKnowledgeStore
}

/** 校验分页整数输入。 */
function parsePaginationValue(value: number | undefined, fallback: number, maximum: number, label: string): number {
  /** 省略时采用的默认值。 */
  const parsed = value ?? fallback
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`${label}非法`)
  return parsed
}

/** 沿单目标重定向解析到当前条目；返回值始终至少包含一个目标。 */
function resolveRedirectTargets(manifest: KnowledgeManifest, entryId: string): [string, ...string[]] {
  /** 已访问的条目 ID，用于检测循环映射。 */
  const visited = new Set<string>()
  /** 当前待解析的条目 ID。 */
  let currentEntryId = entryId
  for (let depth = 0; depth < MAX_REDIRECT_DEPTH; depth += 1) {
    if (visited.has(currentEntryId)) throw new Error('知识条目重定向损坏')
    visited.add(currentEntryId)
    /** 当前条目的重定向目标。 */
    const targets = manifest.redirects?.[currentEntryId]
    if (!targets) return [currentEntryId]
    if (targets.length === 0) throw new Error('知识条目重定向损坏')
    if (targets.length !== 1) return [targets[0]!, ...targets.slice(1)]
    currentEntryId = targets[0]!
  }
  throw new Error('知识条目重定向层级过深')
}

/** 获取条目对应的可信来源根。 */
function getSourceRoot(project: ResolvedKnowledgeProject, entry: KnowledgeEntry): string | null {
  if (entry.source.kind === 'project-file') return project.projectRoot
  if (entry.source.kind === 'memory-file') return project.memoryRoot
  return null
}

/** 获取并校验文件来源路径。 */
function getEntrySourcePath(project: ResolvedKnowledgeProject, entry: KnowledgeEntry): string | null {
  /** 当前条目对应的可信来源根。 */
  const rootPath = getSourceRoot(project, entry)
  if (!rootPath || !entry.source.relativePath) return null
  return resolveSourcePath(rootPath, entry.source.relativePath)
}

/** 将查询扩展为中英文别名词集合。 */
function tokenizeQuery(query: string): string[] {
  /** 标准化后的小写查询。 */
  const normalized = query.toLocaleLowerCase()
  /** Intl 分词得到的自然语言词段。 */
  const segmentedTerms = [...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(normalized)]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment)
  /** 连续中文片段用于生成稳定双字召回词。 */
  const chineseRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? []
  /** 中文双字片段，避免整句只能精确 includes。 */
  const chineseBigrams = chineseRuns.flatMap((run) => {
    /** 当前中文片段的 Unicode 字符。 */
    const characters = [...run]
    return characters.length < 2
      ? characters
      : characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`)
  })
  /** 英文、数字与常见技术连接符词。 */
  const latinTerms = normalized.match(/[a-z0-9][a-z0-9._-]*/g) ?? []
  return [...new Set([...segmentedTerms, ...chineseBigrams, ...latinTerms])]
}

/** 将自然语言查询扩展为中英文别名词集合。 */
function expandQuery(query: string): string[] {
  /** 自然语言切分后的基础词。 */
  const baseTerms = tokenizeQuery(query)
  /** 包含别名的去重词集合。 */
  const terms = new Set(baseTerms)
  for (const term of baseTerms) {
    for (const aliasGroup of SEARCH_ALIASES) {
      if (aliasGroup.some((alias) => alias.toLocaleLowerCase() === term)) {
        for (const alias of aliasGroup) terms.add(alias.toLocaleLowerCase())
      }
    }
  }
  return [...terms]
}

/** 复核文件来源当前状态，不读取正文。 */
function getFileSourceFreshness(
  project: ResolvedKnowledgeProject,
  entry: KnowledgeEntry,
): 'current' | 'changed' | 'unavailable' {
  /** 当前条目的可信来源路径。 */
  const sourcePath = getEntrySourcePath(project, entry)
  if (!sourcePath) return 'unavailable'
  try {
    const current = entry.metadataOnly
      ? readSafeMetadataRevision(sourcePath).revision === entry.source.revision
      : verifySafeSourceIdentity(sourcePath, entry.source.revision)
    return current ? 'current' : 'changed'
  } catch {
    return 'unavailable'
  }
}

/** 按 UTF-8 字节边界分页受管正文。 */
function paginateManagedContent(content: string, offset: number): { content: string; nextOffset?: number } {
  /** 受管正文完整 UTF-8 字节。 */
  const bytes = Buffer.from(content, 'utf8')
  if (offset > bytes.length) throw new Error('正文偏移超出范围')
  if (offset > 0 && offset < bytes.length && ((bytes[offset] ?? 0) & 0xc0) === 0x80) {
    throw new Error('正文偏移不在 UTF-8 字符边界')
  }
  /** 当前页预算内的候选终点。 */
  const maximumEnd = Math.min(bytes.length, offset + MAX_READ_PAGE_BYTES)
  /** 调整后的 UTF-8 安全终点。 */
  let end = maximumEnd
  while (end > offset && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return {
    content: bytes.subarray(offset, end).toString('utf8'),
    nextOffset: end < bytes.length ? end : undefined,
  }
}

/** 返回首个命中词附近的有界片段与行号。 */
function createSnippet(text: string, terms: string[]): { snippet: string; line: number; bodyHits: number } | null {
  /** 小写正文用于不区分英文大小写定位。 */
  const lowerText = text.toLocaleLowerCase()
  /** 各查询词的命中位置。 */
  const positions = terms
    .map((term) => lowerText.indexOf(term))
    .filter((position) => position >= 0)
  if (positions.length === 0) return null
  /** 最早命中位置。 */
  const firstPosition = Math.min(...positions)
  /** 片段起点。 */
  const start = Math.max(0, firstPosition - 80)
  /** 片段终点。 */
  const end = Math.min(text.length, firstPosition + 240)
  /** 命中位置前的行数。 */
  const line = text.slice(0, firstPosition).split('\n').length
  return {
    snippet: `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`,
    line,
    bodyHits: positions.length,
  }
}

/** 计算标题、路径与正文的可解释本地相关性。 */
function scoreEntry(entry: KnowledgeEntry, text: string, terms: string[]): KnowledgeSearchHit | null {
  /** 条目标题的小写文本。 */
  const title = entry.title.toLocaleLowerCase()
  /** 来源路径的小写文本。 */
  const path = (entry.source.relativePath ?? '').toLocaleLowerCase()
  /** 安全摘要的小写文本，用于仅元数据来源检索。 */
  const summary = entry.summary.toLocaleLowerCase()
  /** 标题命中数。 */
  const titleHits = terms.filter((term) => title.includes(term)).length
  /** 路径命中数。 */
  const pathHits = terms.filter((term) => path.includes(term)).length
  /** 摘要命中数。 */
  const summaryHits = terms.filter((term) => summary.includes(term)).length
  /** 正文片段命中。 */
  const body = createSnippet(text, terms)
  if (titleHits + pathHits + summaryHits === 0 && !body) return null
  return {
    entry,
    snippet: body?.snippet ?? entry.summary,
    line: body?.line ?? 1,
    score: titleHits * 100 + pathHits * 40 + summaryHits * 20 + (body?.bodyHits ?? 0) * 10,
  }
}

/** 创建项目知识库 1A 核心服务。 */
export function createProjectKnowledgeService(
  dependencies: ProjectKnowledgeServiceDependencies,
): ProjectKnowledgeService {
  /** 后续阶段共享的版本存储。 */
  const store = createProjectKnowledgeStore(dependencies)
  /** 普通目录与 Markdown 的受控读写及外部编辑同步。 */
  const vault = createKnowledgeVault(dependencies, store)
  /** 当前进程内按 projectId 登记的扫描任务。 */
  const scanTasks = new Map<string, KnowledgeScanTask>()
  /** 已解析索引对象对应的倒排候选，索引文件身份变化后自动失效。 */
  const invertedIndexes = new WeakMap<KnowledgeIndexCache, KnowledgeInvertedIndex>()
  /** 服务使用的可注入时钟。 */
  const now = dependencies.now ?? Date.now

  /** 每次调用 fresh resolve 并校验可信根。 */
  function resolveWorkspace(workspaceId: string): ResolvedKnowledgeProject {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('工作区 ID 非法')
    /** 宿主当前解析出的项目边界。 */
    const project = dependencies.resolveProject(workspaceId)
    validateResolvedProject(project)
    return project
  }

  /** 返回当前项目的内存扫描状态。 */
  function getScanProgress(projectId: string): KnowledgeScanProgress {
    return scanTasks.get(projectId)?.progress ?? { ...IDLE_SCAN }
  }

  /** 为当前索引建立一次进程内倒排表，避免每次查询扫描全部正文。 */
  function getInvertedIndex(index: KnowledgeIndexCache): KnowledgeInvertedIndex {
    const cached = invertedIndexes.get(index)
    if (cached) return cached
    /** 正文词项到条目 ID 的候选映射。 */
    const byTerm = new Map<string, Set<string>>()
    /** 因高基数超预算而需要回退检查的条目。 */
    const overflowEntryIds = new Set<string>()
    for (const record of Object.values(index.records)) {
      /** 单条正文内去重后的可查询词项。 */
      const recordTerms = new Set(tokenizeQuery(record.text).filter((term) => term.length <= 128))
      for (const term of recordTerms) {
        let entryIds = byTerm.get(term)
        if (!entryIds) {
          if (byTerm.size >= MAX_INVERTED_TERMS) {
            overflowEntryIds.add(record.entryId)
            break
          }
          entryIds = new Set<string>()
          byTerm.set(term, entryIds)
        }
        entryIds.add(record.entryId)
      }
    }
    const built = { byTerm, overflowEntryIds }
    invertedIndexes.set(index, built)
    return built
  }

  /** 返回正文可能命中任一查询词的条目 ID。 */
  function getBodyCandidateIds(index: KnowledgeIndexCache | null, terms: string[]): Set<string> {
    if (!index) return new Set<string>()
    const inverted = getInvertedIndex(index)
    /** 当前查询所有正文候选的并集。 */
    const candidates = new Set(inverted.overflowEntryIds)
    for (const term of terms) {
      for (const entryId of inverted.byTerm.get(term) ?? []) candidates.add(entryId)
    }
    return candidates
  }

  /** 将来源变化投影到搜索结果，并清空可能过期的摘要片段。 */
  function staleSearchHit(
    hit: KnowledgeSearchHit,
    freshness: 'changed' | 'unavailable',
  ): KnowledgeSearchHit {
    return {
      ...hit,
      entry: { ...hit.entry, freshness, summary: '' },
      snippet: '',
      line: 1,
    }
  }

  /** 只为待展示知识核验有限来源，拒绝递归知识引用及过期文件依据。 */
  async function getEvidenceFreshness(
    project: ResolvedKnowledgeProject,
    manifest: KnowledgeManifest,
    entry: KnowledgeEntry,
  ): Promise<'current' | 'changed' | 'unavailable'> {
    if (!entry.evidence || (entry.document && entry.evidence.length === 0)) return 'current'
    if (entry.evidence.length === 0 || entry.evidence.length > 8) return 'unavailable'
    for (const reference of entry.evidence) {
      try {
        /** 证据固定指向扫描来源的条目版本，禁止沿知识层形成循环。 */
        const source = store.readEntry(project, manifest, reference.entryId)
        if ((isDistilledKnowledge(source) && (!entry.document || source.document)) || (manifest.excludedSources ?? []).includes(source.source.id)
          || source.state === 'archived' || source.freshness === 'unavailable') return 'unavailable'
        if (source.revision !== reference.revision) return 'changed'
        // 旧碎片作为迁移材料固定引用其已存版本，不递归继承其结论的事实背书。
        if (entry.document && isDistilledKnowledge(source)) continue
        if (source.source.kind === 'canvas' || source.source.kind === 'api') {
          /** 受控来源仍须通过业务服务确认当前实际版本。 */
          const result = await dependencies.controlledSources?.read({
            projectId: project.projectId, sourceId: source.source.id, expectedRevision: source.source.revision,
          })
          if (!result || result.status === 'unavailable') return 'unavailable'
          if (result.status !== 'readable' || result.source?.revision !== source.source.revision
            || result.source.sourceId !== source.source.id || containsKnowledgeSecret(result.content)) return 'changed'
        } else {
          /** 文件版本核对不读取整个项目，仅检查这一条证据的真实文件身份。 */
          const freshness = getFileSourceFreshness(project, source)
          if (freshness !== 'current') return freshness
        }
      } catch {
        return 'unavailable'
      }
    }
    return 'current'
  }

  /** 只对已经分页选中的命中复核来源，避免查询读取全部正文。 */
  async function refreshSearchHit(
    project: ResolvedKnowledgeProject,
    manifest: KnowledgeManifest,
    hit: KnowledgeSearchHit,
    terms: string[] | null,
  ): Promise<KnowledgeSearchHit> {
    const entry = presentSourceState(hit.entry)
    hit = { ...hit, entry }
    if (entry.source.kind === 'canvas' || entry.source.kind === 'api') {
      if (!dependencies.controlledSources) return staleSearchHit(hit, 'unavailable')
      /** 当前页受控来源按稳定业务身份复核。 */
      const current = await dependencies.controlledSources.read({
        projectId: project.projectId,
        sourceId: entry.source.id,
        expectedRevision: entry.source.revision,
      })
      if (current.status === 'unavailable') return staleSearchHit(hit, 'unavailable')
      if (current.status === 'changed'
        || !current.source
        || current.source.sourceId !== entry.source.id
        || current.source.revision !== entry.source.revision
        || containsKnowledgeSecret(current.content)) return staleSearchHit(hit, 'changed')
      if (!terms) return { ...hit, snippet: entry.summary }
      return scoreEntry(entry, current.content, terms) ?? staleSearchHit(hit, 'changed')
    }
    if (entry.source.kind === 'managed' || entry.source.kind === 'conversation') {
      try {
        /** 真实文档保留可读内容，来源变化单独标记为待核对。 */
        const freshness = await getEvidenceFreshness(project, manifest, entry)
        if (!entry.document && freshness !== 'current') return staleSearchHit(hit, freshness)
        /** 新文档以磁盘正文为准，旧碎片继续读取固定历史版本。 */
        const content = entry.document ? readVaultDocument(project, entry) : store.readContent(project, manifest, entry.id)
        if (content === null) return staleSearchHit(hit, 'unavailable')
        /** 阅读状态独立于事实新鲜度，保留原证据便于追溯。 */
        const currentEntry = { ...entry, freshness: freshness === 'current' ? entry.freshness : freshness }
        if (!terms) return { ...hit, entry: currentEntry, snippet: entry.summary }
        return scoreEntry(currentEntry, content.slice(0, 256 * 1024), terms) ?? staleSearchHit(hit, 'changed')
      } catch {
        return staleSearchHit(hit, 'unavailable')
      }
    }
    /** 文件来源当前页只做 no-follow 身份核验，不读取正文。 */
    const freshness = getFileSourceFreshness(project, entry)
    return freshness === 'current' ? hit : staleSearchHit(hit, freshness)
  }

  /** 由可选 manifest 构造首页快照。 */
  function createSnapshot(
    project: ResolvedKnowledgeProject,
    manifest: KnowledgeManifest | null,
  ): KnowledgeSnapshot {
    /** 当前清单的完整条目。 */
    const allEntries = manifest ? store.readEntries(project, manifest) : []
    /** 已成功融入正式文件的旧知识只保留历史/来源入口。 */
    const migratedIds = migratedLegacyIds(manifest, allEntries)
    /** 稳定排序后的目录。 */
    const sortedEntries = allEntries.filter((entry) => !migratedIds.has(entry.id)).sort((left, right) => (
      right.updatedAt - left.updatedAt || left.title.localeCompare(right.title, 'zh-CN')
    ))
    /** 原文件与提炼知识分别统计，归档和替代结果不计入当前知识成果。 */
    const visibleEntries = sortedEntries.filter((entry) => entry.state !== 'archived' && entry.state !== 'superseded'
      && !(manifest?.excludedSources ?? []).includes(entry.source.id))
    return {
      workflow: manifest?.workflow,
      projectId: project.projectId,
      initialized: Boolean(manifest),
      revision: manifest?.revision ?? 0,
      entries: sortedEntries.slice(0, 200).map(presentSourceState),
      totalEntries: sortedEntries.length,
      knowledgeCount: visibleEntries.filter(isDistilledKnowledge).length,
      sourceCount: visibleEntries.filter((entry) => !isDistilledKnowledge(entry)).length,
      scan: getScanProgress(project.projectId),
      maintenance: manifest?.maintenance?.settings ?? { ...DEFAULT_MAINTENANCE },
      pendingTurns: manifest?.maintenance?.jobs.filter((job) => (
        job.status === 'pending' || job.status === 'running' || job.status === 'failed'
      )).length ?? 0,
      updatedAt: manifest?.updatedAt,
      operations: manifest?.operations?.slice(-20).map((operation) => ({
        id: operation.id,
        kind: operation.kind,
        summary: operation.summary,
        entryIds: operation.entryIds,
        createdAt: operation.createdAt,
        undoable: operation.undoable,
      })),
    }
  }

  /** 只读当前快照，不初始化知识库。 */
  async function getSnapshot(workspaceId: string): Promise<KnowledgeSnapshot> {
    await vault.refresh(workspaceId)
    /** 当前 fresh 解析的项目。 */
    const project = resolveWorkspace(workspaceId)
    return createSnapshot(project, store.readManifest(project))
  }

  /** 提案只更新工作流，返回最新权威清单供 Agent 等待用户确认。 */
  async function proposePlan(input: KnowledgePlanProposalInput): Promise<KnowledgeSnapshot> {
    await vault.proposePlan(input)
    return getSnapshot(input.workspaceId)
  }

  /** 用户对清单做精确版本确认后返回可继续执行的范围。 */
  async function confirmPlan(input: KnowledgePlanConfirmInput): Promise<KnowledgeSnapshot> {
    await vault.confirmPlan(input)
    return getSnapshot(input.workspaceId)
  }

  /** 大纲先于正文落盘，待补项保持无正文身份。 */
  async function saveOutline(input: KnowledgeOutlineInput): Promise<KnowledgeSnapshot> {
    await vault.saveOutline(input)
    return getSnapshot(input.workspaceId)
  }

  /** 正文写入由 vault 复核磁盘和计划版本，拒绝覆盖人工修改。 */
  async function writeDocument(input: KnowledgeDocumentWriteInput): Promise<KnowledgeSnapshot> {
    await vault.writeDocument(input)
    return getSnapshot(input.workspaceId)
  }

  /** 暂停只修改后续维护状态，不改变已有可读文件。 */
  async function pauseWorkflow(input: KnowledgeWorkflowPauseInput): Promise<KnowledgeSnapshot> {
    await vault.pauseWorkflow(input)
    return getSnapshot(input.workspaceId)
  }

  /** 启动后台扫描并在返回前登记可等待任务。 */
  async function startScan(workspaceId: string): Promise<KnowledgeSnapshot> {
    /** 本次启动 fresh 解析的项目。 */
    const project = resolveWorkspace(workspaceId)
    /** 同项目已有扫描时直接返回当前状态。 */
    const existingTask = scanTasks.get(project.projectId)
    if (existingTask?.progress.status === 'running') return createSnapshot(project, store.readManifest(project))
    if (dependencies.assertWritable) await dependencies.assertWritable(workspaceId)
    /** 首次扫描才初始化权威空清单。 */
    const manifest = await store.initialize(project, workspaceId)
    /** 对外立即可见的运行状态。 */
    const progress: KnowledgeScanProgress = {
      status: 'running',
      discovered: 0,
      indexed: 0,
      skipped: 0,
      changed: 0,
      startedAt: now(),
    }
    /** 先建立任务对象，再启动异步扫描。 */
    const task: KnowledgeScanTask = {
      cancelled: false,
      progress,
      promise: Promise.resolve(),
    }
    scanTasks.set(project.projectId, task)
    task.promise = (async () => {
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
      try {
        /** 扫描执行时再次解析，防止使用迁移前路径。 */
        const currentProject = resolveWorkspace(workspaceId)
        if (currentProject.projectId !== project.projectId) throw new Error('扫描期间项目身份已变化')
        /** 执行扫描时的最新权威清单。 */
        const currentManifest = store.readManifest(currentProject)
        if (!currentManifest) throw new Error('知识库尚未初始化')
        /** 本轮扫描发布结果。 */
        const result = await scanProjectKnowledge({
          project: currentProject,
          workspaceId,
          store,
          manifest: currentManifest,
          now,
          isCancelled: () => task.cancelled,
          onProgress: (partial) => Object.assign(task.progress, partial),
          controlledSources: dependencies.controlledSources,
        })
        task.progress.status = result.cancelled ? 'cancelled' : 'completed'
        task.progress.discovered = result.discovered
        task.progress.indexed = result.indexed
        task.progress.skipped = result.skipped
        task.progress.changed = result.changed
        task.progress.finishedAt = now()
        task.progress.message = result.message ?? (!result.complete && !result.cancelled
          ? '扫描因资源或读取错误未完整覆盖，未把未枚举来源标记为删除'
          : undefined)
      } catch (error) {
        task.progress.status = task.cancelled ? 'cancelled' : 'failed'
        task.progress.finishedAt = now()
        task.progress.message = error instanceof Error ? error.message : '知识扫描失败'
      }
    })()
    return createSnapshot(project, manifest)
  }

  /** 请求取消当前项目扫描。 */
  async function cancelScan(workspaceId: string): Promise<KnowledgeSnapshot> {
    /** 当前 fresh 解析的项目。 */
    const project = resolveWorkspace(workspaceId)
    /** 当前扫描任务。 */
    const task = scanTasks.get(project.projectId)
    if (task?.progress.status === 'running') {
      task.cancelled = true
      task.progress.message = '正在取消扫描'
    }
    return createSnapshot(project, store.readManifest(project))
  }

  /** 等待已登记扫描结束，供运行时持有 workspace lease。 */
  async function waitForScan(workspaceId: string): Promise<void> {
    /** 当前 fresh 解析的项目。 */
    const project = resolveWorkspace(workspaceId)
    /** startScan 返回前已经登记的任务。 */
    const task = scanTasks.get(project.projectId)
    if (task) await task.promise
  }

  /** 读取索引目录或关键词查询，不触发扫描。 */
  async function search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
    if (!input || typeof input.query !== 'string') throw new Error('知识检索输入非法')
    if (input.scope !== undefined && !['knowledge', 'sources', 'all'].includes(input.scope)) throw new Error('知识检索范围非法')
    if (input.sourceKind !== undefined && !KNOWLEDGE_SOURCE_KINDS.includes(input.sourceKind as KnowledgeSourceKind)) {
      throw new Error('知识检索来源类型非法')
    }
    /** 去除首尾空白后的查询。 */
    const query = input.query.trim()
    if (query.length > MAX_QUERY_LENGTH) throw new Error('知识检索查询过长')
    /** 安全分页起点。 */
    const offset = parsePaginationValue(input.offset, 0, 1_000_000, '搜索偏移')
    /** 安全分页数量。 */
    const limit = parsePaginationValue(input.limit, 6, 100, '搜索数量')
    if (limit < 1) throw new Error('搜索数量非法')
    await vault.refresh(input.workspaceId)
    /** 当前 fresh 解析的项目。 */
    const project = resolveWorkspace(input.workspaceId)
    /** 当前权威清单。 */
    const manifest = store.readManifest(project)
    if (!manifest) return { revision: 0, items: [], total: 0, indexStatus: 'missing' }
    /** 当前清单全部条目。 */
    const allEntries = store.readEntries(project, manifest)
    /** 默认知识查询去掉已经完整迁移的旧碎片，includeHistory 可再次查看。 */
    const migratedIds = migratedLegacyIds(manifest, allEntries)
    const entries = allEntries
      .filter((entry) => input.includeHistory || input.scope === 'sources' || !migratedIds.has(entry.id))
      .filter((entry) => !(manifest.excludedSources ?? []).includes(entry.source.id))
      .filter((entry) => input.scope === 'knowledge' ? isDistilledKnowledge(entry)
        : input.scope === 'sources' ? !isDistilledKnowledge(entry) : true)
      .filter((entry) => !input.sourceKind || entry.source.kind === input.sourceKind)
      .filter((entry) => !input.category || entry.category === input.category)
      .filter((entry) => input.includeHistory
        ? true
        : entry.state !== 'archived' && entry.state !== 'superseded'
          && (entry.freshness === 'current' || Boolean(entry.document && entry.freshness !== 'unavailable')))
    /** 与当前 manifest 精确匹配的缓存。 */
    const index = store.readIndex(project, manifest.indexRevision ?? manifest.revision)
    /** 当前扫描是否正在构建索引。 */
    const running = scanTasks.get(project.projectId)?.progress.status === 'running'
    /** 本次索引可观察状态。 */
    const indexStatus = index ? 'ready' : running ? 'building' : 'missing'
    /** 空查询先按元数据分页，再只复核当前页来源。 */
    if (!query) {
      const sorted = entries.sort((left, right) => (
        right.updatedAt - left.updatedAt || left.title.localeCompare(right.title)
      ))
      /** 当前页只含元数据的候选。 */
      const page = sorted.slice(offset, offset + limit).map((entry) => ({
        entry,
        snippet: entry.summary,
        line: 1,
        score: 0,
      }))
      /** 当前页复核后的目录命中。 */
      const items = await Promise.all(page.map((hit) => refreshSearchHit(project, manifest, hit, null)))
      return {
        revision: manifest.revision,
        items,
        total: entries.length,
        nextOffset: offset + items.length < sorted.length ? offset + items.length : undefined,
        indexStatus,
      }
    }
    /** 展开别名后的查询词。 */
    const terms = expandQuery(query)
    /** 正文倒排表筛出的候选条目。 */
    const bodyCandidateIds = getBodyCandidateIds(index, terms)
    /** 基于元数据与索引的相关命中，尚未读取来源。 */
    const hits: KnowledgeSearchHit[] = []
    for (const entry of entries) {
      /** 只有倒排候选才读取其内存索引正文。 */
      const record = bodyCandidateIds.has(entry.id) ? index?.records[entry.id] : undefined
      /** 缓存必须精确匹配条目版本。 */
      const text = record?.entryRevision === entry.revision ? record.text : ''
      /** 元数据始终参与，正文只对倒排候选计分。 */
      const hit = scoreEntry(entry, text, terms)
      if (hit) hits.push(hit)
    }
    hits.sort((left, right) => right.score - left.score || right.entry.updatedAt - left.entry.updatedAt)
    /** 先分页，再只复核当前页命中的真实来源。 */
    const page = hits.slice(offset, offset + limit)
    const items = await Promise.all(page.map((hit) => refreshSearchHit(project, manifest, hit, terms)))
    return {
      revision: manifest.revision,
      items,
      total: hits.length,
      nextOffset: offset + items.length < hits.length ? offset + items.length : undefined,
      indexStatus,
    }
  }

  /** 从已登记来源有界读取当前正文。 */
  async function read(input: KnowledgeReadInput): Promise<KnowledgeReadResult> {
    if (!input || typeof input.entryId !== 'string' || !/^[a-f0-9]{32}$/.test(input.entryId)) {
      throw new Error('知识条目 ID 非法')
    }
    /** 安全正文偏移。 */
    const offset = parsePaginationValue(input.offset, 0, Number.MAX_SAFE_INTEGER, '正文偏移')
    await vault.refresh(input.workspaceId)
    /** 当前 fresh 解析的项目。 */
    const project = resolveWorkspace(input.workspaceId)
    /** 当前权威清单。 */
    const manifest = store.readManifest(project)
    if (!manifest) throw new Error('知识条目不存在')
    /** 调用方请求的原始条目。 */
    const requestedEntry = presentSourceState(store.readEntry(project, manifest, input.entryId))
    if ((manifest.excludedSources ?? []).includes(requestedEntry.source.id)) {
      return { entry: requestedEntry, content: '', status: 'unavailable', offset, truncated: false }
    }
    /** 当前旧 ID 经过有界链式解析后的重定向目标。 */
    const redirectTargets = resolveRedirectTargets(manifest, input.entryId)
    if (redirectTargets && redirectTargets.length > 1) {
      /** 所有拆分子条目的目录行。 */
      const lines = redirectTargets.map((entryId) => {
        /** 当前子条目标题。 */
        const child = store.readEntry(project, manifest, entryId)
        return `- ${child.title} (${entryId})`
      })
      /** 旧拆分引用返回的目录式正文。 */
      const directoryContent = `# ${requestedEntry.title}\n\n已拆分为以下受管条目：\n\n${lines.join('\n')}`
      /** 当前目录正文页。 */
      const page = paginateManagedContent(directoryContent, offset)
      return {
        entry: requestedEntry,
        content: page.content,
        status: 'readable',
        offset,
        nextOffset: page.nextOffset,
        truncated: page.nextOffset !== undefined,
      }
    }
    /** 单目标重定向解析到当前条目。 */
    const resolvedEntryId = redirectTargets[0]
    /** 当前条目元数据。 */
    const entry = resolvedEntryId === input.entryId
      ? requestedEntry
      : presentSourceState(store.readEntry(project, manifest, resolvedEntryId))
    if (input.expectedRevision && input.expectedRevision !== requestedEntry.revision) {
      return { entry, content: '', status: 'changed', offset, truncated: false }
    }
    if (entry.source.kind === 'canvas' || entry.source.kind === 'api') {
      if (!dependencies.controlledSources) {
        return { entry, content: '', status: 'unavailable', offset, truncated: false }
      }
      /** 受控来源按稳定业务身份 fresh-read，不接受调用方路径。 */
      const current = await dependencies.controlledSources.read({
        projectId: project.projectId,
        sourceId: entry.source.id,
        expectedRevision: entry.source.revision,
      })
      if (current.status === 'changed') {
        return { entry, content: '', status: 'changed', offset, truncated: false }
      }
      if (current.status === 'unavailable') {
        return { entry, content: '', status: 'unavailable', offset, truncated: false }
      }
      if (current.status === 'metadata-only') {
        return { entry, content: '', status: 'metadata-only', offset, truncated: false }
      }
      if (!current.source
        || current.source.sourceId !== entry.source.id
        || current.source.revision !== entry.source.revision
        || containsKnowledgeSecret(current.content)) {
        return { entry, content: '', status: 'changed', offset, truncated: false }
      }
      /** 当前安全投影按统一 UTF-8 页预算返回。 */
      const page = paginateManagedContent(current.content, offset)
      return {
        entry,
        content: page.content,
        status: 'readable',
        offset,
        nextOffset: page.nextOffset,
        truncated: current.truncated || page.nextOffset !== undefined,
      }
    }
    if (entry.source.kind === 'managed' || entry.source.kind === 'conversation') {
      /** 来源新鲜度与正式文档的可读性分离，旧碎片沿用原契约。 */
      const freshness = await getEvidenceFreshness(project, manifest, entry)
      if (!entry.document && freshness !== 'current') {
        return { entry: { ...entry, freshness, summary: '' }, content: '', status: freshness, offset, truncated: false }
      }
      /** 正式文档只从当前磁盘读取，删除后绝不从历史缓存复活。 */
      const content = entry.document ? readVaultDocument(project, entry) : store.readContent(project, manifest, entry.id)
      if (content === null) return { entry, content: '', status: 'unavailable', offset, truncated: false }
      /** 当前正文页。 */
      const page = paginateManagedContent(content, offset)
      return {
        entry: { ...entry, freshness: freshness === 'current' ? entry.freshness : freshness },
        content: page.content,
        status: 'readable',
        offset,
        nextOffset: page.nextOffset,
        truncated: page.nextOffset !== undefined,
      }
    }
    /** 当前条目的可信来源路径。 */
    const sourcePath = getEntrySourcePath(project, entry)
    if (!sourcePath) return { entry, content: '', status: 'unavailable', offset, truncated: false }
    if (entry.metadataOnly) {
      try {
        /** 只以 stat 复核二进制来源版本。 */
        const currentRevision = readSafeMetadataRevision(sourcePath).revision
        return {
          entry,
          content: '',
          status: currentRevision === entry.source.revision ? 'metadata-only' : 'changed',
          offset,
          truncated: false,
        }
      } catch {
        return { entry, content: '', status: 'unavailable', offset, truncated: false }
      }
    }
    try {
      /** 当前来源的有界正文页。 */
      const page = await readSafeTextPage(sourcePath, offset)
      if (page.revision !== entry.source.revision) {
        return { entry, content: '', status: 'changed', offset, truncated: false }
      }
      return {
        entry,
        content: page.content,
        status: 'readable',
        offset,
        nextOffset: page.nextOffset,
        truncated: page.nextOffset !== undefined,
      }
    } catch (error) {
      if (error instanceof Error && (
        error.message.includes('偏移') || error.message.includes('UTF-8 字符边界')
      )) throw error
      /** 文件缺失与权限撤销统一为不可用，身份变化明确为 changed。 */
      const code = error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
        return { entry, content: '', status: 'unavailable', offset, truncated: false }
      }
      return { entry, content: '', status: 'changed', offset, truncated: false }
    }
  }

  /** 确认或拒绝受管候选。 */
  async function reviewEntry(input: KnowledgeReviewInput): Promise<KnowledgeSnapshot> {
    /** 当前 fresh 解析的项目。 */
    const project = resolveWorkspace(input.workspaceId)
    /** 审核后权威清单。 */
    const manifest = await reviewManagedKnowledge({
      project,
      workspaceId: input.workspaceId,
      store,
      now,
    }, input)
    return createSnapshot(project, manifest)
  }

  /** 整理当前项目的受管资料。 */
  async function organize(workspaceId: string): Promise<KnowledgeSnapshot> {
    /** 当前 fresh 解析的项目。 */
    const project = resolveWorkspace(workspaceId)
    /** 未初始化项目不得由整理隐式建库。 */
    if (!store.readManifest(project)) return createSnapshot(project, null)
    /** 整理后权威清单。 */
    const manifest = await organizeManagedKnowledge({ project, workspaceId, store, now })
    return createSnapshot(project, manifest)
  }

  /** 撤销仍匹配当前版本的受管整理操作。 */
  async function undo(workspaceId: string, operationId: string): Promise<KnowledgeSnapshot> {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(operationId)) throw new Error('知识操作 ID 非法')
    /** 当前 fresh 解析的项目。 */
    const project = resolveWorkspace(workspaceId)
    /** 撤销后权威清单。 */
    const manifest = await undoManagedKnowledge({ project, workspaceId, store, now }, operationId)
    return createSnapshot(project, manifest)
  }

  return {
    proposePlan,
    copyAsset: (input) => copyKnowledgeAsset(dependencies, store, input),
    confirmPlan,
    saveOutline,
    writeDocument,
    pauseWorkflow,
    getSnapshot,
    startScan,
    cancelScan,
    search,
    read,
    reviewEntry,
    organize,
    undo,
    waitForScan,
    store,
  }
}

export type {
  KnowledgeManifest,
  ProjectKnowledgeServiceDependencies,
  ProjectKnowledgeStore,
  ResolvedKnowledgeProject,
} from './types'
