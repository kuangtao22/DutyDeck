import snapshot from '../constants/model-capabilities.generated.json'
import type { AgentThinkingLevel } from '../types/agent'
import type { ProviderType } from '../types/channel'
import type { ReasoningCapability } from '../types/reasoning-profile'
import { getGeminiModelCapability } from './gemini-model-capabilities'

/** 供应商声明的思考控制；缺省或空数组表示目录没有列出控制参数。 */
export type ModelReasoningOption =
  | { type: 'effort'; values: string[] }
  | { type: 'toggle' }
  | { type: 'budget_tokens'; min?: number; max?: number }

/** 每百万 token 的费用，缺失字段由运行时已有目录补齐。 */
export interface ModelCapabilityCost {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  tiers?: Array<Omit<ModelCapabilityCost, 'tiers'> & { inputTokensAbove: number }>
}

/** 同一供应商和精确模型 ID 的能力快照，不包含认证和路由配置。 */
export interface ModelCapabilities {
  reasoning: boolean
  reasoningOptions: ModelReasoningOption[]
  temperature?: boolean
  contextWindow?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  inputModalities: string[]
  outputModalities: string[]
  interleaved?: boolean | { field: string }
  status?: string
  cost?: ModelCapabilityCost
}

/** 生成器验证并写出的快照结构。 */
interface ModelCapabilitiesSnapshot {
  source: string
  sha256: string
  providers: Record<string, Record<string, ModelCapabilities>>
}

/** 只在模块初始化时建立小写索引，后续查找为常量复杂度。 */
const providers = Object.fromEntries(Object.entries((snapshot as ModelCapabilitiesSnapshot).providers).map(([provider, models]) => [
  provider,
  Object.fromEntries(Object.entries(models).map(([modelId, capability]) => [modelId.toLowerCase(), capability])),
]))

/** 渠道枚举对应实际端点目录；订阅和自定义网关继续由自己的 Pi 目录负责。 */
const PROVIDER_CATALOG: Partial<Record<ProviderType, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-responses': 'openai',
  deepseek: 'deepseek',
  google: 'google',
  'kimi-api': 'moonshotai-cn',
  'kimi-coding': 'kimi-code-plan-cn',
  'opencode-go-openai': 'opencode-go',
  zhipu: 'zhipuai',
  'zhipu-coding': 'zhipuai-coding-plan',
  'zhipu-coding-team': 'zhipuai-coding-plan',
  'ark-coding-plan': 'volcengine-coding-plan',
  doubao: 'volcengine-coding-plan',
  'doubao-api': 'volcengine',
  minimax: 'minimax-cn',
  qwen: 'alibaba-cn',
  'qwen-anthropic': 'alibaba-cn',
  'qwen-token-plan': 'alibaba-token-plan-cn',
  xiaomi: 'xiaomi',
  'xiaomi-token-plan': 'xiaomi-token-plan-cn',
}

/** 按渠道与模型 ID 查询能力；未知模型或订阅渠道返回 undefined，不跨供应商猜测。 */
export function getModelCapabilities(provider: ProviderType | undefined, modelId: string | undefined): ModelCapabilities | undefined {
  /** 该渠道实际对应的供应商，而不是基础模型的生产商。 */
  const catalog = provider && Object.hasOwn(PROVIDER_CATALOG, provider) ? PROVIDER_CATALOG[provider] : undefined
  if (!catalog || !modelId) return undefined
  /** 去除历史窗口后缀；Google 的 models/ 是 SDK 资源前缀。 */
  const normalizedId = modelId.trim().toLowerCase().replace(/\[1m\]$/, '')
  /** Google 前缀只在 Google 渠道剥离，不更改其他渠道的真实 ID。 */
  const id = provider === 'google' ? normalizedId.replace(/^models\//, '') : normalizedId
  /** 拒绝 constructor/__proto__ 等继承属性伪装为目录模型。 */
  const models = providers[catalog]
  return models && Object.hasOwn(models, id) ? models[id] : undefined
}

/** 产品支持的有序思考等级，none 在协议边界转换为 off。 */
const THINKING_LEVELS: readonly AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 从能力快照生成可展示档位；未声明控制方式时不猜测档位。 */
export function getModelReasoningCapability(provider: ProviderType | undefined, modelId: string | undefined): ReasoningCapability | undefined {
  /** 原始端点能力，同一个模型在不同渠道可以有不同控制方式。 */
  const model = getModelCapabilities(provider, modelId)
  if (!model?.reasoning) return undefined
  /** 精确 effort 枚举优先于产品的通用预算档位。 */
  const effort = model.reasoningOptions.find((option) => option.type === 'effort')
  /** Anthropic 手动预算可关闭；min 只限制开启后的预算，并非强制推理声明。 */
  const canDisable = model.reasoningOptions.some((option) => option.type === 'toggle'
    || option.type === 'budget_tokens' && (option.min === 0 || provider === 'anthropic'))
  /** 预算控制由既有适配器把这些档位映射到合法 token 数。 */
  const budget = model.reasoningOptions.find((option) => option.type === 'budget_tokens')
  /** 本地副本避免向快照原数组插入 off。 */
  const values = effort?.values.map((level) => level === 'none' ? 'off' : level)
    ?? (budget ? ['minimal', 'low', 'medium', 'high'] : canDisable ? ['high'] : [])
  if (canDisable) values.push('off')
  /** 按产品固定顺序去重，并排除当前程序无法编码的新档位。 */
  const levels = THINKING_LEVELS.filter((level) => values.includes(level))
  if (levels.length === 0 || levels.every((level) => level === 'off')) return undefined
  /** 保留原产品默认偏好，并在新目录不支持时回退到合法强度。 */
  const preferredDefault = provider === 'google' ? getGeminiModelCapability(modelId)?.defaultThinkingLevel
    : modelId === 'gpt-6-astra' ? 'low'
    : modelId === 'gpt-6-sol' || modelId === 'gpt-6-luna' ? 'medium'
    : modelId?.startsWith('glm-5.3') ? 'max' : undefined
  /** 仅选择目录真正支持的默认强度。 */
  const defaultLevel = preferredDefault && levels.includes(preferredDefault)
    ? preferredDefault
    : levels.includes('high') ? 'high' : levels.find((level) => level !== 'off')!
  return { source: 'models-dev', levels, defaultLevel }
}
