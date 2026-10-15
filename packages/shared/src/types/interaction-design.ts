/** 交互设计模块 IPC：正式数据归项目，调用身份归当前 Agent 会话。 */
export const INTERACTION_DESIGN_CHANNELS = {
  INVOKE: 'interaction-design:invoke',
  CHANGED: 'interaction-design:changed',
} as const

/** 页面目录分组；数组位置就是顺序，折叠状态另存为视图偏好。 */
export interface PrototypeGroup {
  /** 原型内稳定身份。 */
  id: string
  /** 用户可修改的分组名称。 */
  name: string
  /** 父分组身份；缺省表示项目根分组。 */
  parentId?: string
}

/** 来源只保存项目相对路径和内容身份，不携带本机绝对路径。 */
export interface PrototypeSource {
  /** 来源文件的授权项目相对路径。 */
  path: string
  /** 提取时源文件 SHA-256。 */
  hash: string
  /** 静态导入或 Agent 从源码还原。 */
  kind: 'html' | 'code'
}

/** 独立页面正文；持久化服务将 HTML 转成不可变内容对象。 */
export interface PrototypePage {
  /** 原型内稳定页面身份。 */
  id: string
  /** 所属目录分组。 */
  groupId: string
  /** 页面显示名称。 */
  name: string
  /** 离线 HTML；元素用 data-prototype-element，路由用 data-prototype-page。 */
  html: string
  /** 可选的原项目来源记录。 */
  source?: PrototypeSource
}

/** 元素点击后在原型内部导航，不改变顶层窗口。 */
export interface PrototypeFlow {
  /** 稳定连接身份。 */
  id: string
  /** 动作所属页面。 */
  fromPageId: string
  /** data-prototype-element 对应值。 */
  elementId: string
  /** 导航目标页面。 */
  targetPageId: string
}

/** 可编辑内容；不包含演示中的表单值、当前页和焦点状态。 */
export interface PrototypeDraft {
  /** 原型名称。 */
  name: string
  /** 默认设备展示方式。 */
  platform: 'mobile' | 'desktop'
  /** 目标、已确认规则及模拟范围说明。 */
  brief: string
  /** 有序分组集合。 */
  groups: PrototypeGroup[]
  /** 分组内按数组位置排序的页面集合。 */
  pages: PrototypePage[]
  /** 唯一入口页。 */
  entryPageId: string
  /** 独立于目录排序的页面跳转关系。 */
  flows: PrototypeFlow[]
}

/** 当前完整版本，revision 由主进程分配。 */
export interface PrototypeDocument extends PrototypeDraft {
  /** 数据结构版本。 */
  schemaVersion: 1
  /** 项目内稳定交互模块身份；每个项目只有一个正式模块。 */
  id: string
  /** 当前版本号，严格递增。 */
  revision: number
  /** 创建时间（毫秒）。 */
  createdAt: number
  /** 当前版本的保存时间。 */
  updatedAt: number
}

/** 列表不携带 HTML 或图片字节。 */
export interface PrototypeSummary {
  /** 交互模块身份。 */
  id: string
  /** 名称。 */
  name: string
  /** 默认平台。 */
  platform: 'mobile' | 'desktop'
  /** 当前版本。 */
  revision: number
  /** 页面数量。 */
  pageCount: number
  /** 最近保存时间。 */
  updatedAt: number
}

/** 版本列表元数据，正文通过 getVersion 按需加载。 */
export interface PrototypeVersion {
  /** 版本号。 */
  revision: number
  /** 保存说明。 */
  summary: string
  /** 保存时间。 */
  createdAt: number
}

/** 候选摘要，生成与采纳是不同状态。 */
export interface PrototypeCandidateSummary {
  /** 候选身份。 */
  id: string
  /** 目标原型。 */
  prototypeId: string
  /** 固定的输入版本。 */
  baseRevision: number
  /** 变更说明。 */
  summary: string
  /** 当前可采纳性。 */
  status: 'ready' | 'stale' | 'adopted' | 'discarded'
  /** 创建时间。 */
  createdAt: number
  /** 可选的生成任务归属。 */
  jobId?: string
  /** 已采纳时对应的版本。 */
  adoptedRevision?: number
}

/** 完整候选正文仅在预览/采纳时读取。 */
export interface PrototypeCandidate extends PrototypeCandidateSummary {
  /** 候选完整内容。 */
  draft: PrototypeDraft
}

