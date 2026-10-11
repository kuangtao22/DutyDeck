/** 工厂订阅及混合协议模型的独立文本调用：复用 Pi 认证与代理，不创建 Agent 会话或加载工具。 */
import type { CapabilityFactoryCallUsage } from '@proma/shared'
import { randomUUID } from 'node:crypto'
import type { Api, Model, ModelsSimpleStreamOptions } from '@earendil-works/pi-ai'
import type { CodexModelInput, XaiModelInput, GithubCopilotModelInput } from '../adapters/pi-model-registry'
import { buildModel, stripLegacyAgentSdkContextSuffix } from '../adapters/pi-model-registry'
import {
  extractPiResponseText, resolvePiTitleConnectionSettings,
  type PiTitleGenerationInput, type PiTitleRuntime, type PiTitleRequestEnvironment,
} from '../adapters/pi-title-generator'
import {
  closePiRequestProxyDispatcher, createPiRequestProxyDispatcher,
  installPiRequestProxyFetch, runWithPiRequestProxy,
} from '../adapters/pi-request-proxy'

/** 宿主读取完整订阅凭据并负责将刷新结果原子持久化。 */
export interface CapabilityFactorySubscriptionCredentials extends Omit<CodexModelInput & XaiModelInput & GithubCopilotModelInput, 'model' | 'channelId'> {}

/** 工厂保留场景采样参数，不继承自动标题的 50 token 和 30 秒限制。 */
export interface CapabilityFactoryPiInput extends PiTitleGenerationInput, CapabilityFactorySubscriptionCredentials {
  /** 场景声明的采样温度，包含合法的零。 */
  temperature?: number
  /** 场景声明的输出预算；缺省交由 Pi 模型配置决定。 */
  maxTokens?: number
  /** 发送前同步预留真实尝试，失败则不进入供应商。 */
  onBeforeSend?: () => void
  /** 只报告供应商实际返回的 usage。 */
  onUsage?: (usage: CapabilityFactoryCallUsage) => void
}

/** 一次文本生成所需参数；不接受工具和会话历史。 */
interface CapabilityFactoryPiRequest {
  /** 已合并格式说明的用户提示词。 */
  prompt: string
  /** 运行取消信号。 */
  signal?: AbortSignal
  /** 可选输出预算。 */
  maxTokens?: number
  /** 可选采样温度。 */
  temperature?: number
  /** 发送边界回调，不计入模型构建和凭据解析。 */
  onBeforeSend?: () => void
  /** 实际用量观察端；未知字段不估零。 */
  onUsage?: (usage: CapabilityFactoryCallUsage) => void
}

/** 执行一次文本请求，返回可见正文；所有终态均释放代理资源。 */
export async function completeCapabilityFactoryPiRequest(
  runtime: PiTitleRuntime,
  model: Model<Api>,
  input: CapabilityFactoryPiRequest,
  environment: PiTitleRequestEnvironment,
  transport: 'auto' | 'sse' = 'auto',
): Promise<string> {
  try {
    input.signal?.throwIfAborted()
    environment.installRequestProxyFetch()
    /** 请求标识仅用于传输隔离，不创建或持久化 Agent 会话。 */
    const options: ModelsSimpleStreamOptions = {
      sessionId: randomUUID(), transport, signal: input.signal, maxRetries: 0,
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    }
    /** 无工具、无历史的单轮上下文，避免工厂获得前台 Agent 的操作能力。 */
    const context = { messages: [{ role: 'user' as const, content: input.prompt, timestamp: Date.now() }] }
    /** Codex 显式关闭工具及推理；其他订阅协议使用 Pi 的最低推理开销路径。 */
    input.signal?.throwIfAborted()
    input.onBeforeSend?.()
    const response = await environment.runWithRequestProxy(environment.dispatcher, () => (
      model.api === 'openai-codex-responses'
        ? runtime.complete(model, context, { ...options, reasoningEffort: 'none', toolChoice: 'none' })
        : runtime.completeSimple(model, context, options)
    ))
    /** SDK 的实际响应可带 usage；标题端口类型刻意精简，因此这里按未知输入校验。 */
    const usage = extractCapabilityFactoryPiUsage((response as unknown as { usage?: unknown }).usage)
    if (usage) input.onUsage?.(usage)
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      throw new Error(response.errorMessage?.trim() || '工厂模型请求未完成')
    }
    /** 只返回用户可见正文，思考内容不作为结构化输出。 */
    const text = extractPiResponseText(response.content)
    if (!text.trim()) {
      /** 输出额度耗尽与正常空响应应提供不同诊断。 */
      const detail = response.stopReason === 'length' ? '生成额度已用尽'
        : response.content.some((block) => block.type === 'thinking') ? '只收到思考内容' : '收到空响应'
      throw new Error(`模型 ${model.id} 未返回正文（${detail}），请检查模型设置或更换模型后重试。`)
    }
    return text
  } finally {
    await environment.closeRequestProxyDispatcher(environment.dispatcher)
  }
}

