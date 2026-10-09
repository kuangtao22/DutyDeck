/** 计划中引用的来源版本；发现来源不等于已读取正文。 */
export interface KnowledgePlanSource {
  /** 已登记的来源身份。 */
  entryId: string
  /** 提案时所见版本。 */
  revision: string
  /** 宿主从登记来源补充标题，首页分页之外也能识别依据。 */
  title?: string
  /** 宿主登记的显示定位，不作为写入参数。 */
  relativePath?: string
  /** 宿主依据实际读页记录标注覆盖；读取局部不等于已核验结论。 */
  coverage?: 'discovered' | 'read' | 'unsupported'
}

/** Agent 提出的自由分组，不绑定行业分类或固定文件夹模板。 */
export interface KnowledgePlanGroup {
  /** 项目内稳定分组身份。 */
  id: string
  /** 用户可修改的分组名称。 */
  title: string
  /** 本组准备整理的信息与适用范围。 */
  summary: string
  /** 可追溯的现有资料。 */
  sources: KnowledgePlanSource[]
  /** 尚缺或尚未核对的信息。 */
  gaps: string[]
  /** 预计产出的文档说明。 */
  outputs: string[]
}

/** 一版分组清单；只有宿主收到 UI 确认后才转入 approved。 */
export interface KnowledgePlan {
  /** 清单身份，防止跨清单确认。 */
  id: string
  /** 每次重新提案递增的版本。 */
  revision: number
  /** 项目资料库标题。 */
  title: string
  /** 项目根内拟使用的可读目录。 */
  rootRelativePath: string
  /** 本版清单的自由分组。 */
  groups: KnowledgePlanGroup[]
  /** 提案时间。 */
  createdAt: number
  /** 仅由用户确认端口产生。 */
  confirmedAt?: number
}

/** 大纲中的计划文件，生成前不提供虚假正文链接。 */
export interface KnowledgeOutlineItem {
  /** 稳定文档主题身份。 */
  id: string
  /** 所属已确认分组。 */
  groupId: string
  /** 可读文档标题。 */
  title: string
  /** 相对于资料库根的真实 Markdown 路径。 */
  relativePath: string
  /** 文档目的与适用对象。 */
  summary: string
  /** 自由章节大纲。 */
  sections: string[]
  /** 正文真实保存后才关联条目。 */
  entryId?: string
  /** 执行进度与事实确认状态无关。 */
  status: 'pending' | 'partial' | 'ready' | 'missing'
}

/** 可读大纲的版本和计划内容。 */
export interface KnowledgeOutline {
  /** 内容或结构变化时递增。 */
  revision: number
  /** 大纲所属的已确认清单。 */
  planRevision: number
  /** 各文档的计划和执行状态。 */
  items: KnowledgeOutlineItem[]
  /** 大纲真实入口，相对资料库根。 */
  relativePath: string
}

/** 与知识 manifest 一起持久化的两步流程。 */
export interface KnowledgeWorkflow {
  /** 尚待用户确认的最新清单，不能自行成为已确认范围。 */
  proposal?: KnowledgePlan
  /** 当前可维护的范围；新提案不撤销原范围。 */
  approved?: KnowledgePlan
  /** 确认后才产生的大纲。 */
  outline?: KnowledgeOutline
  /** 暂停后拒绝后续 Agent 发布。 */
  paused: boolean
}

/** Agent 提交分组清单的输入，工作区由运行闭包补入。 */
export interface KnowledgePlanProposalInput {
  /** 宿主绑定的项目。 */
  workspaceId: string
  /** 资料库标题。 */
  title: string
  /** 拟使用的项目相对目录。 */
  rootRelativePath: string
  /** 自由分组，不接受 confirmedAt 等确认字段。 */
  groups: KnowledgePlanGroup[]
}

/** UI 对用户实际看到的版本做部分或全部确认。 */
export interface KnowledgePlanConfirmInput {
  /** 当前用户选择的项目。 */
  workspaceId: string
  /** 用户实际看到的清单。 */
  planId: string
  /** 拒绝确认陈旧版本。 */
  expectedRevision: number
  /** 被选中的分组及用户修订名称，不能偷偷增加未展示来源。 */
  groups: Array<{ id: string; title: string }>
}

/** Agent 在已确认范围内保存大纲。 */
export interface KnowledgeOutlineInput {
  /** 宿主绑定的项目。 */
  workspaceId: string
  /** 当前已确认计划版本。 */
  planRevision: number
  /** 首次为零，之后必须匹配所读版本。 */
  expectedRevision: number
  /** 模型不能伪造 entryId 和完成状态。 */
  items: Array<Omit<KnowledgeOutlineItem, 'entryId' | 'status'>>
}

/** 当前主题正文在可读目录中的定位及内容版本。 */
export interface KnowledgeDocumentLocation {
  /** 稳定主题身份，与文件改名无关。 */
  topicKey: string
  /** 所属用户已确认分组。 */
  groupId: string
  /** 项目根内的库根。 */
  rootRelativePath: string
  /** 库根内的正文路径。 */
  relativePath: string
  /** 当前磁盘内容 hash，用于阻止覆盖外部编辑。 */
  contentRevision: string
}

/** Agent 提交有依据的正文；来源与当前用户引文由运行时验证。 */
export interface KnowledgeDocumentWriteInput {
  /** 宿主绑定的项目。 */
  workspaceId: string
  /** 已确认计划版本。 */
  planRevision: number
  /** 已读取的大纲版本。 */
  outlineRevision: number
  /** 目标大纲项身份。 */
  itemId: string
  /** 新文件为 null，否则为已读取条目版本。 */
  expectedRevision: string | null
  /** 自包含的 Markdown 正文。 */
  content: string
  /** 有界检索摘要。 */
  summary: string
  /** 是否已补全本项，不能代表事实已确认。 */
  complete: boolean
  /** 本轮实际读过的来源页逐字证据。 */
  evidence: Array<{ entryId: string; revision: string; quote: string }>
  /** 可选当前用户原话，由宿主验证，不接受伪造会话身份。 */
  userQuote?: string
  /** 宿主校验当前用户原话后补入，模型工具不得提供。 */
  userEvidence?: { sessionId: string; messageId: string; quote: string }
}

/** 用户暂停或继续当前已确认范围。 */
export interface KnowledgeWorkflowPauseInput {
  /** 当前项目。 */
  workspaceId: string
  /** 真实用户动作。 */
  paused: boolean
}

/** 从已扫描资产复制原格式附件，目的位置限定在当前已确认的大纲文档旁。 */
export interface KnowledgeAssetCopyInput {
  /** 当前运行固定工作区。 */
  workspaceId: string
  /** 用户已确认的计划版本。 */
  planRevision: number
  /** 当前大纲版本。 */
  outlineRevision: number
  /** 使用附件的大纲项。 */
  itemId: string
  /** 已登记的二进制资产条目。 */
  sourceEntryId: string
  /** 读取目录时所见条目版本。 */
  sourceRevision: string
  /** 相对于库根的归档路径，必须位于 assets 下。 */
  relativePath: string
}

/** 真实复制后可在正文中使用的相对引用，不代表 Agent 已理解图片或设计稿。 */
export interface KnowledgeAssetCopyResult {
  /** 归档到库根的路径。 */
  relativePath: string
  /** 相对于目标 Markdown 的链接。 */
  documentRelativePath: string
  /** 原格式文件的内容指纹。 */
  contentRevision: string
  /** 真实复制字节数。 */
  byteSize: number
}
