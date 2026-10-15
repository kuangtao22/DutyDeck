import { createHash } from 'node:crypto'
import { KnowledgeToolFailure } from './project-knowledge-references'
import type {
  KnowledgeAssetCopyInput,
  KnowledgeAssetCopyResult,
  KnowledgeCategory,
  KnowledgeDocumentWriteInput,
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeImportMode,
  KnowledgeOutlineInput,
  KnowledgePlanSource,
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
  /** 仅由宿主按任务登记身份重新核验原始用户消息，不查询任意历史。 */
  resolveTaskUserEvidence?(id: string): { sessionId: string; message: PersistedAgentEvidenceRecord } | undefined
  assertCurrent(): void
  canMutate(): boolean
  runWorkspaceWrite<T>(effect: () => Promise<T>): Promise<T>
  /** 新版两步流程端口；缺省时只为旧测试与历史调用保留兼容行为。 */
  workflow?: ProjectKnowledgeAgentWorkflowPorts
  now?: () => number
}

/** 来源发现回执仅返回计数和扫描状态，正文仍须正式读取。 */
export interface KnowledgeAgentScanResult {
  initialized: boolean
  scan: KnowledgeSnapshot['scan']
}
/** 导入回执保留有界跳过明细，不返回宿主绝对路径或整份文件列表。 */
export interface KnowledgeAgentImportResult {
  cancelled: boolean
  imported: number
  unchanged: number
  skippedCount: number
  skipped: Array<{ path: string; reason: string }>
  truncated: boolean
  rootRelativePath?: string
  scan?: KnowledgeSnapshot['scan']
}

/** 核心服务拥有的流程事务，Agent 侧只补当前工作区和本轮证据。 */
export interface ProjectKnowledgeAgentWorkflowPorts {
  /** 扫描当前项目并等待完成，信号只来自工具执行宿主。 */
  scanSources?(workspaceId: string, signal?: AbortSignal): Promise<KnowledgeAgentScanResult>
  /** 原生选择器决定路径，模型只能指定选择模式。 */
  importSources?(workspaceId: string, mode: KnowledgeImportMode, signal?: AbortSignal): Promise<KnowledgeAgentImportResult>
  getSnapshot(workspaceId: string): Promise<KnowledgeSnapshot>
  proposePlan(input: KnowledgePlanProposalInput): Promise<KnowledgeSnapshot>
  saveOutline(input: KnowledgeOutlineInput): Promise<KnowledgeSnapshot>
  writeDocument(input: KnowledgeDocumentWriteInput): Promise<KnowledgeSnapshot>
  copyAsset(input: KnowledgeAssetCopyInput): Promise<KnowledgeAssetCopyResult>
  /** 只刷新已登记来源，禁止扫描扩大授权范围。 */
  refreshSources?(workspaceId: string, sources: KnowledgePlanSource[]): Promise<KnowledgeEntry[]>
}

/** 模型输入不包含由当前回合闭包固定的工作区身份。 */
export type KnowledgeAgentPlanInput = Omit<KnowledgePlanProposalInput, 'workspaceId'>
/** 模型输入不包含由当前回合闭包固定的工作区身份。 */
export type KnowledgeAgentOutlineInput = Omit<KnowledgeOutlineInput, 'workspaceId'>
/** 模型输入不包含由当前回合闭包固定的工作区身份。 */
export type KnowledgeAgentDocumentInput = Omit<KnowledgeDocumentWriteInput, 'workspaceId' | 'userEvidence'> & { userEvidenceId?: string }
/** 模型输入不包含由当前回合闭包固定的工作区身份。 */
export type KnowledgeAgentAssetInput = Omit<KnowledgeAssetCopyInput, 'workspaceId'>

