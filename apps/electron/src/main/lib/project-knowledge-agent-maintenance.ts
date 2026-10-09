import { createHash } from 'node:crypto'
import type {
  KnowledgeAssetCopyInput,
  KnowledgeAssetCopyResult,
  KnowledgeCategory,
  KnowledgeDocumentWriteInput,
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeOutlineInput,
  KnowledgePlanProposalInput,
  KnowledgeReadInput,
  KnowledgeReadResult,
  KnowledgeSnapshot,
  KnowledgeWorkflow,
} from '@proma/shared'
import type { PersistedAgentEvidenceRecord } from './agent-session-manager'
import { emptyKnowledgeMaintenance } from './project-knowledge-maintenance-types'
import {
  createSourceDistillationBatches,
  isSourceDistillationCandidate,
  sourceRefIdentity,
  validateSourceDistillationCandidates,
} from './project-knowledge-source-distillation'
import type { KnowledgeSourceCandidate, KnowledgeSourceMaterial, KnowledgeSourceRef } from './project-knowledge-source-distillation'
import { containsKnowledgeSecret } from './project-knowledge/sensitive-text'
import type { KnowledgeEntryCommit, ProjectKnowledgeStore, ResolvedKnowledgeProject } from './project-knowledge/types'

/** 当前用户消息中由 Agent 提交的长期知识候选。 */
export interface KnowledgeConversationCandidate {
  title: string
  content: string
  category: KnowledgeCategory
  kind: Exclude<KnowledgeKind, 'document' | 'asset'>
  quote: string
  replacesEntryId?: string
}

/** Agent 一次受控提交，可同时处理来源资料和当前用户声明。 */
export interface KnowledgeAgentMaintenanceSubmitInput {
  processedSourceRefs?: Array<{ entryId: string; revision: string }>
  candidates?: KnowledgeSourceCandidate[]
  conversationCandidates?: KnowledgeConversationCandidate[]
}

/** 提交结果不暴露清单内部路径。 */
export interface KnowledgeAgentMaintenanceSubmitResult {
  status: 'published' | 'unchanged'
  published: number
  refreshed: number
  skipped: number
  processedSources: number
  entryIds: string[]
}

/** 当前 Agent 回合固定的权限、来源读取和写事务边界。 */
export interface ProjectKnowledgeAgentMaintenanceOptions {
  workspaceId: string
  sessionId: string
  userMessageId: string
  store: ProjectKnowledgeStore
  resolveProject(workspaceId: string): ResolvedKnowledgeProject
  readSource(input: KnowledgeReadInput): Promise<KnowledgeReadResult>
  readUserEvidence(): PersistedAgentEvidenceRecord | undefined
  assertCurrent(): void
  canMutate(): boolean
  runWorkspaceWrite<T>(effect: () => Promise<T>): Promise<T>
  /** 新版两步流程端口；缺省时只为旧测试与历史调用保留兼容行为。 */
  workflow?: ProjectKnowledgeAgentWorkflowPorts
  now?: () => number
}

/** 核心服务拥有的流程事务，Agent 侧只补当前工作区和本轮证据。 */
export interface ProjectKnowledgeAgentWorkflowPorts {
  getSnapshot(workspaceId: string): Promise<KnowledgeSnapshot>
  proposePlan(input: KnowledgePlanProposalInput): Promise<KnowledgeSnapshot>
  saveOutline(input: KnowledgeOutlineInput): Promise<KnowledgeSnapshot>
  writeDocument(input: KnowledgeDocumentWriteInput): Promise<KnowledgeSnapshot>
  copyAsset(input: KnowledgeAssetCopyInput): Promise<KnowledgeAssetCopyResult>
}

/** 模型输入不包含由当前回合闭包固定的工作区身份。 */
export type KnowledgeAgentPlanInput = Omit<KnowledgePlanProposalInput, 'workspaceId'>
/** 模型输入不包含由当前回合闭包固定的工作区身份。 */
export type KnowledgeAgentOutlineInput = Omit<KnowledgeOutlineInput, 'workspaceId'>
/** 模型输入不包含由当前回合闭包固定的工作区身份。 */
export type KnowledgeAgentDocumentInput = Omit<KnowledgeDocumentWriteInput, 'workspaceId' | 'userEvidence'>
/** 模型输入不包含由当前回合闭包固定的工作区身份。 */
export type KnowledgeAgentAssetInput = Omit<KnowledgeAssetCopyInput, 'workspaceId'>

