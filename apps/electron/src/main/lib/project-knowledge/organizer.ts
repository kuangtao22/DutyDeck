import { createHash, randomUUID } from 'node:crypto'
import type { KnowledgeCategory, KnowledgeEntry, KnowledgeReviewInput } from '@proma/shared'
import type {
  KnowledgeEntryCommit,
  KnowledgeManifest,
  KnowledgeOperationRecord,
  ProjectKnowledgeStore,
  ResolvedKnowledgeProject,
} from './types'

/** 自动整理保留的完整操作上限；快照只展示最近二十条。 */
const MAX_OPERATION_RECORDS = 100
/** 超过单次正文读取预算的长文档，在存在章节边界时允许拆分。 */
const LONG_DOCUMENT_BYTES = 24 * 1024

/** 受管整理依赖。 */
export interface KnowledgeOrganizerDependencies {
  project: ResolvedKnowledgeProject
  workspaceId: string
  store: ProjectKnowledgeStore
  now: () => number
}

/** 不含 revision 的条目生成稳定不可变版本。 */
function withNewRevision(entry: Omit<KnowledgeEntry, 'revision'>): KnowledgeEntry {
  /** 条目完整字段的内容摘要。 */
  const revision = createHash('sha256').update(JSON.stringify(entry)).digest('hex')
  return { ...entry, revision }
}

/** 判断条目是否属于整理器拥有的受管正文。 */
function isManagedEntry(entry: KnowledgeEntry): boolean {
  // 正式文件的组织由用户确认的大纲负责，旧碎片规则不得改分类、合并或拆分。
  return !entry.document && (entry.source.kind === 'managed' || entry.source.kind === 'conversation')
}

/** 轻量推断受管资料分类。 */
function inferManagedCategory(entry: KnowledgeEntry, content: string): KnowledgeCategory {
  /** 用于规则匹配的标题与正文开头。 */
  const text = `${entry.title}\n${content.slice(0, 4_096)}`.toLocaleLowerCase()
  if (entry.kind === 'decision' || /决策|decision/.test(text)) return 'decisions'
  if (/api|接口|架构|architecture|技术/.test(text)) return 'engineering'
  if (/设计|交互|视觉|design|\bui\b|\bux\b/.test(text)) return 'design'
  if (/规划|计划|roadmap|plan/.test(text)) return 'planning'
  if (/指南|使用|教程|guide|tutorial/.test(text)) return 'guides'
  if (/总览|介绍|overview/.test(text)) return 'overview'
  return entry.category
}

/** 合并操作列表并施加持久化上限。 */
function appendOperations(
  current: KnowledgeOperationRecord[] | undefined,
  additions: KnowledgeOperationRecord[],
): KnowledgeOperationRecord[] {
  return [...(current ?? []), ...additions].slice(-MAX_OPERATION_RECORDS)
}

