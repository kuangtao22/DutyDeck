import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// models.dev 公共目录地址，同时作为生成快照中的来源标识。
const DEFAULT_SOURCE = 'https://models.dev/api.json'
// 生成文件相对仓库根目录的位置，便于在 CI 与本地使用同一命令。
const OUTPUT_PATH = 'packages/shared/src/constants/model-capabilities.generated.json'
// Proma 已有渠道映射的 models.dev 原始供应商 ID；不得按 canonical model 合并。
const INCLUDED_PROVIDER_IDS = new Set([
  'alibaba',
  'alibaba-cn',
  'alibaba-coding-plan-cn',
  'alibaba-token-plan-cn',
  'anthropic',
  'deepseek',
  'github-copilot',
  'google',
  'kimi-code-plan-cn',
  'kimi-code-plan-global',
  'minimax',
  'minimax-cn',
  'moonshotai',
  'moonshotai-cn',
  'opencode-go',
  'openai',
  'volcengine',
  'volcengine-coding-plan',
  'xai',
  'xiaomi',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai',
  'zai-coding-plan',
  'zhipuai',
  'zhipuai-coding-plan',
])

type JsonPrimitive = boolean | null | number | string
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

interface CliOptions {
  check: boolean
  source: string
}

interface GeneratedCostTier {
  inputTokensAbove: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

interface GeneratedCost {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  tiers?: GeneratedCostTier[]
}

interface GeneratedModelCapability {
  reasoning: boolean
  reasoningOptions: JsonValue[]
  temperature?: boolean
  contextWindow?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  inputModalities: string[]
  outputModalities: string[]
  interleaved?: boolean | { field: string }
  status?: string
  cost?: GeneratedCost
}

interface GeneratedSnapshot {
  source: typeof DEFAULT_SOURCE
  sha256: string
  providers: Record<string, Record<string, GeneratedModelCapability>>
}

/** 判断未知值是否为可安全读取的普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取必需对象字段，并在目录结构变化时给出明确路径。 */
function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} 必须是对象`)
  }
  return value
}

/** 读取必需布尔字段。 */
function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${path} 必须是布尔值`)
  }
  return value
}

/** 读取可选布尔字段。 */
function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined
  return requireBoolean(value, path)
}

/** 读取可选字符串字段。 */
function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`${path} 必须是字符串`)
  }
  return value
}

/** 读取非负有限数字，避免把无效限额或价格写入运行时快照。 */
function optionalNonNegativeNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} 必须是非负有限数字`)
  }
  return value
}

/** 读取字符串数组，并复制数组以隔离源对象。 */
function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${path} 必须是字符串数组`)
  }
  return [...value]
}

/** 校验值可以无损写入 JSON；思考选项按上游原始结构保留。 */
function requireJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} 包含非有限数字`)
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => requireJsonValue(item, `${path}[${index}]`))
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = requireJsonValue(item, `${path}.${key}`)
    }
    return result
  }
  throw new Error(`${path} 不是合法 JSON 值`)
}

/** 读取原始 reasoning_options 数组；缺失时显式输出空数组。 */
function readReasoningOptions(value: unknown, path: string): JsonValue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`)
  return value.map((item, index) => requireJsonValue(item, `${path}[${index}]`))
}

/** 将 models.dev 的价格字段映射到快照命名，并保留缺失值语义。 */
function readCostFields(rawCost: Record<string, unknown>, path: string): Omit<GeneratedCost, 'tiers'> {
  return {
    ...withDefined('input', optionalNonNegativeNumber(rawCost.input, `${path}.input`)),
    ...withDefined('output', optionalNonNegativeNumber(rawCost.output, `${path}.output`)),
    ...withDefined('cacheRead', optionalNonNegativeNumber(rawCost.cache_read, `${path}.cache_read`)),
    ...withDefined('cacheWrite', optionalNonNegativeNumber(rawCost.cache_write, `${path}.cache_write`)),
    ...withDefined('reasoning', optionalNonNegativeNumber(rawCost.reasoning, `${path}.reasoning`)),
  }
}

