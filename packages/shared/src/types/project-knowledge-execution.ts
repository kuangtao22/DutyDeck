/** 原始用户证据的固定定位；正文每轮重新读取，不复制历史会话。 */
export interface KnowledgeUserEvidenceIdentity {
  /** 任务内稳定证据身份。 */
  id: string
  /** 原消息所在普通项目会话。 */
  sessionId: string
  /** 原始用户消息身份。 */
  messageId: string
  /** 原始文本指纹，消息变化后不能沿用。 */
  sha256: string
}

/** 知识任务的单项失败原因，供局部恢复和界面说明。 */
export interface KnowledgeItemFailure {
  /** 稳定错误分类。 */
  code: string
  /** 用户可理解的原因。 */
  message: string
}

/** 与知识工作流一起原子保存的有界任务。 */
export interface KnowledgeExecution {
  /** 一次用户启动的任务身份。 */
  id: string
  /** 恢复或重新启动时递增，拒绝迟到回执。 */
  generation: number
  /** 固定普通整理会话。 */
  sessionId: string
  /** 执行对应的已批准计划版本。 */
  planRevision: number
  /** 用户启动时的模型选择，自动续接不能悄悄换渠道或模型。 */
  model?: { channelId?: string; modelId?: string }
  /** 空数组表示已批准的全部条目。 */
  itemIds: string[]
  /** 宿主生命周期状态，不根据模型回复设置。 */
  status: 'queued' | 'running' | 'paused' | 'blocked' | 'interrupted' | 'finished'
  /** 最近处理的条目。 */
  currentItemId?: string
  /** 当前实际 Agent 运行代次。 */
  runGeneration?: number
  /** 每次派发独有的消息身份，不可复用旧队列消息。 */
  dispatchId: string
  /** 已开始的模型回合数。 */
  turns: number
  /** 本段额度内累计检索调用数。 */
  calls: number
  /** 本段额度内累计结果字节数。 */
  bytes: number
  /** 只累计活跃模型运行时间。 */
  activeMs: number
  /** 当前回合开始时刻。 */
  startedAt?: number
  /** 最近一次有意义的新证据或保存时刻。 */
  lastProgressAt?: number
  /** 本任务读到的精确页范围，防止重复读取触发续接。 */
  readPages: string[]
  /** 有效进展序号，跨轮不重置。 */
  progress: number
  /** 当前轮开始时的进展序号。 */
  turnStartProgress: number
  /** 按条目记录失败，避免一项拖住全部。 */
  failures: Record<string, KnowledgeItemFailure>
  /** 同一来源版本已消费的自动恢复额度，显式继续才重置。 */
  sourceRecoveries?: string[]
  /** 相同正文与证据版本的失败次数，限制无变化自动重试。 */
  documentFailures?: Record<string, number>
  /** 全局阻塞的机器可读原因。 */
  reason?: string
  /** 原始用户事实引用，控制提示不能进入。 */
  userEvidence: KnowledgeUserEvidenceIdentity[]
  /** 最近状态变化时间。 */
  updatedAt: number
}

/** 用户启动或继续已批准范围；条目列表用于局部重试。 */
export interface KnowledgeExecutionStartInput {
  /** 项目身份。 */
  workspaceId: string
  /** 承接执行的同项目普通会话。 */
  sessionId: string
  /** 用户当前所见批准版本。 */
  planRevision: number
  /** 可选的局部重试范围。 */
  itemIds?: string[]
}
