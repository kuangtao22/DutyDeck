/**
 * 编排工厂的模型端口：把「场景声明的模型」落到**一个真实渠道**上发一次请求。
 *
 * 为什么不自己写一套 provider 调用：仓库已有 `getAdapter(provider) + streamSSE` 这条成熟链路
 * （vision-relay 用的是同一条），各协议的请求体构造、SSE 解析、思考块处理都在适配器里。
 * 这里只负责"挑渠道、解密凭据、走代理、把流收成一次性文本"。
 *
 * 模型解析顺序（结果会写进运行记录，让"为什么跑的不是 gpt-5.4"有据可查）：
 * ① 场景槽位声明的模型名在本机某个启用渠道里找到 → 用它；
 * ② 找不到 → 用**当前会话正在用的渠道 + 模型**，并标记 `substituted`；
 * ③ 两者都没有 → 明确失败，不猜。
 */
import { getAdapter, streamSSE } from '@proma/core'
import type { CapabilityRunModelBinding, CapabilitySceneDefinition, Channel } from '@proma/shared'
import { getFetchFn } from '../proxy-fetch'

/** 一次模型调用请求（字段与 capability-runner 的 `ModelRequest` 对齐）。 */
export interface CapabilityFactoryModelInvocation {
  stepId: string
  /** 场景槽位声明的模型名；只用于记录与报错。 */
  model: string
  /**
   * **解析后的**渠道与模型。必须由调用方（运行适配器）按 `resolveCapabilityFactoryModels`
   * 的结果传进来：声明值可能只是模板默认值，端口如果拿声明值去渠道里找，永远找不到。
   */
  channelId: string
  modelId: string
  temperature?: number
  maxTokens?: number
  prompt: string
  formatInstruction?: string
  signal: AbortSignal
}

/** 模型调用端口：返回真实文本与被调用的模型名（轨迹里显示后者）。 */
export interface CapabilityFactoryModelCall {
  (invocation: CapabilityFactoryModelInvocation): Promise<{ text: string; model: string }>
}

/** 运行依赖的宿主能力；注入是为了让 runner 能在 bun test 里离线跑。 */
export interface CapabilityFactoryModelCallDeps {
  /** 当前可用渠道（含模型清单）。 */
  listChannels(): Channel[]
  /** 解密渠道凭据；失败即视为该渠道不可用。 */
  resolveApiKey(channelId: string): Promise<string>
  /** 系统代理地址；缺省表示直连。 */
  resolveProxyUrl(): Promise<string | undefined>
  /** 会话正在用的渠道与模型；没有则为 null（临时会话 / 未选模型）。 */
  sessionModel(): { channelId: string; modelId: string } | null
}

/** 声明模型与实际模型的对应关系，用来解释"为什么跑的不是这个模型"。 */
export interface CapabilityFactoryModelResolution {
  bindings: CapabilityRunModelBinding[]
  /** 非空表示无法解析，运行应当在调用模型之前就失败。 */
  error?: string
}

/** 归一化模型名：忽略大小写、空格与常见分隔符差异。 */
function normalizeModelId(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-')
}

/** 渠道里可用于运行的模型（只取启用中的）。 */
function enabledModelIds(channel: Channel): string[] {
  return channel.models.filter((model) => model.enabled).map((model) => model.id)
}

/**
 * 把场景的模型槽位解析成具体渠道 + 模型。
 *
 * @param definition 场景定义（读取 modelSlots）
 * @param channels 本机渠道清单
 * @param sessionModel 当前会话正在用的渠道与模型
 * @returns 每个槽位的绑定结果；无法解析时带 `error`
 */