/** Agent 可分页读取的紧凑流程状态，避免大计划挤掉全部上下文。 */
export interface KnowledgeAgentWorkflowStatus {
  initialized: boolean
  revision: number
  paused: boolean
  /** 有界宿主执行摘要，不暴露全部历史读页。 */
  execution?: {
    status: string
    generation: number
    currentItemId?: string
    reason?: string
    turns: number
    calls: number
    bytes: number
    activeMs: number
    failures: Record<string, { code: string; message: string }>
    userEvidence: Array<{ id: string }>
  }
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
      /** 正文当前版本和宿主发放的精确目标引用。 */
      documentRevision?: string
      /** 状态只展示依赖摘要，完整大纲仍保留所有依赖。 */
      sourceCount?: number
      sourcesTruncated?: boolean
      targetRef?: string
      status: 'pending' | 'partial' | 'ready' | 'missing'
    }>
  }
  /** 已批准（或尚无批准时的提案）分组详情，供首轮建立大纲。 */
  groupDetails?: {
    groupId: string
    planState: 'approved' | 'proposal'
    planRevision: number
    summary: string
    sources: Array<KnowledgePlanSource & { sourceRef?: string }>
    gaps: string[]
    outputs: string[]
    sourceCount: number
    gapCount: number
    outputCount: number
    sourceOffset: number
    nextSourceOffset?: number
  }
  /** 指定单项的完整文本详情按四项分页，不将摘要截断伪装为完整依赖。 */
  itemDetails?: {
    itemId: string
    summary: string
    scope?: string
    dependencyState?: 'known' | 'unknown'
    sources: Array<KnowledgePlanSource & { sourceRef?: string }>
    sections: string[]
    gaps: string[]
    sourceCount: number
    sectionCount: number
    gapCount: number
    sourceOffset: number
    nextSourceOffset?: number
  }
  /** 当前所见批准计划和大纲的运行内引用。 */
  flowRef?: string
  offset: number
  nextOffset?: number
}