/** Agent 可分页读取的紧凑流程状态，避免大计划挤掉全部上下文。 */
export interface KnowledgeAgentWorkflowStatus {
  initialized: boolean
  revision: number
  paused: boolean
  proposal?: {
    id: string
    revision: number
    title: string
    groupCount: number
    groups: Array<{ id: string; title: string; summary: string; sourceCount: number; gapCount: number; outputCount: number }>
  }
  approved?: {
    id: string
    revision: number
    title: string
    groupCount: number
    groups: Array<{ id: string; title: string; summary: string; sourceCount: number; gapCount: number; outputCount: number }>
  }
  outline?: {
    revision: number
    planRevision: number
    relativePath: string
    itemCount: number
    statusCounts: Record<'pending' | 'partial' | 'ready' | 'missing', number>
    items: Array<{
      id: string
      groupId: string
      title: string
      relativePath: string
      summary: string
      sections: string[]
      entryId?: string
      status: 'pending' | 'partial' | 'ready' | 'missing'
    }>
  }
  offset: number
  nextOffset?: number
}

/** 单页同时切分分组和大纲项，调用方沿 nextOffset 继续读取。 */
export function compactKnowledgeWorkflowStatus(
  snapshot: Pick<KnowledgeSnapshot, 'initialized' | 'revision' | 'workflow'>,
  offset = 0,
): KnowledgeAgentWorkflowStatus {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('知识流程状态偏移非法')
  const pageSize = 4
  const workflow: KnowledgeWorkflow | undefined = snapshot.workflow
  /** 文本压缩只用于 Agent 状态，不改变权威清单。 */
  const brief = (value: string, maximum: number): string => value.length <= maximum ? value : `${value.slice(0, maximum)}…`
  const plan = (value: KnowledgeWorkflow['proposal']) => value ? {
    id: value.id, revision: value.revision, title: brief(value.title, 160), groupCount: value.groups.length,
    groups: value.groups.slice(offset, offset + pageSize).map((group) => ({
      id: group.id, title: brief(group.title, 160), summary: brief(group.summary, 320),
      sourceCount: group.sources.length, gapCount: group.gaps.length, outputCount: group.outputs.length,
    })),
  } : undefined
  const statusCounts = { pending: 0, partial: 0, ready: 0, missing: 0 }
  for (const item of workflow?.outline?.items ?? []) statusCounts[item.status] += 1
  const maximumLength = Math.max(
    workflow?.proposal?.groups.length ?? 0,
    workflow?.approved?.groups.length ?? 0,
    workflow?.outline?.items.length ?? 0,
  )
  return {
    initialized: snapshot.initialized,
    revision: snapshot.revision,
    paused: workflow?.paused ?? false,
    proposal: plan(workflow?.proposal),
    approved: plan(workflow?.approved),
    outline: workflow?.outline ? {
      revision: workflow.outline.revision,
      planRevision: workflow.outline.planRevision,
      relativePath: workflow.outline.relativePath,
      itemCount: workflow.outline.items.length,
      statusCounts,
      items: workflow.outline.items.slice(offset, offset + pageSize).map((item) => ({
        ...item,
        title: brief(item.title, 160),
        summary: brief(item.summary, 320),
        sections: item.sections.slice(0, 8).map((section) => brief(section, 160)),
      })),
    } : undefined,
    offset,
    nextOffset: offset + pageSize < maximumLength ? offset + pageSize : undefined,
  }
}