/** 构建带 OAuth 刷新回调的 Pi runtime，并按现有代理选择规则执行工厂请求。 */
export async function callCapabilityFactoryPiModel(input: CapabilityFactoryPiInput): Promise<string> {
  input.signal?.throwIfAborted()
  /** 延迟加载 SDK，维持 Electron external 打包边界。 */
  const sdk = await import('@earendil-works/pi-coding-agent')
  /** 复用前台订阅 provider 目录与认证实现，避免将 OAuth token 当普通 API key 使用。 */
  const { modelRuntime, model } = await buildModel(sdk, {
    sessionId: randomUUID(), model: input.modelId, provider: input.provider,
    apiKey: input.apiKey, baseUrl: input.baseUrl, channelId: input.channelId, channelName: input.channelName,
    codexOAuthCredentials: input.codexOAuthCredentials,
    xaiOAuthCredentials: input.xaiOAuthCredentials,
    githubCopilotOAuthCredentials: input.githubCopilotOAuthCredentials,
    onCodexOAuthCredentialsRefreshed: input.onCodexOAuthCredentialsRefreshed,
    onXaiOAuthCredentialsRefreshed: input.onXaiOAuthCredentialsRefreshed,
    onGithubCopilotOAuthCredentialsRefreshed: input.onGithubCopilotOAuthCredentialsRefreshed,
  })
  /** 部分 provider 缺少目标目录项时会回退默认模型；工厂显式选择禁止静默替换。 */
  if (model.id !== stripLegacyAgentSdkContextSuffix(input.modelId)) {
    throw new Error(`未能使用指定模型 ${input.modelId}，请刷新渠道模型列表后重试。`)
  }
  /** 复用系统代理、环境代理和 NO_PROXY 选择。 */
  const connection = resolvePiTitleConnectionSettings(input.proxyUrl)
  /** 使用常规请求空闲超时，不施加自动标题的短截止时间。 */
  const dispatcher = createPiRequestProxyDispatcher({ proxyUrl: connection.proxyUrl, noProxy: connection.noProxy })
  return completeCapabilityFactoryPiRequest(modelRuntime as PiTitleRuntime, model, input, {
    dispatcher, installRequestProxyFetch: installPiRequestProxyFetch,
    runWithRequestProxy: runWithPiRequestProxy, closeRequestProxyDispatcher: closePiRequestProxyDispatcher,
  }, connection.transport)
}

/** 从 Pi 实际 usage 提取 token 数；缺字段或无效值返回 undefined，订阅金额不推断。 */
export function extractCapabilityFactoryPiUsage(value: unknown): CapabilityFactoryCallUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  /** 未经信任的供应商字段逐项校验。 */
  const fields = value as Record<string, unknown>
  const valid = (item: unknown): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0
  if (!valid(fields.input) || !valid(fields.output)) return undefined
  return { inputTokens: fields.input, outputTokens: fields.output,
    ...(valid(fields.cacheRead) ? { cacheReadTokens: fields.cacheRead } : {}),
    ...(valid(fields.cacheWrite) ? { cacheWriteTokens: fields.cacheWrite } : {}) }
}
