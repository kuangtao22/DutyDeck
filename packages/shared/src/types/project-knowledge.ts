import type { KnowledgeDocumentLocation, KnowledgePlanConfirmInput, KnowledgeWorkflow, KnowledgeWorkflowPauseInput } from './project-knowledge-workflow'

/** 项目自由分组；旧分类字符串继续可读，不限制新场景。 */
export type KnowledgeCategory = string

/** 内容性质与审核状态、新鲜度分别记录。 */
export type KnowledgeKind = 'document' | 'asset' | 'fact' | 'decision' | 'experience' | 'preference' | 'rule'

/** 知识的采用状态，不表示来源仍然是最新版本。 */
export type KnowledgeState = 'indexed' | 'draft' | 'confirmed' | 'superseded' | 'archived'

/** 当前内容与已观察来源版本的关系。 */
export type KnowledgeFreshness = 'current' | 'changed' | 'unavailable' | 'unverified'

/** 项目知识服务允许登记和过滤的来源类型。 */
export const KNOWLEDGE_SOURCE_KINDS = ['project-file', 'memory-file', 'conversation', 'managed', 'canvas', 'api'] as const

/** 来源类型由共享常量推导，IPC 与服务端使用同一白名单。 */
export type KnowledgeSourceKind = typeof KNOWLEDGE_SOURCE_KINDS[number]

/** 来源仅保存受控定位信息，不接受 renderer 指定绝对路径。 */
export interface KnowledgeSource {
  /** 来源由哪个服务拥有；文件路径始终相对于该服务解析的根。 */
  kind: KnowledgeSourceKind
  /** 来源服务内的稳定身份。 */
  id: string
  /** 文件或可读来源的显示位置，不作为外部任意路径入口。 */
  relativePath?: string
  /** 提炼依据所在的当前项目会话。 */
  sessionId?: string
  /** 已落盘的消息身份，避免使用易变的数组下标。 */
  messageIds?: string[]
  /** 内容摘要或来源服务提供的版本。 */
  revision: string
}

/** 可供目录展示与检索排序的知识条目头。 */
export interface KnowledgeEntry {
  /** 新版文档的权威文件定位；未提供时兼容旧不可变正文。 */
  document?: KnowledgeDocumentLocation
  /** 重命名和目录整理后仍保持稳定的条目 ID。 */
  id: string
  /** 当前发布的不可变条目版本。 */
  revision: string
  /** 用户可读标题。 */
  title: string
  /** 默认业务分类。 */
  category: KnowledgeCategory
  /** 资料或结论的性质。 */
  kind: KnowledgeKind
  /** 是否已确认、被替代或归档。 */
  state: KnowledgeState
  /** 来源版本核验状态。 */
  freshness: KnowledgeFreshness
  /** 用于有界检索和列表预览的短摘要。 */
  summary: string
  /** 受控原始依据。 */
  source: KnowledgeSource
  /** 提炼依据指向来源条目的固定版本；逐字引文由宿主校验。 */
  evidence?: Array<{ entryId: string; revision: string; quote: string }>
  /** 当前用户原话的可信会话来源；仅由宿主在校验后写入。 */
  userEvidence?: { sessionId: string; messageId: string; quote: string }
  /** 来源总字节数；未知的外部来源使用零。 */
  byteSize: number
  /** 实际已提取的 UTF-8 字节数。 */
  indexedBytes: number
  /** 是否还有未提取正文。 */
  truncated: boolean
  /** 是否只支持元数据检索。 */
  metadataOnly: boolean
  /** 最近发布条目版本的时间。 */
  updatedAt: number
}

/** 扫描进度区分发现、提取与跳过，不伪造完整度百分比。 */
export interface KnowledgeScanProgress {
  /** 本轮扫描的可观察状态。 */
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
  /** 已发现来源数量。 */
  discovered: number
  /** 已提取正文来源数量。 */
  indexed: number
  /** 因排除、权限、预算或读取失败跳过的数量。 */
  skipped: number
  /** 本次发生变化的条目数量。 */
  changed: number
  /** 本次扫描开始时间。 */
  startedAt?: number
  /** 完成、失败或取消时间。 */
  finishedAt?: number
  /** 可供用户理解的失败或覆盖范围说明。 */
  message?: string
}

/** 持续维护的独立授权与模型预算，不复用 AGENTS.md 授权。 */
export interface KnowledgeMaintenanceSettings {
  /** 仅启用后的合规新回合可被自动处理。 */
  enabled: boolean
  /** 指定用于后台分析的渠道；缺失时不发起模型调用。 */
  channelId?: string
  /** 指定模型，不自动回退到其他付费模型。 */
  modelId?: string
  /** 每个自然日最多允许的分析作业次数。 */
  dailyJobLimit: number
  /** 开关或模型设置变化时递增，用于拒绝迟到结果。 */
  generation: number
  /** 本次启用时间，用于排除过去的回合。 */
  enabledAt?: number
}