/** 当前 Agent 可见的最小维护能力。 */
export interface ProjectKnowledgeAgentMaintenance {
  next(): Promise<{ refs: KnowledgeSourceRef[]; remaining: number }>
  observeRead(result: KnowledgeReadResult): void
  submit(input: KnowledgeAgentMaintenanceSubmitInput): Promise<KnowledgeAgentMaintenanceSubmitResult>
  /** 读取最新 proposal、approved 版本和大纲进度。 */
  status?: (offset?: number) => Promise<KnowledgeAgentWorkflowStatus>
  /** 提交等待用户确认的自由分组清单。 */
  proposePlan?: (input: KnowledgeAgentPlanInput) => Promise<KnowledgeAgentWorkflowStatus>
  /** 只在核心服务确认存在 approved 版本后保存大纲。 */
  saveOutline?: (input: KnowledgeAgentOutlineInput) => Promise<KnowledgeAgentWorkflowStatus>
  /** 用本轮真实来源页或当前用户原话发布大纲项正文。 */
  writeDocument?: (input: KnowledgeAgentDocumentInput) => Promise<KnowledgeAgentWorkflowStatus>
  /** 复制扫描登记的原格式资产，并返回正文可用的相对链接。 */
  copyAsset?: (input: KnowledgeAgentAssetInput) => Promise<KnowledgeAssetCopyResult>
}

/** 本轮实际读取的一页来源正文。 */
interface ObservedSourcePage {
  ref: KnowledgeSourceRef
  offset: number
  content: string
  truncated: boolean
}

