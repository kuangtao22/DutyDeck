import { isGpt6AstraFamily, isGpt6LunaFamily, isGpt6SolFamily } from '../utils/model-family'
import { getModelCapabilities, getModelReasoningCapability } from '../utils/model-capabilities'
import type { ProviderType } from './channel'
import type { AgentThinkingLevel } from './agent'

/** Proma 可识别的 reasoning 请求协议族。 */
export type ReasoningTransport =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'openai-responses'
  | 'other'

/**
 * 将渠道归类到其实际的 reasoning 请求协议。
 *
 * 渠道名不能直接决定请求字段；profile 必须同时匹配模型 ID 和 transport，
 * 才能避免把 OpenAI 的 reasoning_effort 发送到 Anthropic endpoint。
 */
export function inferReasoningTransport(provider: ProviderType | undefined): ReasoningTransport {
  switch (provider) {
    case 'openai':
    case 'opencode-go-openai':
    case 'zhipu':
    case 'doubao':
    case 'doubao-api':
    case 'qwen':
    case 'custom':
      return 'openai-completions'
    case 'openai-codex':
    case 'openai-responses':
    case 'xai':
      return 'openai-responses'
    case 'google':
      return 'other'
    default:
      return 'anthropic-messages'
  }
}

/** 编译器据此生成 runtime 专属请求参数。 */
export type ReasoningEncodingKind =
  | 'adaptive-effort'
  | 'deepseek-output-effort'
  | 'openai-reasoning-effort'
  | 'zai-thinking-effort'

/** 每个产品等级映射为目标协议可接受的 effort 值。 */
export type ReasoningEffortMap = Partial<Record<AgentThinkingLevel, string | null>>

export interface ReasoningEncoding {
  kind: ReasoningEncodingKind
  effortMap: ReasoningEffortMap
}

export interface ReasoningProfile {
  id: 'deepseek-v4-flash' | 'deepseek-flash' | 'deepseek-v4-pro' | 'kimi-k3' | 'glm-5.2' | 'glm-5.3' | 'openai-reasoning-standard' | 'openai-reasoning-max' | 'openai-reasoning-astra' | 'openai-reasoning-sol-luna'
  levels: readonly AgentThinkingLevel[]
  defaultLevel: AgentThinkingLevel
  normalize(level: AgentThinkingLevel | undefined): AgentThinkingLevel
  encodings: Partial<Record<ReasoningTransport, ReasoningEncoding>>
}

/** Pi model catalog 中与会话级 reasoning 选择有关的最小元数据。 */
export interface PiCatalogReasoningMetadata {
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<AgentThinkingLevel, string | null>>
}

/**
 * 可跨主进程和渲染进程传输的 reasoning capability。
 *
 * 不携带 protocol encoding；Pi catalog 继续负责把所选 level 编码为实际请求字段。
 */
export interface ReasoningCapability {
  source: 'profile' | 'pi-catalog' | 'models-dev'
  levels: readonly AgentThinkingLevel[]
  defaultLevel: AgentThinkingLevel
}

export interface ResolveReasoningCapabilityInput {
  profile?: ReasoningProfile
  catalog?: PiCatalogReasoningMetadata
}

export interface ResolveReasoningProfileInput {
  modelId: string | undefined
  transport: ReasoningTransport
  /** 已知渠道优先使用自身目录，缺省时仅对已有协议 profile 做模型级兼容。 */
  provider?: ProviderType
}

