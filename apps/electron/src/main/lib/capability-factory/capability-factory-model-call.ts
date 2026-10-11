/**
 * 编排工厂的模型端口：把「场景声明的模型」落到**一个真实渠道**上发一次请求。
 *
 * 普通 API 复用 `getAdapter(provider) + streamSSE`；订阅及 OpenCode Go 混合协议渠道复用 Pi 链路，
 * 避免把订阅凭据误当作 API key。两条路径都只返回可见文本，不加载 Agent 工具或会话历史。
 * 这里只负责"挑渠道、解析凭据、走代理、把结果收成一次性文本"。
 *
 * 模型解析顺序（结果会写进运行记录，让"为什么跑的不是 gpt-5.4"有据可查）：
 * ① 用户明确指定渠道和模型时精确绑定，失效即报错；未指定则按场景声明匹配；
 * ② 找不到 → 用**当前会话正在用的渠道 + 模型**，并标记 `substituted`；
 * ③ 两者都没有 → 明确失败，不猜。
 */
import { createHash } from 'node:crypto'
import { stableCapabilityValueKey } from '@proma/shared'
import { getAdapter, streamSSE } from '@proma/core'
import type { CapabilityFactoryModelReference, CapabilityFactoryModelSelection, CapabilityRunModelBinding, CapabilitySceneDefinition, Channel } from '@proma/shared'
import type { CapabilityFactoryCallUsage } from '@proma/shared'
import type { CapabilityFactoryCallLedger } from './capability-factory-budget'
import { getFetchFn } from '../proxy-fetch'
import { callCapabilityFactoryPiModel, type CapabilityFactorySubscriptionCredentials } from './capability-factory-pi-call'
export type { CapabilityFactorySubscriptionCredentials } from './capability-factory-pi-call'

/** 一次模型调用请求（字段与 capability-runner 的 `ModelRequest` 对齐）。 */
export interface CapabilityFactoryModelInvocation {
  stepId: string
  /** 执行和评审共用实验账本；无账本的旧调用保持兼容。 */
  callLedger?: CapabilityFactoryCallLedger
  /** 真实调用目的，用于独立统计评审与执行。 */
  purpose?: 'execution' | 'review' | 'retry'
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
  /** 订阅渠道的完整 OAuth 凭据与刷新持久化回调。 */
  resolveSubscriptionCredentials?(channelId: string): Promise<CapabilityFactorySubscriptionCredentials>
  /** 系统代理地址；缺省表示直连。 */
  resolveProxyUrl(): Promise<string | undefined>
  /** 会话正在用的渠道与模型；没有则为 null（临时会话 / 未选模型）。 */
  sessionModel(): { channelId: string; modelId: string } | null
}

