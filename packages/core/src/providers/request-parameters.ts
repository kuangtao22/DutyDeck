import {
  getModelCapabilities,
  getModelReasoningCapability,
  normalizeReasoningCapabilityLevel,
  resolveReasoningProfile,
  type AgentThinkingLevel,
  type ProviderType,
  type ReasoningEncoding,
  type ReasoningTransport,
} from '@proma/shared'

/** 适配器构造请求时使用的已归一化思考参数。 */
export interface ProviderReasoningRequest {
  /** 当前模型在能力约束下最终是否启用思考。 */
  enabled: boolean
  /** 当前模型支持的最终产品档位。 */
  level: AgentThinkingLevel
  /** 已按协议 profile 编译的 effort；无 profile 时等于归一化档位。 */
  effort?: string
  /** 已验证的模型专属协议编码。 */
  encoding?: ReasoningEncoding
  /** 模型是否声明 toggle 控制。 */
  supportsToggle: boolean
  /** 模型是否声明 effort 控制。 */
  supportsEffort: boolean
  /** 模型是否声明 token budget 控制。 */
  supportsBudgetTokens: boolean
  /** 按能力边界和产品档位换算的 token budget。 */
  budgetTokens?: number
  /** 开启预算思考时必须保留的最低 token 数。 */
  minimumBudgetTokens?: number
  /** 快照声明的最大输出 token，用于约束共享输出与思考预算。 */
  maxOutputTokens?: number
}

/** 请求参数编译器需要的最小输入。 */
export interface ResolveProviderReasoningRequestInput {
  provider: ProviderType
  modelId: string
  transport: ReasoningTransport
  thinkingEnabled?: boolean
  thinkingLevel?: AgentThinkingLevel
}

/** 将数值限制在模型声明的 token budget 范围内。 */
function clampBudget(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

/** 按产品思考档位换算 token budget，并服从模型声明的最小值与最大值。 */
function resolveBudgetTokens(
  level: AgentThinkingLevel,
  option: { min?: number; max?: number },
): number | undefined {
  const minimum = Math.max(0, option.min ?? 0)
  const maximum = Math.max(minimum, option.max ?? 16384)
  if (level === 'off') return minimum === 0 ? 0 : minimum

  const ratioByLevel: Partial<Record<AgentThinkingLevel, number>> = {
    minimal: 0.125,
    low: 0.25,
    medium: 0.5,
    high: 0.75,
    xhigh: 0.875,
    max: 1,
  }
  if (level === 'minimal' && minimum > 0) return minimum
  const ratio = ratioByLevel[level] ?? 0.75
  return clampBudget(maximum * ratio, minimum, maximum)
}

/**
 * 根据共享模型快照和 reasoning profile 编译单次请求的有效思考参数。
 *
 * 缺少快照时继续使用已有 profile；既无快照也无 profile 时返回 undefined，
 * 由各适配器保留原有兼容行为。
 */
export function resolveProviderReasoningRequest(
  input: ResolveProviderReasoningRequestInput,
): ProviderReasoningRequest | undefined {
  if (input.thinkingEnabled === undefined && input.thinkingLevel === undefined) return undefined

  const modelCapabilities = getModelCapabilities(input.provider, input.modelId)
  const reasoningCapability = getModelReasoningCapability(input.provider, input.modelId)
  const profile = resolveReasoningProfile({
    provider: input.provider,
    modelId: input.modelId,
    transport: input.transport,
  })
  if (modelCapabilities?.reasoning === false || (!reasoningCapability && !profile)) return undefined

  const requestedLevel = input.thinkingEnabled === false
    ? 'off'
    : input.thinkingLevel ?? reasoningCapability?.defaultLevel ?? profile?.defaultLevel ?? 'high'
  const capabilityLevel = normalizeReasoningCapabilityLevel(reasoningCapability, requestedLevel) ?? requestedLevel
  const profileLevel = profile?.normalize(capabilityLevel) ?? capabilityLevel
  const level = normalizeReasoningCapabilityLevel(reasoningCapability, profileLevel) ?? profileLevel
  const encoding = profile?.encodings[input.transport]
  const mappedEffort = encoding?.effortMap[level]
  const reasoningOptions = modelCapabilities?.reasoningOptions ?? []
  const effortOption = reasoningOptions.find((option) => option.type === 'effort')
  const effort = mappedEffort === null
    ? undefined
    : mappedEffort ?? (level === 'off' && effortOption?.values.includes('none') ? 'none' : level)
  const budgetOption = reasoningOptions.find((option) => option.type === 'budget_tokens')
  const supportsToggle = reasoningOptions.some((option) => option.type === 'toggle')
  const budgetTokens = level === 'off' && supportsToggle
    ? 0
    : budgetOption ? resolveBudgetTokens(level, budgetOption) : undefined

  return {
    enabled: level !== 'off',
    level,
    effort,
    ...(encoding ? { encoding } : {}),
    supportsToggle,
    supportsEffort: effortOption !== undefined,
    supportsBudgetTokens: budgetOption !== undefined,
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(budgetOption?.min !== undefined ? { minimumBudgetTokens: budgetOption.min } : {}),
    ...(modelCapabilities?.maxOutputTokens !== undefined
      ? { maxOutputTokens: modelCapabilities.maxOutputTokens }
      : {}),
  }
}

/**
 * 校验显式输出上限，并在适配器需要协议默认值时限制默认值不超过模型能力。
 * 未知模型没有快照上限，继续保留调用方原值。
 */
export function resolveMaxTokens(
  provider: ProviderType,
  modelId: string,
  requested: number | undefined,
  fallback?: number,
): number | undefined {
  if (requested !== undefined && (!Number.isFinite(requested) || !Number.isInteger(requested) || requested <= 0)) {
    throw new RangeError(`maxTokens 必须是正整数，收到 ${String(requested)}`)
  }

  const maximum = getModelCapabilities(provider, modelId)?.maxOutputTokens
  if (requested !== undefined) {
    if (maximum !== undefined && requested > maximum) {
      throw new RangeError(`maxTokens ${requested} 超过模型 ${modelId} 的最大输出上限 ${maximum}`)
    }
    return requested
  }
  if (fallback === undefined) return undefined
  return maximum === undefined ? fallback : Math.min(fallback, maximum)
}

/** 模型明确禁止 temperature 时丢弃调用方温度；缺少快照时保持原透传行为。 */
export function supportsTemperature(provider: ProviderType, modelId: string): boolean {
  return getModelCapabilities(provider, modelId)?.temperature !== false
}

/** 返回快照声明的思考支持状态；undefined 表示缺少快照，调用方应保留兼容逻辑。 */
export function getDeclaredReasoningSupport(
  provider: ProviderType,
  modelId: string,
): boolean | undefined {
  return getModelCapabilities(provider, modelId)?.reasoning
}