const DEEPSEEK_V4_LEVELS = ['off', 'low', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
const K3_LEVELS = ['low', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
const GLM_52_LEVELS = ['high', 'max'] as const satisfies readonly AgentThinkingLevel[]
const GLM_53_LEVELS = ['low', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
/**
 * GLM-5.3 强制开启思考，深度由 reasoning_effort / output_config.effort 控制。
 * Coding Plan 会把历史开关输入映射为 low，故不向运行时暴露 off。
 */
const GLM_53_EFFORT_MAP: ReasoningEffortMap = {
  low: 'low',
  high: 'high',
  max: 'max',
}
const OPENAI_STANDARD_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly AgentThinkingLevel[]
const OPENAI_MAX_LEVELS = [...OPENAI_STANDARD_LEVELS, 'max'] as const satisfies readonly AgentThinkingLevel[]

// DeepSeek Anthropic 兼容接口使用 output_config.effort；Flash/Pro 都支持 low，
// 历史 xhigh 别名分别归一为 high/max。关闭由 thinking.type=disabled 编码。
const DEEPSEEK_V4_FLASH_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: 'high',
  max: 'max',
}
const DEEPSEEK_V4_PRO_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const K3_EFFORT_MAP: ReasoningEffortMap = {
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const GLM_52_OPENAI_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const GLM_52_ANTHROPIC_EFFORT_MAP: ReasoningEffortMap = {
  minimal: 'high',
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

// Pi uses this sparse map as an override for its native level mapping. In particular,
// off must become none because OpenAI reasoning models otherwise default to medium.
const OPENAI_STANDARD_EFFORT_MAP: ReasoningEffortMap = {
  off: 'none',
  minimal: 'low',
  xhigh: 'xhigh',
}
const OPENAI_MAX_EFFORT_MAP: ReasoningEffortMap = {
  ...OPENAI_STANDARD_EFFORT_MAP,
  max: 'max',
}

function normalizeDeepSeekV4Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'off':
      return 'off'
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
      return 'high'
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

function normalizeK3Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'off':
      return 'high'
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

function normalizeGlm52Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  return level === 'xhigh' || level === 'max' ? 'max' : 'high'
}

function normalizeGlm53Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'minimal':
    case 'low':
    case 'off':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      return 'max'
  }
}

function normalizeOpenAIStandardLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'off') return 'off'
  if (level === 'minimal') return 'low'
  if (level === 'max') return 'xhigh'
  return level ?? 'high'
}

function normalizeOpenAIMaxLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'minimal') return 'low'
  return level ?? 'high'
}

const DEEPSEEK_V4_FLASH_PROFILE: ReasoningProfile = {
  id: 'deepseek-v4-flash',
  levels: DEEPSEEK_V4_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeDeepSeekV4Level,
  encodings: {
    'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: DEEPSEEK_V4_FLASH_EFFORT_MAP },
  },
}

/** 官方 DeepSeek Flash 的思考档位配置，沿用 Flash 协议映射。 */
const DEEPSEEK_FLASH_PROFILE: ReasoningProfile = {
  id: 'deepseek-flash',
  levels: DEEPSEEK_V4_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeDeepSeekV4Level,
  encodings: {
    'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: DEEPSEEK_V4_FLASH_EFFORT_MAP },
  },
}

const DEEPSEEK_V4_PRO_PROFILE: ReasoningProfile = {
  id: 'deepseek-v4-pro',
  levels: DEEPSEEK_V4_LEVELS,
  defaultLevel: 'high',
  normalize: (level) => level === 'xhigh' ? 'max' : normalizeDeepSeekV4Level(level),
  encodings: {
    'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: DEEPSEEK_V4_PRO_EFFORT_MAP },
  },
}

const K3_PROFILE: ReasoningProfile = {
  id: 'kimi-k3',
  levels: K3_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeK3Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: K3_EFFORT_MAP },
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: K3_EFFORT_MAP },
  },
}

const GLM_53_PROFILE: ReasoningProfile = {
  id: 'glm-5.3',
  levels: GLM_53_LEVELS,
  defaultLevel: 'max',
  normalize: normalizeGlm53Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: GLM_53_EFFORT_MAP },
    'openai-completions': { kind: 'zai-thinking-effort', effortMap: GLM_53_EFFORT_MAP },
  },
}

const GLM_52_PROFILE: ReasoningProfile = {
  id: 'glm-5.2',
  levels: GLM_52_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeGlm52Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: GLM_52_ANTHROPIC_EFFORT_MAP },
    'openai-completions': { kind: 'zai-thinking-effort', effortMap: GLM_52_OPENAI_EFFORT_MAP },
  },
}

const OPENAI_STANDARD_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-standard',
  levels: OPENAI_STANDARD_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIStandardLevel,
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: OPENAI_STANDARD_EFFORT_MAP },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: OPENAI_STANDARD_EFFORT_MAP },
  },
}

const OPENAI_MAX_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-max',
  levels: OPENAI_MAX_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIMaxLevel,
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: OPENAI_MAX_EFFORT_MAP },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: OPENAI_MAX_EFFORT_MAP },
  },
}

const OPENAI_ASTRA_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-astra',
  levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultLevel: 'low',
  normalize: (level) => level === 'off' || level === 'minimal' ? 'low' : level ?? 'low',
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: { off: 'low', minimal: 'low', xhigh: 'xhigh', max: 'max' } },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: { off: 'low', minimal: 'low', xhigh: 'xhigh', max: 'max' } },
  },
}