/** 仅在值存在时构造对象字段，避免用 0 伪造上游缺值。 */
function withDefined<Key extends string, Value>(key: Key, value: Value | undefined): Partial<Record<Key, Value>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, Value>
}

/** 转换一个 context 价格阶梯；其他阶梯类型由调用方过滤。 */
function readContextTier(rawTier: Record<string, unknown>, path: string): GeneratedCostTier {
  const tierRule = requireRecord(rawTier.tier, `${path}.tier`)
  const inputTokensAbove = optionalNonNegativeNumber(tierRule.size, `${path}.tier.size`)
  if (inputTokensAbove === undefined) throw new Error(`${path}.tier.size 必须存在`)
  return {
    inputTokensAbove,
    ...readCostFields(rawTier, path),
  }
}

/** 转换价格；只纳入 context tier，并兼容旧 context_over_200k 字段。 */
function readCost(value: unknown, path: string): GeneratedCost | undefined {
  if (value === undefined) return undefined
  const rawCost = requireRecord(value, path)
  const baseCost = readCostFields(rawCost, path)
  const contextTiers: GeneratedCostTier[] = []
  if (rawCost.tiers !== undefined) {
    if (!Array.isArray(rawCost.tiers)) throw new Error(`${path}.tiers 必须是数组`)
    rawCost.tiers.forEach((value, index) => {
      const rawTier = requireRecord(value, `${path}.tiers[${index}]`)
      readCostFields(rawTier, `${path}.tiers[${index}]`)
      const tierRule = requireRecord(rawTier.tier, `${path}.tiers[${index}].tier`)
      if (tierRule.type === 'context') {
        contextTiers.push(readContextTier(rawTier, `${path}.tiers[${index}]`))
      }
    })
  }
  if (rawCost.context_over_200k !== undefined) {
    const fallback = requireRecord(rawCost.context_over_200k, `${path}.context_over_200k`)
    const fallbackCost = readCostFields(fallback, `${path}.context_over_200k`)
    if (contextTiers.length === 0) {
      contextTiers.push({ inputTokensAbove: 200000, ...fallbackCost })
    }
  }
  contextTiers.sort((left, right) => left.inputTokensAbove - right.inputTokensAbove)
  const cost: GeneratedCost = {
    ...baseCost,
    ...(contextTiers.length > 0 ? { tiers: contextTiers } : {}),
  }
  return Object.keys(cost).length > 0 ? cost : undefined
}

/** 转换 interleaved 声明，只接受当前目录定义的布尔值或字段对象。 */
function readInterleaved(value: unknown, path: string): GeneratedModelCapability['interleaved'] {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  const rawInterleaved = requireRecord(value, path)
  if (typeof rawInterleaved.field !== 'string') throw new Error(`${path}.field 必须是字符串`)
  return { field: rawInterleaved.field }
}

/** 转换单个文本输出模型的最小能力字段。 */
function readModelCapability(rawModel: Record<string, unknown>, path: string): GeneratedModelCapability | undefined {
  const modalities = requireRecord(rawModel.modalities, `${path}.modalities`)
  const inputModalities = requireStringArray(modalities.input, `${path}.modalities.input`)
  const outputModalities = requireStringArray(modalities.output, `${path}.modalities.output`)
  if (!outputModalities.includes('text')) return undefined
  const limit = rawModel.limit === undefined ? {} : requireRecord(rawModel.limit, `${path}.limit`)
  return {
    reasoning: requireBoolean(rawModel.reasoning, `${path}.reasoning`),
    reasoningOptions: readReasoningOptions(rawModel.reasoning_options, `${path}.reasoning_options`),
    ...withDefined('temperature', optionalBoolean(rawModel.temperature, `${path}.temperature`)),
    ...withDefined('contextWindow', optionalNonNegativeNumber(limit.context, `${path}.limit.context`)),
    ...withDefined('maxInputTokens', optionalNonNegativeNumber(limit.input, `${path}.limit.input`)),
    ...withDefined('maxOutputTokens', optionalNonNegativeNumber(limit.output, `${path}.limit.output`)),
    inputModalities,
    outputModalities,
    ...withDefined('interleaved', readInterleaved(rawModel.interleaved, `${path}.interleaved`)),
    ...withDefined('status', optionalString(rawModel.status, `${path}.status`)),
    ...withDefined('cost', readCost(rawModel.cost, `${path}.cost`)),
  }
}