/** 运行记录跨会话关闭保留，不自动重放未知消费。 */
export interface PrototypeJob {
  /** 任务身份。 */
  id: string
  /** 原型身份。 */
  prototypeId: string
  /** 发起会话。 */
  sessionId: string
  /** 输入版本。 */
  baseRevision: number
  /** 用户任务与锁定范围描述。 */
  instruction: string
  /** 可选的当前页范围。 */
  pageId?: string
  /** 可选的当前元素范围。 */
  elementId?: string
  /** 任务终态与候选采用状态独立。 */
  status: 'running' | 'candidate' | 'cancelled' | 'failed' | 'interrupted'
  /** 可理解的结果说明。 */
  message?: string
  /** 创建时间。 */
  createdAt: number
}

/** 项目模块资产记录；图片字节以 hash 去重。 */
export interface PrototypeAsset {
  /** 逻辑资源身份，可用 prototype-asset:<id> 引用。 */
  id: string
  /** 用户可读名称。 */
  name: string
  /** SHA-256 内容身份。 */
  hash: string
  /** 经过内容检查的 MIME。 */
  mime: string
  /** 实际字节数。 */
  byteSize: number
  /** 导入时间。 */
  createdAt: number
}

/** 只陈述已执行的检查，结构检查不是实际点击回放。 */
export interface PrototypeCheck {
  /** 检查身份。 */
  id: string
  /** 对应原型版本。 */
  revision: number
  /** 结构校验或用户实际体验记录。 */
  kind: 'structure' | 'experience'
  /** 检查通过与否。 */
  passed: boolean
  /** 已发现的问题。 */
  issues: string[]
  /** 实际覆盖的页面路径；不能宣称覆盖未记录状态。 */
  visitedPageIds: string[]
  /** 检查时间。 */
  createdAt: number
}

/** 固定版本交给生产开发时使用的视口与视觉约束。 */
export interface PrototypeVisualContract {
  /** 设计验收时使用的固定预览尺寸。 */
  viewport: { width: number; height: number }
  /** 开发必须优先保持的视觉事实。 */
  preserve: string[]
}

/** 页面分组在开发交接包中的可读路径。 */
export interface PrototypeHandoffGroup {
  /** 稳定分组身份。 */
  id: string
  /** 分组显示名称。 */
  name: string
  /** 可选父分组身份。 */
  parentId?: string
  /** 从根分组到当前分组的显示路径。 */
  path: string
}

/** 交接包中的页面摘要；正文仍可通过 prototype_read_version 读取。 */
export interface PrototypeHandoffPage {
  /** 稳定页面身份。 */
  id: string
  /** 页面显示名称。 */
  name: string
  /** 所属分组身份。 */
  groupId: string
  /** 所属分组的完整显示路径。 */
  groupPath: string
  /** 页面 HTML 中声明的稳定元素身份。 */
  elementIds: string[]
  /** 从当前页面发出的交互连接身份。 */
  flowIds: string[]
}

/** 固定 revision 的开发交接包；只保存设计事实，不携带图片字节或本机路径。 */
export interface PrototypeHandoff {
  /** 交接包格式版本。 */
  schemaVersion: 1
  /** 交接包身份。 */
  id: string
  /** 原型身份。 */
  prototypeId: string
  /** 交接所依据的不可变版本。 */
  revision: number
  /** 生成时间（毫秒）。 */
  createdAt: number
  /** 原型名称。 */
  name: string
  /** 目标平台。 */
  platform: 'mobile' | 'desktop'
  /** 原型说明。 */
  brief: string
  /** 页面分组目录。 */
  groups: PrototypeHandoffGroup[]
  /** 页面结构与稳定元素身份。 */
  pages: PrototypeHandoffPage[]
  /** 唯一入口页。 */
  entryPageId: string
  /** 页面之间的交互连接。 */
  flows: PrototypeFlow[]
  /** 当前版本实际引用的资源元数据。 */
  assets: PrototypeAsset[]
  /** 从页面样式中提取的 CSS 自定义属性。 */
  designTokens: Record<string, string>
  /** 视觉开发和验收规则。 */
  visualContract: PrototypeVisualContract
  /** 不含交接包身份和时间的内容 hash。 */
  manifestHash: string
}

/** UI 首屏读取当前文档与轻量历史，不注入所有候选正文。 */
export interface PrototypeSnapshot {
  /** 当前已采纳内容。 */
  document: PrototypeDocument
  /** 已保留版本摘要。 */
  versions: PrototypeVersion[]
  /** 候选摘要。 */
  candidates: PrototypeCandidateSummary[]
  /** 项目素材元数据，内容按需读取。 */
  assets: PrototypeAsset[]
  /** 该原型的任务记录。 */
  jobs: PrototypeJob[]
  /** 当前/历史验证证据。 */
  checks: PrototypeCheck[]
}

