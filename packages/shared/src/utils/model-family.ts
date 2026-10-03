/** GPT-6 家族识别供渠道、运行时和 UI 共用；Sol/Luna 仅接受精确 ID。 */
const GPT_6_ASTRA_FAMILY_PATTERN = /^gpt-6-astra(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/
/** Sol 的官方请求 ID。 */
const GPT_6_SOL_MODEL_ID = 'gpt-6-sol'
/** Luna 的官方请求 ID。 */
const GPT_6_LUNA_MODEL_ID = 'gpt-6-luna'
/** GPT-6.1 Sol 的官方请求 ID，推理能力仍由 Pi 模型目录提供。 */
const GPT_6_1_SOL_MODEL_ID = 'gpt-6.1-sol'

/** 归一化模型 ID，兼容历史上下文后缀；未传入时返回 undefined。 */
function normalizeModelId(modelId: string | undefined): string | undefined {
  return modelId?.trim().toLowerCase().replace(/\[1m\]$/i, '')
}

/** 判断模型是否为 Astra 或带合法 SKU 后缀的 Astra。 */
export function isGpt6AstraFamily(modelId: string | undefined): boolean {
  /** 用完整正则边界拒绝相似名称。 */
  const normalized = normalizeModelId(modelId)
  return normalized !== undefined && GPT_6_ASTRA_FAMILY_PATTERN.test(normalized)
}

/** 判断模型是否为精确的 GPT-6 Sol。 */
export function isGpt6SolFamily(modelId: string | undefined): boolean {
  return normalizeModelId(modelId) === GPT_6_SOL_MODEL_ID
}

/** 判断模型是否为精确的 GPT-6 Luna。 */
export function isGpt6LunaFamily(modelId: string | undefined): boolean {
  return normalizeModelId(modelId) === GPT_6_LUNA_MODEL_ID
}

/** 判断模型是否为精确的 GPT-6.1 Sol。 */
export function isGpt61SolFamily(modelId: string | undefined): boolean {
  return normalizeModelId(modelId) === GPT_6_1_SOL_MODEL_ID
}