/** GPT-6 Sol/Luna 支持关闭推理，未指定时默认 medium。 */
const OPENAI_SOL_LUNA_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-sol-luna',
  levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultLevel: 'medium',
  normalize: (level) => level === 'minimal' ? 'low' : level ?? 'medium',
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: { off: 'none', minimal: 'low', xhigh: 'xhigh', max: 'max' } },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: { off: 'none', minimal: 'low', xhigh: 'xhigh', max: 'max' } },
  },
}

export const REASONING_PROFILES: readonly ReasoningProfile[] = [
  DEEPSEEK_V4_FLASH_PROFILE,
  DEEPSEEK_FLASH_PROFILE,
  DEEPSEEK_V4_PRO_PROFILE,
  K3_PROFILE,
  GLM_52_PROFILE,
  GLM_53_PROFILE,
  OPENAI_STANDARD_PROFILE,
  OPENAI_MAX_PROFILE,
  OPENAI_ASTRA_PROFILE,
  OPENAI_SOL_LUNA_PROFILE,
]

/** 用端点声明约束已验证的协议编码；旧会话档位先兼容转换，再落到合法档位。 */
function constrainProfile(profile: ReasoningProfile, capability: ReasoningCapability | undefined): ReasoningProfile {
  if (!capability) return profile
  /** 沿用产品默认值，但默认值本身也必须在供应商支持范围内。 */
  const defaultLevel = capability.levels.includes(profile.defaultLevel) ? profile.defaultLevel : capability.defaultLevel
  /** 对所有产品档位显式标注支持性，避免 Pi 将缺失的标准档位当作支持。 */
  const effortMap = Object.fromEntries(PI_EXTENDED_THINKING_LEVELS.map((level) => [
    level,
    capability.levels.includes(level) ? level === 'off' ? 'none' : level : null,
  ])) as ReasoningEffortMap
  /** 只保留原 profile 已验证的 transport，不给模型增加新协议。 */
  const encodings = Object.fromEntries(Object.entries(profile.encodings).map(([transport, encoding]) => [
    transport, { ...encoding, effortMap },
  ])) as ReasoningProfile['encodings']
  return {
    ...profile,
    levels: capability.levels,
    defaultLevel,
    encodings,
    normalize: (level) => {
      if (level === undefined) return defaultLevel
      if (capability.levels.includes(level)) return level
      return normalizeReasoningCapabilityLevel({ ...capability, defaultLevel }, profile.normalize(level))!
    },
  }
}

/** 校验已验证 profile 的渠道归属；目录未收录的其他渠道不得仅凭同名模型借用编码。 */
function supportsProfileProvider(profile: ReasoningProfile, provider: ProviderType | undefined): boolean {
  if (!provider || provider === 'custom') return true
  if (profile.id.startsWith('openai-reasoning-')) {
    return ['openai', 'openai-responses', 'openai-codex', 'github-copilot', 'xai'].includes(provider)
  }
  if (profile.id.startsWith('deepseek-')) return provider === 'deepseek'
  if (profile.id === 'kimi-k3') return provider === 'kimi-api' || provider === 'kimi-coding'
  return ['zhipu', 'zhipu-coding', 'zhipu-coding-team', 'doubao', 'doubao-api', 'ark-coding-plan'].includes(provider)
}