/** 目录首页和轮询状态；完整结果通过分页搜索读取。 */
export interface KnowledgeSnapshot {
  /** 分组确认与大纲执行状态，未建新流程时省略。 */
  workflow?: KnowledgeWorkflow
  /** 权威工作区 ID。 */
  projectId: string
  /** 是否已经由用户发起建库。 */
  initialized: boolean
  /** 当前发布的清单版本。 */
  revision: number
  /** 首页最多返回 200 条，完整目录使用分页搜索。 */
  entries: KnowledgeEntry[]
  /** 包括未在首页列出的条目总数。 */
  totalEntries: number
  /** 有效提炼知识与来源资料分别统计，不将文件索引当成知识成果。 */
  knowledgeCount?: number
  sourceCount?: number
  /** 当前扫描状态。 */
  scan: KnowledgeScanProgress
  /** 持续维护设置。 */
  maintenance: KnowledgeMaintenanceSettings
  /** 尚未整理的已落盘回合数量。 */
  pendingTurns: number
  /** 最近一次正式清单更新时间。 */
  updatedAt?: number
  /** 后台处理水位与失败信息；与扫描进度独立。 */
  maintenanceStatus?: KnowledgeMaintenanceStatus
  /** 最近二十次可审查的受管内容操作。 */
  operations?: KnowledgeOperationSummary[]
}

/** 维护设置只由用户界面提交，不向 Agent 暴露写入口。 */
export interface KnowledgeMaintenanceInput {
  /** 权威工作区身份。 */
  workspaceId: string
  /** 用户是否允许处理启用后的新对话。 */
  enabled: boolean
  /** 明确选择的渠道与模型，不自动回退。 */
  channelId?: string
  modelId?: string
  /** 每天最多运行的分析任务数，范围 1–100。 */
  dailyJobLimit: number
}

/** 正式知识和待整理证据分别展示。 */
export interface KnowledgeMaintenanceStatus {
  /** 可观察的后台队列状态。 */
  status: 'paused' | 'idle' | 'queued' | 'running' | 'blocked' | 'failed'
  /** 仍待整理的回合数。 */
  pendingTurns: number
  /** 失败且可重试的回合数。 */
  failedTurns: number
  /** 项目文档待提炼和失败的批次数，与对话回合分开显示。 */
  pendingSources?: number
  failedSources?: number
  /** 不含模型原文或凭据的原因说明。 */
  message?: string
  /** 最近正式完成整理的时间。 */
  lastProcessedAt?: number
  /** 已超出近期证据窗口的待整理回合数量。 */
  outsideRecentWindow?: number
}

/** 一次受管内容变更的可审查摘要。 */
export interface KnowledgeOperationSummary {
  /** 不随显示位置变化的操作身份。 */
  id: string
  /** 操作种类，原文件不受这些操作修改。 */
  kind: 'classify' | 'merge' | 'split' | 'undo' | 'confirm' | 'reject' | 'extract'
  /** 用户可读的操作说明。 */
  summary: string
  /** 变更的条目身份，可继续沿旧引用读取。 */
  entryIds: string[]
  /** 发生时间。 */
  createdAt: number
  /** 后续版本变化可能使撤销需要报告冲突。 */
  undoable: boolean
}

/** 用户审核候选时必须携带所见版本，不能覆盖迟到变更。 */
export interface KnowledgeReviewInput {
  /** 当前项目。 */
  workspaceId: string
  /** 被审核条目及其已展示版本。 */
  entryId: string
  expectedRevision: string
  /** 拒绝会留下持久化排除记录，模型重试不能复活。 */
  action: 'confirm' | 'reject'
}

/** 旧记忆整理仅提供预览；原文件编辑仍由既有记忆编辑器负责。 */
export interface KnowledgeMemoryOrganizationPreview {
  /** 当前预览绑定的项目。 */
  projectId: string
  /** 已检查的原文件数量及预算覆盖状态。 */
  inspected: number
  truncated: boolean
  /** 每个建议附原条目版本，便于采纳前核对当前正文。 */
  proposals: Array<{
    entryId: string
    revision: string
    relativePath: string
    title: string
    sections: string[]
    truncated: boolean
  }>
}

/** 搜索和目录分页输入，工作区 ID 由主进程再次核验。 */
export interface KnowledgeSearchInput {
  /** 当前用户选择的项目。 */
  workspaceId: string
  /** 空字符串表示浏览目录，有内容时只返回相关结果。 */
  query: string
  /** 知识与来源各自分页；省略时兼容既有全部资料检索。 */
  scope?: 'knowledge' | 'sources' | 'all'
  /** 在排序和分页前限定一种受控来源，用于宿主的有界关联检索。 */
  sourceKind?: KnowledgeSourceKind
  /** 可选业务分类。 */
  category?: KnowledgeCategory
  /** 历史内容仅在显式请求时参与检索。 */
  includeHistory?: boolean
  /** 从第几个结果继续读取。 */
  offset?: number
  /** 默认 6，目录浏览可申请最多 100。 */
  limit?: number
}

/** 一项检索结果；命中不代表已经读取全部正文。 */
export interface KnowledgeSearchHit {
  /** 关联的当前条目。 */
  entry: KnowledgeEntry
  /** 实际命中的有界原文片段。 */
  snippet: string
  /** 原文片段的起始行，元数据命中使用 1。 */
  line: number
  /** 本地相关性分数，不是事实可信度。 */
  score: number
}