/** 对现有项目的有界扫描结果，不代表已验证完整项目。 */
export interface PrototypeProjectInspection {
  /** 项目名称，不包含绝对路径。 */
  projectName: string
  /** 检测到的技术栈提示。 */
  frameworks: string[]
  /** 可选的页面、样式、组件和素材文件。 */
  files: Array<{ path: string; kind: 'html' | 'code' | 'style' | 'image'; byteSize: number }>
  /** 超预算/无法读取等提示。 */
  warnings: string[]
  /** 扫描是否被预算截断。 */
  truncated: boolean
}

/** 所有 UI 命令都携带会话，主进程据此解析项目根。 */
export interface InteractionDesignInputs {
  list: { sessionId: string }
  /** 页面入口可用 pageName 创建隐藏容器并直接生成首个页面；Agent 仍只传原型名称。 */
  create: { sessionId: string; name: string; platform: 'mobile' | 'desktop'; pageName?: string }
  load: { sessionId: string; prototypeId: string }
  save: { sessionId: string; prototypeId: string; baseRevision: number; draft: PrototypeDraft; summary: string }
  getVersion: { sessionId: string; prototypeId: string; revision: number }
  restore: { sessionId: string; prototypeId: string; baseRevision: number; revision: number }
  deleteVersion: { sessionId: string; prototypeId: string; baseRevision: number; revision: number }
  propose: { sessionId: string; prototypeId: string; baseRevision: number; draft: PrototypeDraft; summary: string; jobId?: string }
  getCandidate: { sessionId: string; prototypeId: string; candidateId: string }
  adopt: { sessionId: string; prototypeId: string; candidateId: string; baseRevision: number }
  discardCandidate: { sessionId: string; prototypeId: string; candidateId: string }
  beginJob: { sessionId: string; prototypeId: string; baseRevision: number; instruction: string; pageId?: string; elementId?: string }
  cancelJob: { sessionId: string; prototypeId: string; jobId: string }
  failJob: { sessionId: string; prototypeId: string; jobId: string; message: string }
  importAsset: { sessionId: string; prototypeId: string; relativePath: string }
  importMediaAsset: { sessionId: string; prototypeId: string; assetId: string; revision: number; hash: string }
  assetContent: { sessionId: string; prototypeId: string; assetId: string }
  inspectProject: { sessionId: string }
  readSource: { sessionId: string; paths: string[] }
  importHtml: { sessionId: string; prototypeId: string; baseRevision: number; relativePath: string; groupId?: string }
  exportHtml: { sessionId: string; prototypeId: string; revision: number }
  validate: { sessionId: string; prototypeId: string; revision: number }
  recordExperience: { sessionId: string; prototypeId: string; revision: number; visitedPageIds: string[] }
  createHandoff: { sessionId: string; prototypeId: string; revision: number }
}

/** IPC 返回类型与具体命令保持关联。 */
export interface InteractionDesignResults {
  list: PrototypeSummary[]
  create: PrototypeSnapshot
  load: PrototypeSnapshot
  save: PrototypeSnapshot
  getVersion: PrototypeDocument
  restore: PrototypeSnapshot
  deleteVersion: PrototypeSnapshot
  propose: PrototypeCandidateSummary
  getCandidate: PrototypeCandidate
  adopt: PrototypeSnapshot
  discardCandidate: PrototypeSnapshot
  beginJob: PrototypeJob
  cancelJob: PrototypeSnapshot
  failJob: PrototypeJob
  importAsset: PrototypeAsset
  importMediaAsset: PrototypeAsset
  assetContent: { assetId: string; dataUrl: string }
  inspectProject: PrototypeProjectInspection
  readSource: Array<{ path: string; hash: string; content: string }>
  importHtml: PrototypeCandidateSummary
  exportHtml: { deliveryId: string; fileName: string; html: string; revision: number }
  validate: PrototypeCheck
  recordExperience: PrototypeCheck
  createHandoff: PrototypeHandoff
}

/** 有限命令集合。 */
export type InteractionDesignMethod = keyof InteractionDesignInputs

/** 有关联的请求联合类型，运行时仍需严格解析。 */
export type InteractionDesignCommand = {
  [M in InteractionDesignMethod]: { method: M; input: InteractionDesignInputs[M] }
}[InteractionDesignMethod]

/** 模块变化信号只负责失效，不携带 HTML。 */
export interface InteractionDesignChanged {
  /** 项目归属。 */
  workspaceId: string
  /** 可选的受影响原型。 */
  prototypeId?: string
}

/** preload 对 renderer 暴露的类型安全接口。 */
export interface InteractionDesignApi {
  /** 执行受信主进程命令，错误交给当前局部面板呈现。 */
  invoke<M extends InteractionDesignMethod>(method: M, input: InteractionDesignInputs[M]): Promise<InteractionDesignResults[M]>
  /** 监听项目资料变化，调用返回值取消订阅。 */
  onChanged(callback: (event: InteractionDesignChanged) => void): () => void
}