/** 同时匹配渠道、模型与实际 transport，避免向同名的未知端点发送专属参数。 */
export function resolveReasoningProfile(input: ResolveReasoningProfileInput): ReasoningProfile | undefined {
  /** 兼容历史大小写及上下文后缀。 */
  const modelId = input.modelId?.trim().toLowerCase().replace(/\[1m\]$/i, '')
  if (!modelId) return undefined

  /** 自定义网关沿用已知模型的编码合同，窗口和费用不会沿此路径跨供应商继承。 */
  const openAICapability = getModelReasoningCapability('openai', modelId)
  const isOpenAITransport = input.transport === 'openai-completions' || input.transport === 'openai-responses'
  const isOpenAIReasoningModel = openAICapability !== undefined
    && (modelId.startsWith('gpt-5') || /^(o1|o3|o4)(?:-|$)/.test(modelId))
  /** 先确定编码候选，再统一经过供应商能力约束。 */
  const profile = isGpt6AstraFamily(modelId)
    ? OPENAI_ASTRA_PROFILE
    : isGpt6SolFamily(modelId) || isGpt6LunaFamily(modelId)
    ? OPENAI_SOL_LUNA_PROFILE
    : /^deepseek-flash(?:-|$)/.test(modelId)
    ? DEEPSEEK_FLASH_PROFILE
    : /^deepseek-v4-flash(?:-|$)/.test(modelId)
    ? DEEPSEEK_V4_FLASH_PROFILE
    : /^deepseek-v4-pro(?:-|$)/.test(modelId)
      ? DEEPSEEK_V4_PRO_PROFILE
      : /^(?:k3(?:-256k)?|kimi-k3)$/.test(modelId)
        ? K3_PROFILE
        : modelId === 'glm-5.3' || modelId === 'glm-5.3-flash' || modelId === 'glm-5.3-flashx'
          ? GLM_53_PROFILE
          : modelId === 'glm-5.2'
            ? GLM_52_PROFILE
            : isOpenAITransport && isOpenAIReasoningModel
              ? /^gpt-5\.6(?:-|$)/.test(modelId) ? OPENAI_MAX_PROFILE : OPENAI_STANDARD_PROFILE
              : undefined

  if (!profile?.encodings[input.transport]) return undefined
  /** 显式非推理模型与其他渠道的未知模型不能继承同名 profile。 */
  const modelCapability = getModelCapabilities(input.provider, modelId)
  if (modelCapability?.reasoning === false
    || !modelCapability && !supportsProfileProvider(profile, input.provider)) return undefined
  /** 供应商专属档位优先；未声明目录的旧兼容渠道保留已知模型协议行为。 */
  const capability = getModelReasoningCapability(input.provider, modelId)
    ?? (isOpenAIReasoningModel && (!input.provider || input.provider === 'custom') ? openAICapability : undefined)
  return constrainProfile(profile, capability)
}

const PI_EXTENDED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly AgentThinkingLevel[]

function getPiCatalogThinkingLevels(catalog: PiCatalogReasoningMetadata): AgentThinkingLevel[] {
  if (!catalog.reasoning) return []

  return PI_EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = catalog.thinkingLevelMap?.[level]
    if (mapped === null) return false
    // Pi only exposes these extended levels when the catalog maps them explicitly.
    return level !== 'xhigh' && level !== 'max' || mapped !== undefined
  })
}

/**
 * 解析最终会话 capability。显式 profile 优先于 Pi catalog，保留经过验证的模型专属编码。
 */
export function resolveReasoningCapability(input: ResolveReasoningCapabilityInput): ReasoningCapability | undefined {
  if (input.profile) {
    return {
      source: 'profile',
      levels: input.profile.levels,
      defaultLevel: input.profile.defaultLevel,
    }
  }

  if (!input.catalog) return undefined
  const levels = getPiCatalogThinkingLevels(input.catalog)
  if (levels.length === 0 || levels.every((level) => level === 'off')) return undefined
  const defaultLevel = normalizeReasoningCapabilityLevel(
    { source: 'pi-catalog', levels, defaultLevel: 'high' },
    'high',
  ) ?? levels[0]!
  return {
    source: 'pi-catalog',
    levels,
    defaultLevel,
  }
}

/**
 * 与 Pi `clampThinkingLevel` 保持一致：请求档位不可用时优先向更高档位靠拢，再向低档位回退。
 */
export function normalizeReasoningCapabilityLevel(
  capability: ReasoningCapability | undefined,
  level: AgentThinkingLevel | undefined,
): AgentThinkingLevel | undefined {
  if (!capability) return level
  const requested = level ?? capability.defaultLevel
  if (capability.levels.includes(requested)) return requested

  // Some models (for example Fable 5.1) always reason and do not expose an off
  // mode. Preserve the product's "disabled" legacy setting as a safe, explicit
  // high-effort request instead of silently downgrading it to minimal.
  if (requested === 'off') {
    return capability.levels.includes('high') ? 'high' : capability.defaultLevel
  }

  const requestedIndex = PI_EXTENDED_THINKING_LEVELS.indexOf(requested)
  if (requestedIndex === -1) return capability.levels[0]
  for (let index = requestedIndex; index < PI_EXTENDED_THINKING_LEVELS.length; index += 1) {
    const candidate = PI_EXTENDED_THINKING_LEVELS[index]
    if (candidate && capability.levels.includes(candidate)) return candidate
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = PI_EXTENDED_THINKING_LEVELS[index]
    if (candidate && capability.levels.includes(candidate)) return candidate
  }
  return capability.levels[0]
}

export function normalizeReasoningLevel(
  profile: ReasoningProfile | undefined,
  level: AgentThinkingLevel | undefined,
): AgentThinkingLevel | undefined {
  return profile ? profile.normalize(level) : level
}