/** 从 models.dev 根对象生成按供应商和模型 ID 排序的能力表。 */
function buildProviders(source: unknown): GeneratedSnapshot['providers'] {
  const root = requireRecord(source, 'root')
  const providers: GeneratedSnapshot['providers'] = {}
  const providerIds = Object.keys(root).filter(id => INCLUDED_PROVIDER_IDS.has(id)).sort()
  for (const providerId of providerIds) {
    const rawProvider = requireRecord(root[providerId], `root.${providerId}`)
    const rawModels = requireRecord(rawProvider.models, `root.${providerId}.models`)
    const models: Record<string, GeneratedModelCapability> = {}
    const sourceModelKeys = Object.keys(rawModels).sort()
    for (const sourceModelKey of sourceModelKeys) {
      const rawModel = requireRecord(rawModels[sourceModelKey], `root.${providerId}.models.${sourceModelKey}`)
      if (typeof rawModel.id !== 'string' || rawModel.id.length === 0) {
        throw new Error(`root.${providerId}.models.${sourceModelKey}.id 必须是非空字符串`)
      }
      const capability = readModelCapability(rawModel, `root.${providerId}.models.${sourceModelKey}`)
      if (capability === undefined) continue
      if (models[rawModel.id] !== undefined) {
        throw new Error(`供应商 ${providerId} 包含重复模型 ID：${rawModel.id}`)
      }
      models[rawModel.id] = capability
    }
    if (Object.keys(models).length > 0) {
      providers[providerId] = Object.fromEntries(Object.entries(models).sort(([left], [right]) => left.localeCompare(right)))
    }
  }
  return providers
}

/** 解析命令行参数，只支持本地/远程来源切换与只检查模式。 */
function parseArguments(args: string[]): CliOptions {
  let source = DEFAULT_SOURCE
  let check = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--check') {
      check = true
      continue
    }
    if (argument === '--source') {
      const sourceArgument = args[index + 1]
      if (!sourceArgument || sourceArgument.startsWith('--')) throw new Error('--source 需要提供 URL 或本地 JSON 路径')
      source = sourceArgument
      index += 1
      continue
    }
    throw new Error(`未知参数：${argument}`)
  }
  return { source, check }
}

/** 读取 URL 或本地文件并保留原始文本，用于生成可复现的数据哈希。 */
async function readSource(source: string): Promise<string> {
  if (/^https?:\/\//u.test(source)) {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`下载 ${source} 失败：HTTP ${response.status}`)
    return response.text()
  }
  return readFile(resolve(process.cwd(), source), 'utf8')
}

/** 原子替换生成文件，防止同步中断后留下半份 JSON。 */
async function writeSnapshot(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporaryPath, content, 'utf8')
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

/** 执行同步或一致性检查，并通过退出码供本地与 CI 使用。 */
async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const sourceText = await readSource(options.source)
  let source: unknown
  try {
    source = JSON.parse(sourceText)
  } catch (error) {
    throw new Error(`来源不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const snapshot: GeneratedSnapshot = {
    source: DEFAULT_SOURCE,
    sha256: createHash('sha256').update(sourceText, 'utf8').digest('hex'),
    providers: buildProviders(source),
  }
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`
  const outputPath = resolve(process.cwd(), OUTPUT_PATH)
  if (options.check) {
    const current = await readFile(outputPath, 'utf8').catch(() => undefined)
    if (current !== serialized) {
      console.error(`模型能力快照已过期：${OUTPUT_PATH}`)
      process.exitCode = 1
      return
    }
    console.log(`模型能力快照已是最新：${OUTPUT_PATH}`)
    return
  }
  await writeSnapshot(outputPath, serialized)
  const modelCount = Object.values(snapshot.providers).reduce((total, models) => total + Object.keys(models).length, 0)
  console.log(`已同步 ${Object.keys(snapshot.providers).length} 个供应商、${modelCount} 个文本模型到 ${OUTPUT_PATH}`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