export function resolveCapabilityFactoryModels(
  definition: CapabilitySceneDefinition,
  channels: Channel[],
  sessionModel: { channelId: string; modelId: string } | null,
): CapabilityFactoryModelResolution {
  const usable = channels.filter((channel) => channel.enabled && enabledModelIds(channel).length > 0)
  if (usable.length === 0) {
    return { bindings: [], error: '本机没有可用的模型渠道：请先在「设置 > 渠道」里配置并启用一个渠道。' }
  }

  /** 会话正在用的渠道；它已经不可用时按"没有会话模型"处理。 */
  const sessionChannel = sessionModel
    ? usable.find((channel) => channel.id === sessionModel.channelId)
    : undefined

  const bindings: CapabilityRunModelBinding[] = []
  for (const slot of definition.modelSlots) {
    const wanted = normalizeModelId(slot.model)
    const matched = usable.find((channel) =>
      enabledModelIds(channel).some((id) => {
        const current = normalizeModelId(id)
        return current === wanted || current.includes(wanted) || wanted.includes(current)
      }))

    if (matched) {
      const modelId = enabledModelIds(matched).find((id) => {
        const current = normalizeModelId(id)
        return current === wanted || current.includes(wanted) || wanted.includes(current)
      }) as string
      bindings.push({
        slotId: slot.id, declaredModel: slot.model,
        channelId: matched.id, channelName: matched.name, modelId, substituted: false,
      })
      continue
    }

    /** 声明值大概率是模板默认值（例如 createEmptySceneDefinition 里的 gpt-5.4）：改用会话模型并记明。 */
    if (sessionChannel && sessionModel) {
      const modelId = enabledModelIds(sessionChannel).includes(sessionModel.modelId)
        ? sessionModel.modelId
        : enabledModelIds(sessionChannel)[0] as string
      bindings.push({
        slotId: slot.id, declaredModel: slot.model,
        channelId: sessionChannel.id, channelName: sessionChannel.name, modelId, substituted: true,
      })
      continue
    }

    return {
      bindings,
      error: `模型槽位 ${slot.id} 声明的模型「${slot.model}」在本机渠道里找不到，当前会话也没有可用模型：`
        + '请先在「设置 > 渠道」里添加该模型，或让 Agent 把场景的 modelSlots 改成实际模型。',
    }
  }

  return { bindings }
}

/**
 * 创建模型调用端口。
 *
 * @param deps 渠道、凭据、代理与会话模型
 * @returns 可直接注入 runner 的 `callModel`
 */
export function createCapabilityFactoryModelCall(
  deps: CapabilityFactoryModelCallDeps,
): CapabilityFactoryModelCall {
  return async (invocation) => {
    const channels = deps.listChannels()
    const channel = channels.find((item) => item.id === invocation.channelId && item.enabled)
    if (!channel) {
      throw new Error(`渠道不存在或已停用：${invocation.channelId}，无法执行这一步`)
    }
    const modelId = invocation.modelId

    const apiKey = await deps.resolveApiKey(channel.id)
    const adapter = getAdapter(channel.provider)
    /** 格式说明由 runner 单独给出：这里是唯一一次把它拼进真实提示词的地方。 */
    const userMessage = invocation.formatInstruction
      ? `${invocation.prompt}\n\n${invocation.formatInstruction}`
      : invocation.prompt
    const request = adapter.buildStreamRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId,
      history: [],
      userMessage,
      thinkingEnabled: false,
      /** 工厂这一层不处理附件：图片输入属于运行输入契约的事，等有场景真的需要再接。 */
      readImageAttachments: () => [],
    })
    const response = await streamSSE({
      request,
      adapter,
      signal: invocation.signal,
      fetchFn: getFetchFn(await deps.resolveProxyUrl()),
      onEvent: () => undefined,
    })
    if (!response.content.trim()) {
      /** 只描述返回形态，不暴露正文或思考内容，也不把传输失败归为 JSON 校验失败。 */
      const detail = response.stopReason === 'max_tokens'
        ? '生成额度已用尽'
        : response.reasoning.trim() ? '只收到思考内容' : '收到空响应'
      throw new Error(`模型 ${modelId} 未返回正文（${detail}），请检查模型设置或更换模型后重试。`)
    }
    return { text: response.content, model: modelId }
  }
}
