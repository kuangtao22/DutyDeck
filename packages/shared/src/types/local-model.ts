/**
 * DutyDeck 内置本地模型的共享契约。
 *
 * 模型文件和运行时都由主进程管理；渲染进程只接收这些脱敏快照，不能得到
 * 绝对文件路径、命令行参数或 llama-server 的短期认证令牌。
 */

export const DUTYDECK_LOCAL_PROVIDER = 'dutydeck-local' as const

export type LocalModelLifecycleState =
  | 'not-installed'
  | 'downloading'
  | 'verifying'
  | 'installed'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'

export type LocalModelCapabilityState = 'unknown' | 'available' | 'unavailable'

export type LocalModelRuntimeState = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

/** llama.cpp 受管环境的生命周期；环境独立于具体 GGUF 模型安装。 */
export type LocalModelEngineState = 'not-installed' | 'downloading' | 'verifying' | 'installing' | 'installed' | 'error'

/** renderer 可见的引擎安装摘要，不包含路径、命令参数或下载凭据。 */
export interface LocalModelEngineSnapshot {
  state?: LocalModelEngineState
  available: boolean
  version?: string
  platform?: string
  arch?: string
  source?: 'user' | 'bundled' | 'none'
  sizeBytes?: number
  downloadedBytes?: number
  message?: string
}

/** 清单中可下载模型的静态信息。 */
export interface LocalModelCatalogEntry {
  /** 不可变资产标识；同名模型的不同 revision 必须使用不同 ID。 */
  assetId: string
  /** 传给 OpenAI 兼容端点的模型 ID。 */
  modelId: string
  /** 用户可见名称。 */
  name: string
  /** 模型家族，例如 qwen 或 gemma。 */
  family: string
  /** GGUF 文件架构标识。 */
  architecture: string
  /** 量化方式，例如 Q4_K_M。 */
  quantization: string
  /** 下载来源的不可变 revision。 */
  revision: string
  /** GGUF 下载地址。 */
  downloadUrl: string
  /** 下载完成后必须匹配的 SHA-256。 */
  sha256: string
  /** 文件字节数。 */
  sizeBytes: number
  /** 启动时的最低磁盘空间估算。 */
  diskBytes: number
  /** 权重和 KV cache 的保守运行内存估算。 */
  memoryBytes: number
  /** 模型许可标识。 */
  license: string
  /** 该模型已知的上下文窗口上限。 */
  contextWindow: number
  /** 该模型已知的最大输出 token 数。 */
  maxTokens: number
  /** 目录要求的 chat template。 */
  chatTemplate?: string
}

/** 能力探测证据；只在输入快照仍匹配时有效。 */
export interface LocalModelCapabilityEvidence {
  state: LocalModelCapabilityState
  checkedAt?: number
  /** 探测使用的模型文件哈希。 */
  assetSha256?: string
  /** 探测使用的 llama-server 版本。 */
  engineVersion?: string
  /** 探测使用的模板标识。 */
  chatTemplate?: string
  /** 探测协议版本，发生探测逻辑变更时递增。 */
  probeVersion?: number
  /** 探测时使用的上下文窗口，清单变化后旧证据立即失效。 */
  contextWindow?: number
  /** 不可用时的稳定诊断码。 */
  reason?: 'load-failed' | 'chat-failed' | 'tool-call-failed' | 'json-failed' | 'memory'
}

/** 已下载模型的持久化摘要。 */
export interface LocalModelAsset {
  assetId: string
  modelId: string
  name: string
  family: string
  revision: string
  fileName: string
  sha256: string
  sizeBytes: number
  status: LocalModelLifecycleState
  enabled: boolean
  capability: LocalModelCapabilityEvidence
  installedAt?: number
  updatedAt: number
  lastError?: string
}

/** 主进程运行时的脱敏快照。 */
export interface LocalModelRuntimeSnapshot {
  /** 任务引用、能力测试或模型切换期间为 true。 */
  busy?: boolean
  state: LocalModelRuntimeState
  /** 当前加载的 assetId；idle/error 时可为空。 */
  assetId?: string
  /** 健康检查成功后才为 true。 */
  endpointReady: boolean
  engineVersion?: string
  backend?: 'cpu' | 'metal' | 'cuda' | 'vulkan' | 'unknown'
  message?: string
}

/** 发送到 renderer 的完整本地模型视图。 */
export interface LocalModelSnapshot {
  /** 受信发行资源的就绪情况，不包含引擎路径。 */
  engine?: LocalModelEngineSnapshot
  catalog: LocalModelCatalogEntry[]
  assets: LocalModelAsset[]
  runtime: LocalModelRuntimeSnapshot
  updatedAt: number
}

export interface LocalModelDownloadInput {
  assetId: string
}

export interface LocalModelAssetInput {
  assetId: string
}

export interface LocalModelEnabledInput extends LocalModelAssetInput {
  enabled: boolean
}

export interface LocalModelTestInput {
  assetId: string
  prompt: string
  /** 测试是否要求工具调用往返。 */
  includeToolCall?: boolean
  /** 测试是否要求 JSON 输出。 */
  includeJson?: boolean
}

export interface LocalModelTestResult {
  success: boolean
  assetId: string
  reply?: string
  toolCallSupported?: boolean
  jsonSupported?: boolean
  capability: LocalModelCapabilityEvidence
  message: string
}

export interface LocalModelProgressEvent {
  assetId: string
  state: Extract<LocalModelLifecycleState, 'downloading' | 'verifying'>
  completedBytes?: number
  totalBytes?: number
  message?: string
}

/** 本地模型相关 IPC 通道。 */
export const LOCAL_MODEL_IPC_CHANNELS = {
  LIST: 'local-model:list',
  DOWNLOAD: 'local-model:download',
  CANCEL_DOWNLOAD: 'local-model:cancel-download',
  START: 'local-model:start',
  STOP: 'local-model:stop',
  TEST: 'local-model:test',
  SET_ENABLED: 'local-model:set-enabled',
  ENGINE_DOWNLOAD: 'local-model:engine-download',
  ENGINE_CANCEL_DOWNLOAD: 'local-model:engine-cancel-download',
  PROGRESS: 'local-model:progress',
  CHANGED: 'local-model:changed',
} as const

export type LocalModelIpcChannel = typeof LOCAL_MODEL_IPC_CHANNELS[keyof typeof LOCAL_MODEL_IPC_CHANNELS]
