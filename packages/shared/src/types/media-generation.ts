import type { MediaApiModelCapability } from './media-api-model'
import type { MediaAssetRef, MediaInputValue, MediaKind } from './media'

/** Agent、Canvas 与设置页共用的稳定媒体模型引用。 */
export interface MediaModelRef {
  kind: MediaKind
  provider: string
  profileId: string
  modelId: string
}

/** 统一媒体生成的生命周期；准备阶段不会产生供应商副作用。 */
export type MediaGenerationPhase = 'prepared' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** 目录公开的统一模型条目；不包含地址、凭据或模型原始响应。 */
export interface UnifiedMediaModelOption {
  ref: string
  name: string
  kind: MediaKind
  provider: string
  profileId: string
  modelId: string
  capabilities: MediaApiModelCapability[]
  available: boolean
  adapterId?: string
  unavailableReason?: string
}

/** 统一 Agent 生成请求；媒体输入只接受已授权资产引用或有限标量。 */
export interface MediaGenerationRequest {
  projectId: string
  operationId: string
  modelRef: string
  prompt: string
  inputs: Record<string, MediaInputValue>
}

/** 统一媒体生成产物摘要；二进制内容只留在主进程资产服务。 */
export interface MediaGenerationOutput {
  outputKey: string
  asset: MediaAssetRef
}

/** Agent 查询到的统一运行快照。 */
export interface MediaGenerationSnapshot {
  id: string
  projectId: string
  revision: number
  phase: MediaGenerationPhase
  modelRef: string
  mediaKind: MediaKind
  createdAt: number
  updatedAt: number
  outputs: MediaGenerationOutput[]
  error: string | null
}

const MODEL_REF_PATTERN = /^media:(image|audio|video):([A-Za-z0-9][A-Za-z0-9_.-]{0,63}):([A-Za-z0-9][A-Za-z0-9_.:-]{0,255}):(.+)$/
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor'])

/** 从模型引用构造稳定字符串；入参必须来自已校验目录。 */
export function formatMediaModelRef(ref: MediaModelRef): string {
  if (!['image', 'audio', 'video'].includes(ref.kind)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(ref.provider)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(ref.profileId)
    || !ref.modelId || ref.modelId.length > 256 || /[\u0000-\u001f\u007f]/u.test(ref.modelId)
    || RESERVED_IDS.has(ref.profileId) || RESERVED_IDS.has(ref.modelId)) {
    throw new Error('MEDIA_MODEL_REF_INVALID')
  }
  return `media:${ref.kind}:${ref.provider}:${ref.profileId}:${ref.modelId}`
}

/** 严格解析 Agent 提供的稳定模型引用。 */
export function parseMediaModelRef(value: unknown): MediaModelRef {
  if (typeof value !== 'string' || value.length > 640) throw new Error('MEDIA_MODEL_REF_INVALID')
  const match = MODEL_REF_PATTERN.exec(value)
  if (!match || RESERVED_IDS.has(match[2]!) || RESERVED_IDS.has(match[3]!) || RESERVED_IDS.has(match[4]!)) {
    throw new Error('MEDIA_MODEL_REF_INVALID')
  }
  const ref: MediaModelRef = { kind: match[1] as MediaKind, provider: match[2]!, profileId: match[3]!, modelId: match[4]! }
  if (formatMediaModelRef(ref) !== value) throw new Error('MEDIA_MODEL_REF_INVALID')
  return ref
}

/** 解析统一生成请求，拒绝秘密字段、空提示词和无界输入。 */
export function parseMediaGenerationRequest(value: unknown): MediaGenerationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.some((key) => !['projectId', 'operationId', 'modelRef', 'prompt', 'inputs'].includes(key))) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  if ([input.projectId, input.operationId].some((item) => typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(item))) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  const modelRef = parseMediaModelRef(input.modelRef)
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16_384) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  if (!input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs) || Object.keys(input.inputs).length > 128) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  const inputs: Record<string, MediaInputValue> = {}
  for (const [key, raw] of Object.entries(input.inputs as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
    const candidate = raw as Record<string, unknown>
    if (candidate.kind === 'scalar' && Object.keys(candidate).length === 2
      && (typeof candidate.value === 'string' || typeof candidate.value === 'number' || typeof candidate.value === 'boolean')) {
      inputs[key] = { kind: 'scalar', value: candidate.value }
    } else if (candidate.kind === 'asset' && Object.keys(candidate).length === 2) {
      inputs[key] = { kind: 'asset', asset: parseAssetRef(candidate.asset) }
    } else throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  }
  return { projectId: input.projectId as string, operationId: input.operationId as string, modelRef: formatMediaModelRef(modelRef), prompt: input.prompt.trim(), inputs }
}

/** 严格解析媒体资产引用，阻止 Agent 伪造 revision、hash 或媒体类型。 */
function parseAssetRef(value: unknown): MediaAssetRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  const asset = value as Record<string, unknown>
  if (Object.keys(asset).length !== 4
    || typeof asset.assetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(asset.assetId)
    || !Number.isSafeInteger(asset.revision) || Number(asset.revision) < 1
    || typeof asset.hash !== 'string' || !/^[a-f0-9]{64}$/.test(asset.hash)
    || (asset.mediaKind !== 'image' && asset.mediaKind !== 'audio' && asset.mediaKind !== 'video')) {
    throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  }
  return { assetId: asset.assetId, revision: Number(asset.revision), hash: asset.hash, mediaKind: asset.mediaKind }
}