/** 可分页、有明确索引状态的检索结果。 */
export interface KnowledgeSearchResult {
  /** 本次读取的清单版本。 */
  revision: number
  /** 当前页结果。 */
  items: KnowledgeSearchHit[]
  /** 符合本次条件的结果数量。 */
  total: number
  /** 有后续结果时提供下一页偏移。 */
  nextOffset?: number
  /** 缓存未建成时仍可浏览资料元数据。 */
  indexStatus: 'ready' | 'building' | 'missing'
}

/** 正文读取参数，原文件路径不暴露为可替换的参数。 */
export interface KnowledgeReadInput {
  /** 当前项目。 */
  workspaceId: string
  /** 已登记条目身份。 */
  entryId: string
  /** 分页的 UTF-8 字节偏移，服务端校验编码边界。 */
  offset?: number
  /** 请求者此前见到的条目版本，用于提示版本变化。 */
  expectedRevision?: string
}

/** 正文有界读取回执，不用空字符串冒充不可访问来源。 */
export interface KnowledgeReadResult {
  /** 当前条目元数据。 */
  entry: KnowledgeEntry
  /** 当前页 UTF-8 正文，最多 24 KiB。 */
  content: string
  /** 来源变化或删除时明确返回状态。 */
  status: 'readable' | 'changed' | 'unavailable' | 'metadata-only'
  /** 当前页起始字节。 */
  offset: number
  /** 若仍有正文，返回下一页偏移。 */
  nextOffset?: number
  /** 是否存在尚未返回的正文。 */
  truncated: boolean
}

/** 四层共享的知识库固定 IPC 通道。 */
export const PROJECT_KNOWLEDGE_IPC_CHANNELS = {
  CONFIRM_PLAN: 'project-knowledge:confirm-plan',
  PAUSE_WORKFLOW: 'project-knowledge:pause-workflow',
  SNAPSHOT: 'project-knowledge:snapshot',
  SCAN: 'project-knowledge:scan',
  CANCEL_SCAN: 'project-knowledge:cancel-scan',
  SEARCH: 'project-knowledge:search',
  READ: 'project-knowledge:read',
  MAINTENANCE: 'project-knowledge:maintenance',
  RETRY: 'project-knowledge:retry',
  REVIEW: 'project-knowledge:review',
  ORGANIZE: 'project-knowledge:organize',
  UNDO: 'project-knowledge:undo',
  EXCLUDE_SESSION: 'project-knowledge:exclude-session',
  PREVIEW_MEMORY: 'project-knowledge:preview-memory',
} as const

/** Renderer 仅能通过项目身份访问知识库，不接触文件系统和模型凭据。 */
export interface ProjectKnowledgeApi {
  /** 用户确认当前分组清单；Agent 没有对应确认工具。 */
  confirmProjectKnowledgePlan(input: KnowledgePlanConfirmInput): Promise<KnowledgeSnapshot>
  /** 暂停或继续已确认的知识生成。 */
  pauseProjectKnowledgeWorkflow(input: KnowledgeWorkflowPauseInput): Promise<KnowledgeSnapshot>
  /** 取得已建库状态，不隐式扫描。 */
  getProjectKnowledgeSnapshot(workspaceId: string): Promise<KnowledgeSnapshot>
  /** 用户发起扫描或增量更新。 */
  scanProjectKnowledge(workspaceId: string): Promise<KnowledgeSnapshot>
  /** 取消后续扫描批次。 */
  cancelProjectKnowledgeScan(workspaceId: string): Promise<KnowledgeSnapshot>
  /** 分页检索当前项目已登记资料。 */
  searchProjectKnowledge(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult>
  /** 按条目身份读取有界正文。 */
  readProjectKnowledge(input: KnowledgeReadInput): Promise<KnowledgeReadResult>
  /** 保存持续维护授权与预算。 */
  updateProjectKnowledgeMaintenance(input: KnowledgeMaintenanceInput): Promise<KnowledgeSnapshot>
  /** 用户主动重试待整理任务，不重新执行对话。 */
  retryProjectKnowledgeMaintenance(workspaceId: string): Promise<KnowledgeSnapshot>
  /** 确认或排除候选资料。 */
  reviewProjectKnowledge(input: KnowledgeReviewInput): Promise<KnowledgeSnapshot>
  /** 整理受管资料，保留旧引用与操作记录。 */
  organizeProjectKnowledge(workspaceId: string): Promise<KnowledgeSnapshot>
  /** 在当前版本仍匹配时恢复指定操作。 */
  undoProjectKnowledgeOperation(workspaceId: string, operationId: string): Promise<KnowledgeSnapshot>
  /** 排除当前项目的一段会话，阻止待处理和迟到任务。 */
  excludeProjectKnowledgeSession(workspaceId: string, sessionId: string): Promise<KnowledgeSnapshot>
  /** 预览旧记忆的主题拆分建议，不改写或移动原文件。 */
  previewProjectKnowledgeMemory(workspaceId: string): Promise<KnowledgeMemoryOrganizationPreview>
}