/** 声明模型与实际模型的对应关系，用来解释"为什么跑的不是这个模型"。 */
export interface CapabilityFactoryModelResolution {
  /** 使用渠道的非敏感执行配置指纹；凭据仅由渠道更新时间表达版本，不读取密钥。 */
  configurationFingerprint?: string
  bindings: CapabilityRunModelBinding[]
  /** 可选的独立评审绑定，与执行槽位一起冻结；缺省复用各步骤的执行模型。 */
  reviewBinding?: CapabilityRunModelBinding
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

/** 输入明确的模型引用和渠道快照，返回精确启用的渠道；失效时拒绝替换。 */
function requireSelectedChannel(reference: CapabilityFactoryModelReference, channels: Channel[]): Channel {
  /** 渠道身份必须精确匹配，同名模型不能跨渠道代替用户选择。 */
  const channel = channels.find((item) => item.id === reference.channelId && item.enabled)
  if (!channel || !channel.models.some((model) => model.id === reference.modelId && model.enabled)) {
    throw new Error('所选渠道或模型已不可用，请在「模型设置」中重新选择。')
  }
  return channel
}

/** 保存前复核用户明确选择的所有模型；自动匹配项留到执行时按会话解析。 */
export function validateCapabilityFactoryModelSelection(selection: CapabilityFactoryModelSelection, channels: Channel[]): void {
  for (const reference of Object.values(selection.slots)) requireSelectedChannel(reference, channels)
  if (selection.review) requireSelectedChannel(selection.review, channels)
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
  /** 完整验证明确配置后再解析，避免只执行前几个仍可用的槽位。 */
  const selection = definition.modelSelection
  try {
    if (selection) validateCapabilityFactoryModelSelection(selection, channels)
  } catch (error) {
    return { bindings: [], error: error instanceof Error ? error.message : String(error) }
  }
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
    /** 显式选择不经过名称归一化或模糊匹配。 */
    const selected = selection?.slots[slot.id]
    if (selected) {
      const channel = requireSelectedChannel(selected, channels)
      bindings.push({ slotId: slot.id, declaredModel: slot.model, channelId: channel.id,
        channelName: channel.name, modelId: selected.modelId, substituted: false })
      continue
    }
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

  /** 评审渠道单独记录，不能混进用于执行的槽位列表。 */
  const review = selection?.review
  /** 执行及独立评审渠道共同进入身份；排序消除渠道清单顺序造成的假漂移。 */
  const usedChannelIds = new Set([...bindings.map((binding) => binding.channelId), ...(review ? [review.channelId] : [])])
  /** 当前 Channel 合同的请求配置只有 provider/baseUrl/models，新增请求字段时同步扩展此白名单。 */
  const configurations = channels.filter((channel) => usedChannelIds.has(channel.id)).map((channel) => ({
    id: channel.id,
    provider: channel.provider,
    baseUrl: channel.baseUrl,
    enabled: channel.enabled,
    credentialConfigurationUpdatedAt: channel.updatedAt,
    models: channel.models.filter((model) => model.enabled).map((model) => ({ id: model.id, enabled: model.enabled })).sort((left, right) => left.id.localeCompare(right.id)),
  })).sort((left, right) => left.id.localeCompare(right.id))
  /** 只持久化不可逆摘要，绝不把 apiKey 或 OAuth 凭据值纳入配置材料。 */
  const configurationFingerprint = createHash('sha256').update(stableCapabilityValueKey(configurations)).digest('hex')
  return { bindings, configurationFingerprint, ...(review ? { reviewBinding: {
    slotId: '__factory_review__', declaredModel: review.modelId, modelId: review.modelId,
    channelId: review.channelId, channelName: requireSelectedChannel(review, channels).name, substituted: false,
  } } : {}) }
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
    /** 在读取异步凭据前锁定调用额度；失败也不退还可能已发生的成本。 */
    const ledger = invocation.callLedger
    /** 预留身份用于把多个传输尝试归入同一次逻辑调用。 */
    const reservation = ledger?.reserve({ ...invocation, purpose: invocation.purpose ?? 'execution' })
    /** Pi 返回的实际 token 用量；普通 SSE 当前没有 usage 合同。 */
    let usage: CapabilityFactoryCallUsage | undefined
    /** 成功返回前统一结算，不把未知金额视为零。 */
    const complete = (text: string, model: string) => {
      if (reservation) ledger!.settle(reservation, { status: 'completed', usage })
      return { text, model }
    }
    try {
      const channels = deps.listChannels()
      const channel = channels.find((item) => item.id === invocation.channelId && item.enabled)
      if (!channel) {
        throw new Error(`渠道不存在或已停用：${invocation.channelId}，无法执行这一步`)
      }
      /** 运行前再次检查模型启用状态，防止预检后渠道设置发生变化。 */
      const modelId = invocation.modelId
      if (!channel.models.some((model) => model.id === modelId && model.enabled)) {
        throw new Error(`模型不存在或已停用：${modelId}，无法执行这一步`)
      }
      invocation.signal.throwIfAborted()
      /** 格式说明由 runner 单独给出：这里是唯一一次把它拼进真实提示词的地方。 */
      const userMessage = invocation.formatInstruction
        ? `${invocation.prompt}\n\n${invocation.formatInstruction}`
        : invocation.prompt
      /** 订阅认证必须走 Pi；OpenCode Go 同渠道混合协议也依赖 Pi 模型目录。 */
      const subscription = channel.provider === 'openai-codex' || channel.provider === 'github-copilot' || channel.provider === 'xai'
      if (subscription || channel.provider === 'opencode-go-openai') {
        if (subscription && !deps.resolveSubscriptionCredentials) throw new Error('订阅渠道认证未配置，无法执行这一步')
        /** 仅订阅渠道读取完整 OAuth 凭据；OpenCode Go 保留普通 API key 认证。 */
        const credentials = subscription ? await deps.resolveSubscriptionCredentials!(channel.id) : {}
        /** OpenCode Go 按模型选择 Messages 或 Responses，不能固定使用 Chat Completions。 */
        const text = await callCapabilityFactoryPiModel({
          ...credentials, channelId: channel.id, channelName: channel.name, provider: channel.provider,
          modelId, baseUrl: channel.baseUrl, apiKey: subscription ? '' : await deps.resolveApiKey(channel.id), prompt: userMessage,
          signal: invocation.signal, temperature: invocation.temperature, maxTokens: invocation.maxTokens,
          proxyUrl: await deps.resolveProxyUrl(),
          onBeforeSend: () => { invocation.signal.throwIfAborted(); if (reservation) ledger!.markSent(reservation, invocation.signal, true) },
          onUsage: (actual) => { usage = actual },
        })
        return complete(text, modelId)
      }
      /** 普通 API 渠道凭据与协议解析沿用已验证的链路。 */
      const apiKey = await deps.resolveApiKey(channel.id)
      /** 与当前渠道匹配的普通 API 适配器。 */
      const adapter = getAdapter(channel.provider)
      const request = adapter.buildStreamRequest({
        baseUrl: channel.baseUrl,
        apiKey,
        modelId,
        history: [],
        userMessage,
        thinkingEnabled: false,
        ...(invocation.temperature === undefined ? {} : { temperature: invocation.temperature }),
        ...(invocation.maxTokens === undefined ? {} : { maxTokens: invocation.maxTokens }),
        /** 工厂这一层不处理附件：图片输入属于运行输入契约的事，等有场景真的需要再接。 */
        readImageAttachments: () => [],
      })
      /** 仅工厂包装 fetch，逐次观察 SSE 在首事件前的内部重试。 */
      const transport = getFetchFn(await deps.resolveProxyUrl()) ?? globalThis.fetch
      /** 包装仅作用于此次工厂调用，不改变聊天的全局重试策略。 */
      const meteredFetch: typeof fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
        invocation.signal.throwIfAborted()
        try {
          if (reservation) ledger!.markSent(reservation, invocation.signal)
        } catch (error) {
          /** 本地预算/持久化拒绝不是网络瞬态错误，禁止 SSE 继续等待重试。 */
          throw new DOMException(error instanceof Error ? error.message : String(error), 'AbortError')
        }
        return transport(...args)
      }, { preconnect: globalThis.fetch.preconnect })
      const response = await streamSSE({
        request,
        adapter,
        signal: invocation.signal,
        fetchFn: meteredFetch,
        onEvent: () => undefined,
      })
      if (!response.content.trim()) {
        /** 只描述返回形态，不暴露正文或思考内容，也不把传输失败归为 JSON 校验失败。 */
        const detail = response.stopReason === 'max_tokens'
          ? '生成额度已用尽'
          : response.reasoning.trim() ? '只收到思考内容' : '收到空响应'
        throw new Error(`模型 ${modelId} 未返回正文（${detail}），请检查模型设置或更换模型后重试。`)
      }
      return complete(response.content, modelId)
    } catch (error) {
      if (reservation && ledger!.snapshot().find((record) => record.id === reservation)?.status === 'reserved') {
        ledger!.settle(reservation, { status: invocation.signal.aborted ? 'cancelled' : 'failed', usage })
      }
      throw error
    }
  }
}