/** 单页同时切分分组和大纲项，调用方沿 nextOffset 继续读取。 */
export function compactKnowledgeWorkflowStatus(
  snapshot: Pick<KnowledgeSnapshot, 'initialized' | 'revision' | 'workflow'> & Partial<Pick<KnowledgeSnapshot, 'entries'>>,
  offset = 0,
  itemId?: string,
  sourceOffset = 0,
  groupId?: string,
): KnowledgeAgentWorkflowStatus {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('知识流程状态偏移非法')
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0) throw new Error('知识项详情偏移非法')
  if (itemId !== undefined && groupId !== undefined) throw new Error('单项与分组详情不能混用')
  const pageSize = 4
  const workflow: KnowledgeWorkflow | undefined = snapshot.workflow
  /** 详情仅允许当前批准大纲的明确项，不能按路径寻找未登记内容。 */
  const detailItem = itemId === undefined ? undefined : workflow?.outline?.items.find((item) => item.id === itemId)
  if (itemId !== undefined && !detailItem) throw new Error('知识大纲项不存在')
  const detailCount = detailItem ? Math.max(detailItem.sources?.length ?? 0, detailItem.sections.length, detailItem.gaps?.length ?? 0) : 0
  /** 先选已批准计划，避免同时存在新提案时混淆两套来源。 */
  const detailPlan = workflow?.approved ?? workflow?.proposal
  const detailGroup = groupId === undefined ? undefined : detailPlan?.groups.find((group) => group.id === groupId)
  if (groupId !== undefined && !detailGroup) throw new Error('知识计划分组不存在')
  const groupDetailCount = detailGroup ? Math.max(detailGroup.sources.length, detailGroup.gaps.length, detailGroup.outputs.length) : 0
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
    groupDetails: detailGroup ? {
      groupId: detailGroup.id, planState: workflow?.approved ? 'approved' : 'proposal', planRevision: detailPlan!.revision,
      summary: detailGroup.summary,
      sources: detailGroup.sources.slice(sourceOffset, sourceOffset + pageSize),
      gaps: detailGroup.gaps.slice(sourceOffset, sourceOffset + pageSize),
      outputs: detailGroup.outputs.slice(sourceOffset, sourceOffset + pageSize),
      sourceCount: detailGroup.sources.length, gapCount: detailGroup.gaps.length, outputCount: detailGroup.outputs.length,
      sourceOffset, nextSourceOffset: sourceOffset + pageSize < groupDetailCount ? sourceOffset + pageSize : undefined,
    } : undefined,
    itemDetails: detailItem ? {
      itemId: detailItem.id, summary: detailItem.summary, scope: detailItem.scope, dependencyState: detailItem.dependencyState,
      sources: (detailItem.sources ?? []).slice(sourceOffset, sourceOffset + pageSize),
      sections: detailItem.sections.slice(sourceOffset, sourceOffset + pageSize),
      gaps: (detailItem.gaps ?? []).slice(sourceOffset, sourceOffset + pageSize),
      sourceCount: detailItem.sources?.length ?? 0, sectionCount: detailItem.sections.length, gapCount: detailItem.gaps?.length ?? 0,
      sourceOffset, nextSourceOffset: sourceOffset + pageSize < detailCount ? sourceOffset + pageSize : undefined,
    } : undefined,
    initialized: snapshot.initialized,
    revision: snapshot.revision,
    paused: workflow?.paused ?? false,
    execution: workflow?.execution ? {
      status: workflow.execution.status, generation: workflow.execution.generation,
      currentItemId: workflow.execution.currentItemId, reason: workflow.execution.reason,
      turns: workflow.execution.turns, calls: workflow.execution.calls, bytes: workflow.execution.bytes,
      activeMs: workflow.execution.activeMs,
      failures: Object.fromEntries(Object.entries(workflow.execution.failures).slice(offset, offset + pageSize)),
      userEvidence: workflow.execution.userEvidence.slice(0, 8).map(({ id }) => ({ id })),
    } : undefined,
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
        sources: item.sources?.slice(0, 4).map(({ entryId, revision }) => ({ entryId, revision })),
        sourceCount: item.sources?.length ?? 0,
        sourcesTruncated: (item.sources?.length ?? 0) > 4,
        scope: item.scope ? brief(item.scope, 320) : undefined,
        gaps: item.gaps?.slice(0, 4).map((gap) => brief(gap, 160)),
        documentRevision: snapshot.entries?.find((entry) => entry.id === item.entryId)?.revision,
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
  /** 在当前普通会话授权下发现新来源。 */
  scanSources?: (signal?: AbortSignal) => Promise<KnowledgeAgentScanResult>
  /** 仅通过宿主选择器导入，随后扫描已保留的来源。 */
  importSources?: (mode: KnowledgeImportMode, signal?: AbortSignal) => Promise<KnowledgeAgentImportResult>
  /** 受写租约保护的定向刷新；不登记已读。 */
  refreshSources?: (sources: KnowledgePlanSource[]) => Promise<KnowledgeEntry[]>
  next(): Promise<{ refs: KnowledgeSourceRef[]; remaining: number }>
  observeRead(result: KnowledgeReadResult): void
  /** 只登记本轮实际交付给模型的任务用户原文身份。 */
  observeUserEvidence?(ids: string[]): void
  submit(input: KnowledgeAgentMaintenanceSubmitInput): Promise<KnowledgeAgentMaintenanceSubmitResult>
  /** 读取最新 proposal、approved 版本和大纲进度。 */
  status?: (offset?: number, itemId?: string, sourceOffset?: number, groupId?: string) => Promise<KnowledgeAgentWorkflowStatus>
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
  /** 跨轮证据必须先在本轮交付，不能猜测任务内旧 ID。 */
  const observedUserEvidence = new Set<string>()
  const observeUserEvidence = (ids: string[]): void => { for (const id of ids) observedUserEvidence.add(id) }
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
    /**
     * 两步知识文档流程的读取范围由受控读取结果决定：JSON、源码等合法来源
     * 可能不适合旧的“自动提炼候选”批次，但只要正文确实可读，就必须登记，
     * 否则发布阶段会把真实读取误判为 evidence_unread。元数据或不可读结果仍拒绝。
     */
    const readableWorkflowSource = options.workflow
      && result.status === 'readable'
      && !result.entry.metadataOnly
    if (result.status !== 'readable' || (!readableWorkflowSource && !isSourceDistillationCandidate(result.entry)
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
  const status = async (offset = 0, itemId?: string, sourceOffset = 0, groupId?: string): Promise<KnowledgeAgentWorkflowStatus> => {
    options.assertCurrent()
    const snapshot = await options.workflow!.getSnapshot(options.workspaceId)
    options.assertCurrent()
    return compactKnowledgeWorkflowStatus(snapshot, offset, itemId, sourceOffset, groupId)
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
    if (input.userEvidenceId && !observedUserEvidence.has(input.userEvidenceId)) throw new Error('任务用户证据尚未在本轮读取')
    if (input.userEvidenceId && !input.userQuote) throw new Error('用户证据引用必须附带逐字原话')
    /** 原始任务证据和当前用户消息分别解析，控制消息不能替代事实来源。 */
    const resolveUserEvidence = () => input.userEvidenceId
      ? options.resolveTaskUserEvidence?.(input.userEvidenceId)
      : { sessionId: options.sessionId, message: options.readUserEvidence() }
    const initialUserSource = input.userQuote ? resolveUserEvidence() : undefined
    const initialUserEvidence = initialUserSource?.message
    if (input.userQuote && (!initialUserEvidence || (!input.userEvidenceId && initialUserEvidence.uuid !== options.userMessageId)
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
          throw new KnowledgeToolFailure(fresh.entry.revision !== evidence.revision ? 'stale_revision' : 'source_changed', '文档来源版本或正文已变化')
        }
      }
      if (input.userQuote) {
        const currentUserSource = resolveUserEvidence()
        const currentUserEvidence = currentUserSource?.message
        if (!initialUserEvidence || !currentUserEvidence
          || currentUserSource?.sessionId !== initialUserSource?.sessionId
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
          userEvidence: { sessionId: initialUserSource!.sessionId, messageId: initialUserEvidence!.uuid, quote: input.userQuote, sha256: createHash('sha256').update(initialUserEvidence!.text, 'utf8').digest('hex') },
        } : {}),
      })
    })
    return compactKnowledgeWorkflowStatus(snapshot)
  }
  /** 二进制内容不在 Agent 读取预算中展开，core 以 metadataOnly 来源和大纲范围核验。 */
  const copyAsset = (input: KnowledgeAgentAssetInput): Promise<KnowledgeAssetCopyResult> => runWorkflowWrite(
    (workflow) => workflow.copyAsset({ ...input, workspaceId: options.workspaceId }),
  )
  const refreshSources = options.workflow.refreshSources
    ? (sources: KnowledgePlanSource[]) => runWorkflowWrite((workflow) => workflow.refreshSources!(options.workspaceId, sources))
    : undefined
  /** 来源发现沿用现有写权限和工作区租约，完成后再次检查撤权。 */
  const scanSources = options.workflow.scanSources
    ? (signal?: AbortSignal) => runWorkflowWrite((workflow) => workflow.scanSources!(options.workspaceId, signal))
    : undefined
  /** 导入模式在服务入口继续复核，不能通过类型断言注入路径。 */
  const importSources = options.workflow.importSources
    ? (mode: KnowledgeImportMode, signal?: AbortSignal) => runWorkflowWrite((workflow) => workflow.importSources!(options.workspaceId, mode, signal))
    : undefined
  return { next, observeRead, submit, status, proposePlan, saveOutline, writeDocument, copyAsset, refreshSources, observeUserEvidence, scanSources, importSources }
}