/** 从 Markdown 正文提取 H2 章节。 */
function extractH2Sections(content: string): Array<{ heading: string; content: string }> {
  /** 所有 H2 标题及字符位置。 */
  const matches = [...content.matchAll(/^##\s+(.+)$/gm)]
  return matches.map((match, index) => {
    /** 当前章节起点。 */
    const start = match.index ?? 0
    /** 下一章节或文末终点。 */
    const end = matches[index + 1]?.index ?? content.length
    return { heading: match[1]?.trim() ?? `章节 ${index + 1}`, content: content.slice(start, end).trim() }
  }).filter((section) => section.content.length > 0)
}

/** 创建拆分子条目的稳定身份。 */
function createSplitEntryId(parentId: string, heading: string, index: number): string {
  return createHash('sha256').update(`${parentId}\0${heading}\0${index}`).digest('hex').slice(0, 32)
}

/** 创建操作记录。 */
function createOperation(
  input: Omit<KnowledgeOperationRecord, 'id' | 'createdAt'>,
  now: number,
): KnowledgeOperationRecord {
  return { ...input, id: randomUUID(), createdAt: now }
}

/** 对受管资料执行分类、完全重复合并和有边界章节拆分。 */
export async function organizeManagedKnowledge(
  dependencies: KnowledgeOrganizerDependencies,
): Promise<KnowledgeManifest> {
  return dependencies.store.transact(dependencies.project, dependencies.workspaceId, (current) => {
    /** 整理过程中的当前条目映射。 */
    const entries = new Map(current.entries.map((entry) => [entry.id, entry]))
    /** 当前受管正文映射。 */
    const contents = new Map<string, string>()
    for (const entry of current.entries) {
      if (!isManagedEntry(entry)) continue
      /** 当前 manifest 固定版本的受管正文。 */
      const content = dependencies.store.readContent(dependencies.project, current.manifest, entry.id)
      if (content !== null) contents.set(entry.id, content)
    }
    /** 本轮不可变条目提交。 */
    const commits: KnowledgeEntryCommit[] = []
    /** 本轮完整操作记录。 */
    const operations: KnowledgeOperationRecord[] = []
    /** 下一版重定向。 */
    const redirects: Record<string, string[]> = { ...(current.manifest.redirects ?? {}) }

    for (const entry of [...entries.values()]) {
      if (!isManagedEntry(entry) || entry.state !== 'confirmed' || redirects[entry.id]) continue
      /** 当前受管正文。 */
      const content = contents.get(entry.id)
      if (content === undefined) continue
      /** 规则推断出的分类。 */
      const category = inferManagedCategory(entry, content)
      if (category === entry.category) continue
      /** 分类后的新不可变条目。 */
      const classified = withNewRevision({ ...entry, category, updatedAt: dependencies.now() })
      entries.set(entry.id, classified)
      commits.push({ entry: classified, content })
      operations.push(createOperation({
        kind: 'classify',
        summary: `将「${entry.title}」归类到 ${category}`,
        entryIds: [entry.id],
        undoable: true,
        before: [{ entryId: entry.id, revision: entry.revision }],
        after: [{ entryId: entry.id, revision: classified.revision }],
        redirectsBefore: {},
        redirectsAfter: {},
      }, dependencies.now()))
    }

    /** 以正文完整摘要分组的有效受管条目。 */
    const duplicateGroups = new Map<string, KnowledgeEntry[]>()
    for (const entry of entries.values()) {
      if (!isManagedEntry(entry) || entry.state !== 'confirmed' || redirects[entry.id]) continue
      /** 当前条目的完整受管正文。 */
      const content = contents.get(entry.id)
      if (content === undefined) continue
      /** 完全正文摘要。 */
      const digest = createHash('sha256').update(content).digest('hex')
      duplicateGroups.set(digest, [...(duplicateGroups.get(digest) ?? []), entry])
    }
    for (const group of duplicateGroups.values()) {
      if (group.length < 2) continue
      /** 稳定选择字典序最小 ID 为保留条目。 */
      const sorted = [...group].sort((left, right) => left.id.localeCompare(right.id))
      let canonical = sorted[0]
      if (!canonical) continue
      /** 合并同正文时保留各文档的证据；超过读取预算则保持独立，不能丢引用。 */
      const evidence = [...new Map(sorted.flatMap((entry) => entry.evidence ?? [])
        .map((reference) => [`${reference.entryId}:${reference.revision}:${reference.quote}`, reference])).values()]
      if (evidence.length > 8) continue
      /** 本组操作前的条目版本。 */
      const before = sorted.map((entry) => ({ entryId: entry.id, revision: entry.revision }))
      if (evidence.length > 0 && JSON.stringify(evidence) !== JSON.stringify(canonical.evidence)) {
        canonical = withNewRevision({ ...canonical, evidence, updatedAt: dependencies.now() })
        entries.set(canonical.id, canonical)
        commits.push({ entry: canonical, content: contents.get(canonical.id) ?? '' })
      }
      /** 本组操作后的条目版本。 */
      const after = [{ entryId: canonical.id, revision: canonical.revision }]
      /** 本组操作新增的重定向。 */
      const redirectsAfter: Record<string, string[]> = {}
      for (const duplicate of sorted.slice(1)) {
        /** 被合并条目的归档版本。 */
        const archived = withNewRevision({
          ...duplicate,
          state: 'archived',
          updatedAt: dependencies.now(),
        })
        entries.set(duplicate.id, archived)
        commits.push({ entry: archived, content: contents.get(duplicate.id) ?? '' })
        redirects[duplicate.id] = [canonical.id]
        redirectsAfter[duplicate.id] = [canonical.id]
        after.push({ entryId: duplicate.id, revision: archived.revision })
      }
      operations.push(createOperation({
        kind: 'merge',
        summary: `合并 ${sorted.length} 条完全重复的受管资料`,
        entryIds: sorted.map((entry) => entry.id),
        undoable: true,
        before,
        after,
        redirectsBefore: {},
        redirectsAfter,
      }, dependencies.now()))
    }

    for (const entry of [...entries.values()]) {
      if (!isManagedEntry(entry) || entry.state !== 'confirmed' || redirects[entry.id]) continue
      /** 当前可拆分正文。 */
      const content = contents.get(entry.id)
      if (content === undefined) continue
      /** 正文中的独立 H2 章节。 */
      const sections = extractH2Sections(content)
      const shouldSplit = sections.length >= 3
        || (Buffer.byteLength(content, 'utf8') > LONG_DOCUMENT_BYTES && sections.length >= 2)
      if (!shouldSplit) continue
      /** 拆分产生的子条目提交。 */
      const childCommits = sections.map((section, index): KnowledgeEntryCommit => {
        /** 稳定子条目 ID。 */
        const id = createSplitEntryId(entry.id, section.heading, index)
        /** 子条目受管正文。 */
        const childContent = `# ${section.heading}\n\n${section.content.replace(/^##\s+.+$/m, '').trim()}`.trim()
        /** 不含 revision 的子条目。 */
        const childBase: Omit<KnowledgeEntry, 'revision'> = {
          ...entry,
          id,
          title: section.heading,
          summary: `${entry.title}：${section.heading}`,
          source: {
            kind: 'managed',
            id: `managed:split:${entry.id}:${index}`,
            revision: createHash('sha256').update(childContent).digest('hex'),
          },
          byteSize: Buffer.byteLength(childContent, 'utf8'),
          indexedBytes: Buffer.byteLength(childContent, 'utf8'),
          truncated: false,
          updatedAt: dependencies.now(),
        }
        /** 完整子条目。 */
        const child = withNewRevision(childBase)
        entries.set(child.id, child)
        contents.set(child.id, childContent)
        return { entry: child, content: childContent }
      })
      /** 被拆分父条目的归档版本。 */
      const archivedParent = withNewRevision({ ...entry, state: 'archived', updatedAt: dependencies.now() })
      entries.set(entry.id, archivedParent)
      commits.push({ entry: archivedParent, content }, ...childCommits)
      /** 全部子条目 ID。 */
      const childIds = childCommits.map((commit) => commit.entry.id)
      redirects[entry.id] = childIds
      operations.push(createOperation({
        kind: 'split',
        summary: `将「${entry.title}」拆分为 ${childIds.length} 个章节`,
        entryIds: [entry.id, ...childIds],
        undoable: true,
        before: [
          { entryId: entry.id, revision: entry.revision },
          ...childIds.map((entryId) => ({ entryId, revision: null })),
        ],
        after: [
          { entryId: entry.id, revision: archivedParent.revision },
          ...childCommits.map((commit) => ({ entryId: commit.entry.id, revision: commit.entry.revision })),
        ],
        redirectsBefore: {},
        redirectsAfter: { [entry.id]: childIds },
      }, dependencies.now()))
    }

    if (commits.length === 0 && operations.length === 0) return {}
    return {
      commits,
      redirects,
      operations: appendOperations(current.manifest.operations, operations),
    }
  })
}

/** 审核草稿候选并持久化拒绝来源。 */
export async function reviewManagedKnowledge(
  dependencies: KnowledgeOrganizerDependencies,
  input: KnowledgeReviewInput,
): Promise<KnowledgeManifest> {
  return dependencies.store.transact(dependencies.project, dependencies.workspaceId, (current) => {
    /** 当前待审核条目。 */
    const entry = current.entries.find((candidate) => candidate.id === input.entryId)
    if (!entry) throw new Error('待审核知识条目不存在')
    if (entry.document) throw new Error('正式知识文件请通过当前大纲维护')
    if (entry.revision !== input.expectedRevision) throw new Error('知识审核版本冲突')
    if (input.action === 'confirm' && (!isManagedEntry(entry) || entry.state !== 'draft')) {
      throw new Error('只有受管草稿可以确认')
    }
    /** 受管候选的不可变正文；外部来源拒绝时不读取或改写正文。 */
    const content = isManagedEntry(entry)
      ? dependencies.store.readContent(dependencies.project, current.manifest, entry.id)
      : null
    if (isManagedEntry(entry) && content === null) throw new Error('待审核知识正文缺失')
    /** 受管审核后的条目；外部拒绝保持原版本。 */
    const reviewed = isManagedEntry(entry)
      ? withNewRevision({
        ...entry,
        state: input.action === 'confirm' ? 'confirmed' : 'archived',
        updatedAt: dependencies.now(),
      })
      : entry
    /** 审核操作。 */
    const operation = createOperation({
      kind: input.action,
      summary: input.action === 'confirm' ? `确认「${entry.title}」` : `拒绝「${entry.title}」`,
      entryIds: [entry.id],
      undoable: false,
      before: [{ entryId: entry.id, revision: entry.revision }],
      after: [{ entryId: entry.id, revision: reviewed.revision }],
      redirectsBefore: {},
      redirectsAfter: {},
    }, dependencies.now())
    /** 拒绝来源并集。 */
    const excludedSources = input.action === 'reject'
      ? [...new Set([...(current.manifest.excludedSources ?? []), entry.source.id])]
      : current.manifest.excludedSources
    return {
      commits: isManagedEntry(entry) && content !== null ? [{ entry: reviewed, content }] : [],
      operations: appendOperations(current.manifest.operations, [operation]),
      excludedSources,
    }
  })
}

/** 在操作后条目仍匹配时，通过新 revision 撤销整理。 */
export async function undoManagedKnowledge(
  dependencies: KnowledgeOrganizerDependencies,
  operationId: string,
): Promise<KnowledgeManifest> {
  return dependencies.store.transact(dependencies.project, dependencies.workspaceId, (current) => {
    /** 待撤销的完整操作。 */
    const operation = current.manifest.operations?.find((candidate) => candidate.id === operationId)
    if (!operation || !operation.undoable) throw new Error('知识整理操作不可撤销')
    for (const version of operation.after) {
      if (version.revision !== null && current.manifest.entries[version.entryId] !== version.revision) {
        throw new Error('整理撤销冲突：条目已被后续修改')
      }
    }
    /** 撤销产生的新条目提交。 */
    const commits: KnowledgeEntryCommit[] = []
    for (const before of operation.before) {
      if (before.revision === null) {
        /** 操作新建的子条目在撤销时创建归档版本。 */
        const currentEntry = current.entries.find((entry) => entry.id === before.entryId)
        if (!currentEntry) continue
        /** 当前子条目正文。 */
        const currentContent = dependencies.store.readContent(dependencies.project, current.manifest, before.entryId)
        if (currentContent === null) continue
        /** 撤销后的归档子条目。 */
        const archived = withNewRevision({ ...currentEntry, state: 'archived', updatedAt: dependencies.now() })
        commits.push({ entry: archived, content: currentContent })
        continue
      }
      /** 指向操作前版本的临时固定清单。 */
      const historicalManifest: KnowledgeManifest = {
        ...current.manifest,
        entries: { ...current.manifest.entries, [before.entryId]: before.revision },
      }
      /** 操作前条目元数据。 */
      const historicalEntry = dependencies.store.readEntry(dependencies.project, historicalManifest, before.entryId)
      /** 操作前受管正文。 */
      const historicalContent = dependencies.store.readContent(dependencies.project, historicalManifest, before.entryId)
      if (historicalContent === null) throw new Error('整理撤销历史正文不可用')
      /** 以新 revision 恢复操作前语义。 */
      const restored = withNewRevision({ ...historicalEntry, updatedAt: dependencies.now() })
      commits.push({ entry: restored, content: historicalContent })
    }
    /** 恢复操作前重定向。 */
    const redirects = { ...(current.manifest.redirects ?? {}) }
    /** 本操作涉及的全部重定向键。 */
    const redirectKeys = new Set([
      ...Object.keys(operation.redirectsBefore),
      ...Object.keys(operation.redirectsAfter),
    ])
    for (const key of redirectKeys) {
      const targets = operation.redirectsBefore[key]
      if (targets) redirects[key] = targets
      else delete redirects[key]
    }
    /** 撤销后的版本基线。 */
    const after = commits.map((commit) => ({ entryId: commit.entry.id, revision: commit.entry.revision }))
    /** 将原操作标记为不可再次撤销。 */
    const previousOperations = (current.manifest.operations ?? []).map((candidate) => (
      candidate.id === operation.id ? { ...candidate, undoable: false } : candidate
    ))
    /** 新的撤销操作。 */
    const undoOperation = createOperation({
      kind: 'undo',
      summary: `撤销：${operation.summary}`,
      entryIds: operation.entryIds,
      undoable: false,
      before: operation.after,
      after,
      redirectsBefore: operation.redirectsAfter,
      redirectsAfter: operation.redirectsBefore,
      undoOf: operation.id,
    }, dependencies.now())
    return {
      commits,
      redirects,
      operations: appendOperations(previousOperations, [undoOperation]),
    }
  })
}
