/** 供应商报告的标准用量；输入已包含缓存，null 表示未报告，不能当成零。 */
export interface TokenUsageAmounts {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}

/** 调用来源；后台处理保持独立类型，同时归入所属任务。 */
export type TokenUsageSource = 'agent' | 'chat' | 'automation' | 'delegation' | 'knowledge' | 'factory' | 'title' | 'compaction' | 'vision'

/** 单次可观察的模型调用快照，不保存提示词、正文、凭据或本机路径。 */
export interface TokenUsageRecord extends TokenUsageAmounts {
  /** 调用方生成的稳定身份；重放同一记录只计一次。 */
  id: string
  /** 根任务身份；子 Agent 使用相同根任务，调用本身仍各计一次。 */
  taskId: string
  taskTitle: string
  /** 可导航的实际会话；已删除时详情仍保留。 */
  sessionId?: string
  sessionType?: 'agent' | 'chat'
  projectId: string | null
  projectName: string
  channelId: string | null
  channelName: string
  modelId: string
  source: TokenUsageSource
  startedAt: number
  finishedAt: number
  status: 'completed' | 'failed' | 'cancelled'
  /** 隐式 SDK 重试不能观测时显式揭示调用次数的边界。 */
  hiddenRetriesPossible?: boolean
  /** 历史恢复与新采集分开说明，不能补造历史归属。 */
  origin: 'live' | 'history'
}

/** 查询按用户本地自然日；日期为 YYYY-MM-DD，包含两端。 */
export interface TokenUsageQuery {
  from: string
  to: string
  timeZone: string
  projectId?: string
  channelId?: string
  modelId?: string
  source?: TokenUsageSource
  day?: string
  search?: string
  unknownOnly?: boolean
  sort?: 'recent' | 'tokens'
  page?: number
  pageSize?: number
}

/** 已知量汇总与报告覆盖度；部分用量计入已知分量，但不假装完整报告。 */
export interface TokenUsageTotals {
  /** 各分量真实报告次数，避免全未知的小计在界面被显示成实际零用量。 */
  reportedFields?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  calls: number
  knownCalls: number
  partialCalls: number
  unknownCalls: number
}

/** 单个自然日趋势。 */
export interface TokenUsageDay extends TokenUsageTotals { day: string }
/** 来源排行条目。 */
export interface TokenUsageRank extends TokenUsageTotals { id: string; name: string }
/** 筛选使用调用快照；未关联为 __none__，历史未知为 __history_unknown__。 */
export interface TokenUsageOption { id: string; name: string }
/** 当前范围内的根任务聚合，不混入范围外调用。 */
export interface TokenUsageTask extends TokenUsageTotals {
  id: string
  title: string
  projectNames: string[]
  modelIds: string[]
  sources: TokenUsageSource[]
  lastCalledAt: number
  sessionId?: string
  sessionType?: 'agent' | 'chat'
}

/** 首次启用、历史恢复和不可观测边界，用于页面统计口径说明。 */
export interface TokenUsageCoverage {
  /** 采集写入故障必须在主页面提示，不能仅隐藏在统计口径里。 */
  recordingError?: string
  /** 历史恢复在后台失败时展示可重试原因，不能让页面无限等待。 */
  historyImportError?: string
  trackingStartedAt: number
  historyImportedAt: number | null
  historyRecords: number
  notes: string[]
}

/** 一次查询返回聚合、分页任务与筛选选项，不把全部调用送到 renderer。 */
export interface TokenUsageSnapshot {
  totals: TokenUsageTotals
  trend: TokenUsageDay[]
  ranking: { project: TokenUsageRank[]; model: TokenUsageRank[]; source: TokenUsageRank[] }
  tasks: TokenUsageTask[]
  taskCount: number
  page: number
  pageSize: number
  options: { projects: TokenUsageOption[]; models: TokenUsageOption[]; channels: TokenUsageOption[] }
  coverage: TokenUsageCoverage
}

/** 任务详情同时给出本筛选贡献与完整任务，逐条标记调用是否在范围内。 */
export interface TokenUsageTaskDetail {
  task: TokenUsageTask
  matching: TokenUsageTotals
  calls: Array<TokenUsageRecord & { matchesFilter: boolean }>
}

/** 统计桥接接口；导出由主进程打开保存对话框，不向 renderer 暴露任意文件写入。 */
export interface TokenUsageAPI {
  getTokenUsage(query: TokenUsageQuery): Promise<TokenUsageSnapshot>
  getTokenUsageTask(taskId: string, query: TokenUsageQuery): Promise<TokenUsageTaskDetail | null>
  exportTokenUsage(query: TokenUsageQuery): Promise<{ saved: boolean; count: number }>
}

/** IPC 通道集中定义，四层共享同一名称。 */
export const TOKEN_USAGE_IPC = {
  QUERY: 'token-usage:query',
  TASK: 'token-usage:task',
  EXPORT: 'token-usage:export',
} as const

/** 用户可见来源名称，统计页与导出保持一致。 */
export const TOKEN_USAGE_SOURCE_LABELS: Record<TokenUsageSource, string> = {
  agent: 'Agent 会话', chat: '普通 Chat', automation: '自动化', delegation: '子 Agent',
  knowledge: '知识提炼', factory: '编排工厂', title: '标题生成', compaction: '上下文压缩', vision: '视觉中继',
}