/** 标准化正文用于完全重复判断。 */
function normalizeContent(content: string): string {
  return content.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

/** 生成不可变知识条目版本。 */
function entryRevision(entry: Omit<KnowledgeEntry, 'revision'>, content: string): string {
  return createHash('sha256').update(JSON.stringify(entry) + content).digest('hex')
}

/** 当前链路与旧后台链路对同一用户引文使用的稳定来源身份。 */
function conversationSourceIds(workspaceId: string, sessionId: string, messageId: string, quote: string): [string, string] {
  const normalizedQuote = normalizeContent(quote)
  const current = createHash('sha256').update(`${workspaceId}\0${sessionId}\0${messageId}\0${normalizedQuote}`).digest('hex')
  const legacyTurn = createHash('sha256').update(`${workspaceId}\0${sessionId}\0${messageId}`).digest('hex')
  const legacy = createHash('sha256').update(`${legacyTurn}\0${messageId}\0${normalizedQuote}`).digest('hex')
  return [current, legacy]
}

/** 判断已有提炼知识的文档依据是否仍指向当前版本。 */
function hasCurrentEvidence(entry: KnowledgeEntry, entries: Record<string, string>): boolean {
  return !entry.evidence?.length || entry.evidence.every((item) => entries[item.entryId] === item.revision)
}

/** 验证当前用户候选的结构和逐字引文。 */
function validateConversationCandidates(
  values: readonly KnowledgeConversationCandidate[],
  evidence: PersistedAgentEvidenceRecord | undefined,
  userMessageId: string,
): KnowledgeConversationCandidate[] {
  if (values.length > 6) throw new Error('当前对话候选过多')
  if (values.length && (!evidence || evidence.uuid !== userMessageId || evidence.role !== 'user')) throw new Error('当前用户证据不可用')
  const categories = new Set(['overview', 'planning', 'business', 'engineering', 'design', 'guides', 'decisions'])
  const kinds = new Set(['fact', 'decision', 'experience', 'preference', 'rule'])
  return values.map((candidate) => {
    if (!candidate || typeof candidate.title !== 'string' || !candidate.title.trim() || candidate.title.length > 160
      || typeof candidate.content !== 'string' || !candidate.content.trim() || candidate.content.length > 5000
      || typeof candidate.quote !== 'string' || !candidate.quote.trim() || candidate.quote.length > 5000) {
      throw new Error('当前对话候选字段无效')
    }
    if (!categories.has(candidate.category) || !kinds.has(candidate.kind)) throw new Error('当前对话候选分类无效')
    if (!evidence?.text.includes(candidate.quote)) throw new Error('当前对话候选引用不属于用户原文')
    if (candidate.replacesEntryId !== undefined && !/^[a-f0-9]{32}$/.test(candidate.replacesEntryId)) throw new Error('替代引用无效')
    if (containsKnowledgeSecret(`${candidate.title}\n${candidate.content}\n${candidate.quote}`)) throw new Error('当前对话候选含敏感内容')
    return candidate
  })
}

/** 构造只允许当前普通 Agent 回合使用的受控知识维护器。 */
export function createProjectKnowledgeAgentMaintenance(
  options: ProjectKnowledgeAgentMaintenanceOptions,
): ProjectKnowledgeAgentMaintenance {
  const now = options.now ?? Date.now
  /** 本轮实际读取的来源页，键为固定条目版本。 */
  const observed = new Map<string, Map<number, ObservedSourcePage>>()
  /** 本轮累计处理的来源身份，重复工具调用仍受四个来源上限约束。 */
  const processedThisRun = new Set<string>()

  /** 统一复核运行身份和写权限。 */
  const assertMutable = (): void => {
    options.assertCurrent()
    if (!options.canMutate()) throw new Error('当前模式没有项目知识写入权限')
  }

  /** 在同一工作区写租约内执行新版流程变更。 */
  const runWorkflowWrite = async <T>(
    operation: (workflow: ProjectKnowledgeAgentWorkflowPorts) => Promise<T>,
  ): Promise<T> => {
    const workflow = options.workflow
    if (!workflow) throw new Error('当前运行未启用知识库两步流程')
    assertMutable()
    return options.runWorkspaceWrite(async () => {
      assertMutable()
      return operation(workflow)
    })
  }

  /** 获取尚未处理的最高优先级小批来源，不读取正文。 */
  const next = async (): Promise<{ refs: KnowledgeSourceRef[]; remaining: number }> => {
    options.assertCurrent()
    const project = options.resolveProject(options.workspaceId)
    const manifest = options.store.readManifest(project)
    if (!manifest) return { refs: [], remaining: 0 }
    const completed = new Set(manifest.maintenance?.completedSources ?? [])
    const batches = createSourceDistillationBatches(options.store.readEntries(project, manifest))
    const pendingBatches = batches.map((batch) => batch.refs.filter((ref) => !completed.has(sourceRefIdentity(ref))))
      .filter((refs) => refs.length > 0)
    const remaining = pendingBatches.reduce((count, refs) => count + refs.length, 0)
    const selected = pendingBatches[0] ?? []
    options.assertCurrent()
    return { refs: selected, remaining }
  }

  /** 记录 Agent 通过正式读取工具看到的来源页。 */
  const observeRead = (result: KnowledgeReadResult): void => {
    options.assertCurrent()
    if (result.status !== 'readable' || (!isSourceDistillationCandidate(result.entry)
      && result.entry.source.kind !== 'managed' && result.entry.source.kind !== 'conversation')) return
    const ref: KnowledgeSourceRef = {
      entryId: result.entry.id,
      revision: result.entry.revision,
      category: result.entry.category,
      title: result.entry.title,
    }
    const key = `${ref.entryId}:${ref.revision}`
    const pages = observed.get(key) ?? new Map<number, ObservedSourcePage>()
    pages.set(result.offset, { ref, offset: result.offset, content: result.content, truncated: result.truncated })
    observed.set(key, pages)
  }

  /** 发布本轮已核验候选并推进实际读过的来源水位。 */
  const submit = async (input: KnowledgeAgentMaintenanceSubmitInput): Promise<KnowledgeAgentMaintenanceSubmitResult> => {
    if (options.workflow) throw new Error('知识库已启用两步流程，旧提交入口不可用')
    assertMutable()
    const processedRefs = input.processedSourceRefs ?? []
    const sourceCandidatesInput = input.candidates ?? []
    const conversationInput = input.conversationCandidates ?? []
    if (processedRefs.length > 4) throw new Error('单次处理来源过多')
    if (!processedRefs.length && !conversationInput.length) throw new Error('没有可提交的知识维护内容')
    const uniqueRefs = new Map(processedRefs.map((ref) => [`${ref.entryId}:${ref.revision}`, ref]))
    if (uniqueRefs.size !== processedRefs.length) throw new Error('处理来源重复')
    const nextRunSources = new Set([...processedThisRun, ...uniqueRefs.keys()])
    if (nextRunSources.size > 4) throw new Error('本回合处理来源已达到上限')
    /** 在读取账本判断前先明确报告清单版本错误。 */
    const initialProject = options.resolveProject(options.workspaceId)
    const initialManifest = options.store.readManifest(initialProject)
    for (const ref of processedRefs) {
      if (initialManifest?.entries[ref.entryId] !== ref.revision) throw new Error('提交来源版本已变化')
    }
    /** 每个处理来源必须至少实际读取过第一页。 */
    for (const ref of processedRefs) {
      const pages = observed.get(`${ref.entryId}:${ref.revision}`)
      if (!pages?.has(0)) throw new Error('提交来源尚未通过知识读取工具读取')
    }
    /** 候选不得引用本次未声明处理的来源。 */
    for (const candidate of sourceCandidatesInput) for (const evidence of candidate.evidence ?? []) {
      if (!uniqueRefs.has(`${evidence.entryId}:${evidence.revision}`)) throw new Error('候选引用版本不属于本次处理来源')
    }
    const conversationEvidence = options.readUserEvidence()
    const conversationCandidates = validateConversationCandidates(conversationInput, conversationEvidence, options.userMessageId)

    return options.runWorkspaceWrite(async () => {
      assertMutable()
      const project = options.resolveProject(options.workspaceId)
      let manifestBefore = options.store.readManifest(project)
      /** 当前对话知识可独立创建空知识库；来源提炼仍要求先由扫描建立来源索引。 */
      if (!manifestBefore && conversationCandidates.length && !processedRefs.length) {
        manifestBefore = await options.store.initialize(project, options.workspaceId)
      }
      if (!manifestBefore) throw new Error('项目知识库尚未初始化')
      /** fresh-read 本轮观察过的每一页，拒绝迟到版本或内容变化。 */
      const materials: KnowledgeSourceMaterial[] = []
      for (const ref of processedRefs) {
        const pages = observed.get(`${ref.entryId}:${ref.revision}`)!
        for (const page of [...pages.values()].sort((left, right) => left.offset - right.offset)) {
          const fresh = await options.readSource({
            workspaceId: options.workspaceId,
            entryId: ref.entryId,
            expectedRevision: ref.revision,
            offset: page.offset,
          })
          options.assertCurrent()
          if (fresh.status !== 'readable' || fresh.entry.id !== ref.entryId || fresh.entry.revision !== ref.revision
            || fresh.offset !== page.offset || fresh.content !== page.content) throw new Error('来源版本或正文已变化')
          materials.push({ ref: page.ref, content: page.content, truncated: page.truncated || fresh.truncated })
        }
      }
      const sourceCandidates = validateSourceDistillationCandidates(sourceCandidatesInput, materials)
      let published = 0
      let refreshed = 0
      let skipped = 0
      let entryIds: string[] = []
      await options.store.transact(project, options.workspaceId, ({ manifest, entries }) => {
        assertMutable()
        /** 写入点再次读取真实消息，拒绝租约等待期间发生的删除、回退或改写。 */
        const currentConversationEvidence = conversationCandidates.length ? options.readUserEvidence() : undefined
        if (conversationCandidates.length && (!conversationEvidence || !currentConversationEvidence
          || currentConversationEvidence.uuid !== conversationEvidence.uuid
          || currentConversationEvidence.role !== conversationEvidence.role
          || currentConversationEvidence.sha256 !== conversationEvidence.sha256
          || currentConversationEvidence.text !== conversationEvidence.text)) {
          throw new Error('当前用户证据已变化')
        }
        for (const ref of processedRefs) {
          if (manifest.entries[ref.entryId] !== ref.revision) throw new Error('来源版本已变化')
          const entry = entries.find((candidate) => candidate.id === ref.entryId)
          if (!entry || !isSourceDistillationCandidate(entry)) throw new Error('来源版本不可用于提炼')
        }
        const maintenance = structuredClone(manifest.maintenance ?? emptyKnowledgeMaintenance())
        if (conversationCandidates.length && maintenance.excludedSessions.includes(options.sessionId)) {
          throw new Error('当前会话已从知识维护中排除')
        }
        const commits: KnowledgeEntryCommit[] = []
        const known = new Set<string>()
        for (const entry of entries) {
          if (entry.source.kind !== 'managed' && entry.source.kind !== 'conversation') continue
          const content = options.store.readContent(project, manifest, entry.id)
          if (content && hasCurrentEvidence(entry, manifest.entries)) known.add(normalizeContent(content))
        }
        const seenAnchors = new Set<string>()
        for (const candidate of sourceCandidates) {
          const content = candidate.content.trim()
          const normalized = normalizeContent(content)
          const anchors = candidate.evidence.map((item) => ({ entryId: item.entryId, quote: normalizeContent(item.quote) }))
            .sort((left, right) => left.entryId.localeCompare(right.entryId) || left.quote.localeCompare(right.quote))
          const sourceId = createHash('sha256').update(JSON.stringify(anchors)).digest('hex')
          if (seenAnchors.has(sourceId) || manifest.excludedSources?.includes(sourceId)) { skipped += 1; continue }
          seenAnchors.add(sourceId)
          const evidenceTruncated = candidate.evidence.some((evidence) => materials.some((material) => material.ref.entryId === evidence.entryId
            && material.ref.revision === evidence.revision && material.truncated))
          const anchored = entries.find((entry) => entry.source.kind === 'managed' && entry.source.id === sourceId
            && (entry.state === 'draft' || entry.state === 'confirmed'))
          const staleSameContent = entries.find((entry) => {
            if (entry.source.kind !== 'managed' || (entry.state !== 'draft' && entry.state !== 'confirmed')
              || hasCurrentEvidence(entry, manifest.entries)) return false
            const existing = options.store.readContent(project, manifest, entry.id)
            return existing !== null && normalizeContent(existing) === normalized
          })
          const refreshTarget = anchored ?? staleSameContent
          if (refreshTarget && !hasCurrentEvidence(refreshTarget, manifest.entries)) {
            const existing = options.store.readContent(project, manifest, refreshTarget.id)
            if (existing !== null && normalizeContent(existing) === normalized) {
              const base: Omit<KnowledgeEntry, 'revision'> = {
                ...refreshTarget,
                freshness: 'current',
                source: { kind: 'managed', id: sourceId, revision: createHash('sha256').update(JSON.stringify(processedRefs)).digest('hex') },
                evidence: candidate.evidence,
                truncated: evidenceTruncated,
                updatedAt: now(),
              }
              commits.push({ entry: { ...base, revision: entryRevision(base, existing) }, content: existing })
              known.add(normalizeContent(existing)); refreshed += 1
              continue
            }
          }
          if (refreshTarget || known.has(normalized)) { skipped += 1; continue }
          known.add(normalized)
          const conflict = entries.some((entry) => entry.title === candidate.title && entry.state === 'confirmed')
          const base: Omit<KnowledgeEntry, 'revision'> = {
            id: sourceId.slice(0, 32), title: candidate.title, category: candidate.category, kind: candidate.kind,
            state: 'draft', freshness: 'current',
            summary: `${conflict ? '待核对：与已有同主题知识不同。' : ''}${content.slice(0, 320)}`,
            source: { kind: 'managed', id: sourceId, revision: createHash('sha256').update(JSON.stringify(processedRefs)).digest('hex') },
            evidence: candidate.evidence, byteSize: Buffer.byteLength(content), indexedBytes: Buffer.byteLength(content),
            truncated: evidenceTruncated, metadataOnly: false, updatedAt: now(),
          }
          commits.push({ entry: { ...base, revision: entryRevision(base, content) }, content }); published += 1
        }
        const seenConversationAnchors = new Set<string>()
        for (const candidate of conversationCandidates) {
          const evidence = currentConversationEvidence!
          const explicit = evidence.text.trim() === candidate.quote.trim()
            && /^(?:决定|确定|约定|记住|请记住|更正|纠正)[：:]/u.test(evidence.text.trim())
          const content = explicit ? candidate.quote.trim() : candidate.content.trim()
          const normalized = normalizeContent(content)
          const [sourceId, legacySourceId] = conversationSourceIds(
            options.workspaceId, options.sessionId, options.userMessageId, candidate.quote,
          )
          const anchored = entries.some((entry) => entry.source.kind === 'conversation'
            && (entry.source.id === sourceId || entry.source.id === legacySourceId))
          if (seenConversationAnchors.has(sourceId) || anchored || known.has(normalized)
            || manifest.excludedSources?.includes(sourceId) || manifest.excludedSources?.includes(legacySourceId)) {
            skipped += 1
            continue
          }
          seenConversationAnchors.add(sourceId)
          const old = candidate.replacesEntryId ? entries.find((entry) => entry.id === candidate.replacesEntryId) : undefined
          const canReplace = explicit && /^(?:更正|纠正)[：:]/u.test(evidence.text.trim()) && old
            && evidence.text.includes(old.title) && manifestBefore.entries[old.id] === old.revision
            && manifest.entries[old.id] === old.revision
            && (old.source.kind === 'conversation' || old.source.kind === 'managed')
          const conflict = entries.some((entry) => entry.title === candidate.title && entry.state === 'confirmed') && !canReplace
          const base: Omit<KnowledgeEntry, 'revision'> = {
            id: sourceId.slice(0, 32), title: candidate.title, category: candidate.category, kind: candidate.kind,
            state: explicit && !conflict ? 'confirmed' : 'draft', freshness: 'current',
            summary: `${conflict ? '待核对：与已有同主题知识不同。' : ''}${content.slice(0, 320)}`,
            source: { kind: 'conversation', id: sourceId, sessionId: options.sessionId, messageIds: [evidence.uuid], revision: evidence.sha256 },
            byteSize: Buffer.byteLength(content), indexedBytes: Buffer.byteLength(content), truncated: false, metadataOnly: false, updatedAt: now(),
          }
          commits.push({ entry: { ...base, revision: entryRevision(base, content) }, content }); published += 1; known.add(normalized)
          if (canReplace && old) {
            const oldContent = options.store.readContent(project, manifest, old.id)
            const supersededBase: Omit<KnowledgeEntry, 'revision'> = { ...old, state: 'superseded', updatedAt: now() }
            commits.push({ entry: { ...supersededBase, revision: entryRevision(supersededBase, oldContent ?? '') }, content: oldContent ?? undefined })
          }
        }
        let completedChanged = false
        for (const ref of processedRefs) {
          const identity = sourceRefIdentity(ref)
          if (!maintenance.completedSources.includes(identity)) {
            maintenance.completedSources.push(identity)
            completedChanged = true
          }
        }
        const uniqueCommits = [...new Map(commits.map((commit) => [commit.entry.id, commit])).values()]
        if (completedChanged || uniqueCommits.length) maintenance.lastProcessedAt = now()
        entryIds = uniqueCommits.map((commit) => commit.entry.id)
        const operation = {
          id: createHash('sha256').update(`${options.sessionId}\0${options.userMessageId}\0${now()}\0${entryIds.join('\0')}`).digest('hex').slice(0, 32),
          kind: 'extract' as const,
          summary: `由当前 Agent 提炼 ${published} 条知识并刷新 ${refreshed} 条依据`,
          entryIds,
          createdAt: now(),
          undoable: uniqueCommits.length > 0,
          before: uniqueCommits.map((commit) => ({ entryId: commit.entry.id, revision: manifest.entries[commit.entry.id] ?? null })),
          after: uniqueCommits.map((commit) => ({ entryId: commit.entry.id, revision: commit.entry.revision })),
          redirectsBefore: {}, redirectsAfter: {},
        }
        if (!completedChanged && !uniqueCommits.length) return {}
        return {
          commits: uniqueCommits,
          maintenance,
          operations: uniqueCommits.length ? [...(manifest.operations ?? []), operation] : manifest.operations,
        }
      })
      options.assertCurrent()
      for (const key of uniqueRefs.keys()) processedThisRun.add(key)
      return {
        status: published || refreshed ? 'published' : 'unchanged',
        published, refreshed, skipped,
        processedSources: processedRefs.length,
        entryIds,
      }
    })
  }

  if (!options.workflow) return { next, observeRead, submit }

  /** 读取最新流程状态时仍复核运行代次和工作区归属。 */
  const status = async (offset = 0): Promise<KnowledgeAgentWorkflowStatus> => {
    options.assertCurrent()
    const snapshot = await options.workflow!.getSnapshot(options.workspaceId)
    options.assertCurrent()
    return compactKnowledgeWorkflowStatus(snapshot, offset)
  }
  /** 提案只引用扫描元数据；发现来源不要求先读取正文。 */
  const proposePlan = async (input: KnowledgeAgentPlanInput): Promise<KnowledgeAgentWorkflowStatus> => compactKnowledgeWorkflowStatus(
    await runWorkflowWrite((workflow) => workflow.proposePlan({
      ...input,
      workspaceId: options.workspaceId,
      // 读取覆盖只来自本轮宿主观察，模型不能伪造“已读”。名称和路径由 core 补充。
      groups: input.groups.map((group) => ({ ...group, sources: group.sources.map((reference) => ({
        entryId: reference.entryId,
        revision: reference.revision,
        coverage: observed.get(`${reference.entryId}:${reference.revision}`)?.size ? 'read' as const : 'discovered' as const,
      })) })),
    })),
  )
  /** approved 版本与大纲版本的并发控制由核心事务最终裁决。 */
  const saveOutline = async (input: KnowledgeAgentOutlineInput): Promise<KnowledgeAgentWorkflowStatus> => compactKnowledgeWorkflowStatus(
    await runWorkflowWrite((workflow) => workflow.saveOutline({ ...input, workspaceId: options.workspaceId })),
  )
  /** 发布前复验本轮逐字证据，并在取得租约后重新读取真实来源。 */
  const writeDocument = async (input: KnowledgeAgentDocumentInput): Promise<KnowledgeAgentWorkflowStatus> => {
    assertMutable()
    if (!input.evidence.length && !input.userQuote?.trim()) throw new Error('文档必须包含来源证据或当前用户原话')
    const evidencePages = input.evidence.map((evidence) => {
      const pages = observed.get(`${evidence.entryId}:${evidence.revision}`)
      if (!pages?.size) throw new Error('文档来源尚未通过知识读取工具读取')
      const page = [...pages.values()].find((candidate) => candidate.content.includes(evidence.quote))
      if (!page) throw new Error('文档来源逐字引用不属于本轮已读页面')
      return { evidence, page }
    })
    const initialUserEvidence = input.userQuote ? options.readUserEvidence() : undefined
    if (input.userQuote && (!initialUserEvidence || initialUserEvidence.uuid !== options.userMessageId
      || initialUserEvidence.role !== 'user' || !initialUserEvidence.text.includes(input.userQuote))) {
      throw new Error('文档用户引用不属于当前用户原文')
    }
    const snapshot = await runWorkflowWrite(async (workflow) => {
      for (const { evidence, page } of evidencePages) {
        const fresh = await options.readSource({
          workspaceId: options.workspaceId,
          entryId: evidence.entryId,
          expectedRevision: evidence.revision,
          offset: page.offset,
        })
        options.assertCurrent()
        if (!options.canMutate()) throw new Error('当前模式没有项目知识写入权限')
        if (fresh.status !== 'readable' || fresh.entry.id !== evidence.entryId
          || fresh.entry.revision !== evidence.revision || fresh.offset !== page.offset
          || fresh.content !== page.content || !fresh.content.includes(evidence.quote)) {
          throw new Error('文档来源版本或正文已变化')
        }
      }
      if (input.userQuote) {
        const currentUserEvidence = options.readUserEvidence()
        if (!initialUserEvidence || !currentUserEvidence
          || currentUserEvidence.uuid !== initialUserEvidence.uuid
          || currentUserEvidence.role !== initialUserEvidence.role
          || currentUserEvidence.sha256 !== initialUserEvidence.sha256
          || currentUserEvidence.text !== initialUserEvidence.text
          || !currentUserEvidence.text.includes(input.userQuote)) {
          throw new Error('当前用户证据已变化')
        }
      }
      assertMutable()
      return workflow.writeDocument({
        ...input,
        workspaceId: options.workspaceId,
        ...(input.userQuote ? {
          userEvidence: { sessionId: options.sessionId, messageId: options.userMessageId, quote: input.userQuote },
        } : {}),
      })
    })
    return compactKnowledgeWorkflowStatus(snapshot)
  }
  /** 二进制内容不在 Agent 读取预算中展开，core 以 metadataOnly 来源和大纲范围核验。 */
  const copyAsset = (input: KnowledgeAgentAssetInput): Promise<KnowledgeAssetCopyResult> => runWorkflowWrite(
    (workflow) => workflow.copyAsset({ ...input, workspaceId: options.workspaceId }),
  )
  return { next, observeRead, submit, status, proposePlan, saveOutline, writeDocument, copyAsset }
}
