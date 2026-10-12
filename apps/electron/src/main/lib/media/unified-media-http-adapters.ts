import type { MediaAssetRef, MediaGenerationRequest, MediaInputValue } from '@proma/shared'
import { scalarInput, type UnifiedMediaGenerationAdapter, type UnifiedMediaGenerationAdapterOutput } from './unified-media-generation-service'
import type { UnifiedMediaModelRoute } from './unified-media-model-catalog'

/** HTTP 依赖可注入，测试不触碰真实供应商。 */
export interface UnifiedMediaHttpAdapterOptions {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  readAsset?: (projectId: string, asset: MediaAssetRef) => Promise<Uint8Array>
  pollIntervalMs?: number
  timeoutMs?: number
}

/** 生产环境默认使用 Electron 主进程的 fetch；测试可注入隔离实现。 */
const defaultFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(input, init)

/** 创建当前统一目录使用的图片、音频和视频 HTTP 执行器。 */
export function createUnifiedMediaHttpAdapters(options: UnifiedMediaHttpAdapterOptions = {}): UnifiedMediaGenerationAdapter[] {
  const fetchImpl = options.fetch ?? defaultFetch
  return [
    { id: 'openai-images', generate: (input) => generateOpenAiImage(input.request, input.route, input.signal, fetchImpl, options.readAsset) },
    { id: 'minimax-image', generate: (input) => generateMiniMaxImage(input.request, input.route, input.signal, fetchImpl, options.readAsset) },
    { id: 'xiaomi-speech', generate: (input) => generateXiaomiSpeech(input.request, input.route, input.signal, fetchImpl) },
    { id: 'minimax-speech', generate: (input) => generateMiniMaxSpeech(input.request, input.route, input.signal, fetchImpl) },
    { id: 'minimax-video', generate: (input) => generateMiniMaxVideo(input.request, input.route, input.signal, fetchImpl, options) },
  ]
}

type FetchImpl = NonNullable<UnifiedMediaHttpAdapterOptions['fetch']>

/** 统一 POST JSON，拒绝重定向并把上游错误收敛为稳定码。 */
async function postJson(fetchImpl: FetchImpl, url: string, apiKey: string, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) throw new Error('MEDIA_ADAPTER_REDIRECT')
  if (!response.ok) throw new Error('MEDIA_ADAPTER_HTTP_ERROR')
  return parseJson(await response.text())
}

/** 统一 GET JSON。 */
async function getJson(fetchImpl: FetchImpl, url: string, apiKey: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal, redirect: 'manual' })
  if (!response.ok) throw new Error('MEDIA_ADAPTER_HTTP_ERROR')
  return parseJson(await response.text())
}

/** OpenAI Images 编辑接口使用 multipart，图片字节不经过第三方 URL。 */
async function postMultipart(fetchImpl: FetchImpl, url: string, apiKey: string, fields: Record<string, string>, image: { bytes: Uint8Array; contentType: string }, signal: AbortSignal): Promise<unknown> {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  form.set('image', new Blob([Buffer.from(image.bytes)], { type: image.contentType }), 'reference.png')
  const response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal, redirect: 'manual' })
  if (!response.ok) throw new Error('MEDIA_ADAPTER_HTTP_ERROR')
  return parseJson(await response.text())
}

/** OpenAI Images 兼容接口的最小文生图执行器。 */
async function generateOpenAiImage(request: MediaGenerationRequest, route: UnifiedMediaModelRoute, signal: AbortSignal, fetchImpl: FetchImpl, readAsset?: UnifiedMediaHttpAdapterOptions['readAsset']): Promise<UnifiedMediaGenerationAdapterOutput[]> {
  const size = String(scalarInput(request.inputs, 'size') ?? '1024x1024')
  const reference = await firstAsset(request, readAsset)
  const endpoint = `${route.baseUrl.replace(/\/+$/, '')}/${reference ? 'images/edits' : 'images/generations'}`
  const payload = reference
    ? await postMultipart(fetchImpl, endpoint, route.apiKey, { model: route.ref.modelId, prompt: request.prompt, n: '1', size }, reference, signal)
    : await postJson(fetchImpl, endpoint, route.apiKey, { model: route.ref.modelId, prompt: request.prompt, n: 1, size }, signal)
  return await parseMediaItems(payload, 'image/png', fetchImpl, signal)
}

/** MiniMax 图像接口的最小统一执行器。 */
async function generateMiniMaxImage(request: MediaGenerationRequest, route: UnifiedMediaModelRoute, signal: AbortSignal, fetchImpl: FetchImpl, readAsset?: UnifiedMediaHttpAdapterOptions['readAsset']): Promise<UnifiedMediaGenerationAdapterOutput[]> {
  const reference = await firstAsset(request, readAsset)
  const payload = await postJson(fetchImpl, `${route.baseUrl.replace(/\/+$/, '')}/image_generation`, route.apiKey, {
    model: route.ref.modelId, prompt: request.prompt, response_format: 'base64',
    ...(reference ? { subject_reference: [{ type: 'character', image_file: `data:${reference.contentType};base64,${Buffer.from(reference.bytes).toString('base64')}` }] } : {}),
  }, signal)
  return await parseMediaItems(payload, 'image/png', fetchImpl, signal)
}

/** 小米 TTS 使用 chat/completions 的音频响应。 */
async function generateXiaomiSpeech(request: MediaGenerationRequest, route: UnifiedMediaModelRoute, signal: AbortSignal, fetchImpl: FetchImpl): Promise<UnifiedMediaGenerationAdapterOutput[]> {
  const payload = await postJson(fetchImpl, `${route.baseUrl.replace(/\/+$/, '')}/chat/completions`, route.apiKey, {
    model: route.ref.modelId, messages: [{ role: 'user', content: request.prompt }], modalities: ['text', 'audio'],
    audio: { voice: String(scalarInput(request.inputs, 'voice') ?? 'mimo_default'), format: String(scalarInput(request.inputs, 'format') ?? 'mp3') },
  }, signal)
  const encoded = readNestedString(payload, [['choices', 0, 'message', 'audio', 'data']])
  if (!encoded) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  return [{ bytes: decodeBase64(encoded), contentType: 'audio/mpeg' }]
}

/** MiniMax Speech 的 T2A 接口。 */
async function generateMiniMaxSpeech(request: MediaGenerationRequest, route: UnifiedMediaModelRoute, signal: AbortSignal, fetchImpl: FetchImpl): Promise<UnifiedMediaGenerationAdapterOutput[]> {
  const payload = await postJson(fetchImpl, `${route.baseUrl.replace(/\/+$/, '')}/t2a_v2`, route.apiKey, {
    model: route.ref.modelId, text: request.prompt,
    voice_setting: { voice_id: String(scalarInput(request.inputs, 'voice') ?? 'female-shaonv') },
    audio_setting: { format: String(scalarInput(request.inputs, 'format') ?? 'mp3') },
    ...(route.groupId ? { group_id: route.groupId } : {}),
  }, signal)
  const encoded = readNestedString(payload, [['data', 'audio'], ['audio']])
  if (!encoded) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  return [{ bytes: decodeBase64(encoded), contentType: 'audio/mpeg' }]
}

/** MiniMax 视频提交、轮询与远端文件下载执行器。 */
async function generateMiniMaxVideo(request: MediaGenerationRequest, route: UnifiedMediaModelRoute, signal: AbortSignal, fetchImpl: FetchImpl, options: UnifiedMediaHttpAdapterOptions): Promise<UnifiedMediaGenerationAdapterOutput[]> {
  const reference = await firstAsset(request, options.readAsset)
  const submitted = await postJson(fetchImpl, `${route.baseUrl.replace(/\/+$/, '')}/video_generation`, route.apiKey, {
    model: route.ref.modelId, prompt: request.prompt, ...(route.groupId ? { group_id: route.groupId } : {}),
    ...(reference ? { first_frame_image: `data:${reference.contentType};base64,${Buffer.from(reference.bytes).toString('base64')}` } : {}),
  }, signal)
  const immediate = readNestedString(submitted, [['video_url'], ['data', 'video_url']])
  const taskId = readNestedString(submitted, [['task_id'], ['data', 'task_id']])
  const videoUrl = immediate ?? (taskId ? await waitMiniMaxVideo(taskId, route, signal, fetchImpl, options) : undefined)
  if (!videoUrl) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  const response = await fetchImpl(videoUrl, { signal, redirect: 'manual' })
  if (!response.ok) throw new Error('MEDIA_ADAPTER_DOWNLOAD_FAILED')
  return [{ bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type')?.split(';')[0] ?? 'video/mp4' }]
}

/** 等待 MiniMax 视频任务终态，超时或取消均不会自动重试。 */
async function waitMiniMaxVideo(taskId: string, route: UnifiedMediaModelRoute, signal: AbortSignal, fetchImpl: FetchImpl, options: UnifiedMediaHttpAdapterOptions): Promise<string | undefined> {
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000)
  const interval = Math.max(0, options.pollIntervalMs ?? 2_000)
  while (Date.now() <= deadline) {
    signal.throwIfAborted()
    const payload = await getJson(fetchImpl, `${route.baseUrl.replace(/\/+$/, '')}/query/video_generation?task_id=${encodeURIComponent(taskId)}`, route.apiKey, signal)
    const status = readNestedString(payload, [['status'], ['data', 'status']])?.toLowerCase()
    const videoUrl = readNestedString(payload, [['video_url'], ['data', 'video_url']])
    if (videoUrl && (!status || ['success', 'succeed', 'completed'].includes(status))) return videoUrl
    if (status && ['failed', 'fail', 'error'].includes(status)) throw new Error('MEDIA_ADAPTER_REMOTE_FAILED')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('MEDIA_ADAPTER_CANCELLED')) }, { once: true })
    })
  }
  throw new Error('MEDIA_ADAPTER_TIMEOUT')
}

/** 解析图片 URL/base64 列表，并将 URL 下载成受管字节。 */
async function parseMediaItems(payload: unknown, defaultType: string, fetchImpl: FetchImpl, signal: AbortSignal): Promise<UnifiedMediaGenerationAdapterOutput[]> {
  const values = readNestedArray(payload, [['data', 'image_base64'], ['data', 'image_urls'], ['data'], ['data', 'images']])
  if (!values) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  const outputs: UnifiedMediaGenerationAdapterOutput[] = []
  for (const value of values) {
    const encoded = typeof value === 'string' ? value : readNestedString(value, [['b64_json'], ['image_base64'], ['base64'], ['url'], ['image_url']])
    if (!encoded) continue
    if (/^https?:\/\//.test(encoded)) {
      const response = await fetchImpl(encoded, { signal, redirect: 'manual' })
      if (!response.ok) throw new Error('MEDIA_ADAPTER_DOWNLOAD_FAILED')
      outputs.push({ bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type')?.split(';')[0] ?? defaultType })
    } else outputs.push({ bytes: decodeBase64(encoded), contentType: defaultType })
  }
  if (outputs.length === 0) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  return outputs
}

/** 从输入中取第一份已授权资产；缺少读取器时 fail closed。 */
async function firstAsset(request: MediaGenerationRequest, readAsset?: UnifiedMediaHttpAdapterOptions['readAsset']): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
  const entry = Object.values(request.inputs).find((value): value is Extract<MediaInputValue, { kind: 'asset' }> => value.kind === 'asset')
  if (!entry) return undefined
  if (!readAsset) throw new Error('MEDIA_GENERATION_ASSET_UNAVAILABLE')
  const bytes = await readAsset(request.projectId, entry.asset)
  const contentType = entry.asset.mediaKind === 'image' ? 'image/png' : entry.asset.mediaKind === 'audio' ? 'audio/mpeg' : 'video/mp4'
  return { bytes, contentType }
}

/** 从有限 JSON 值中读取字符串字段。 */
function readNestedString(value: unknown, paths: ReadonlyArray<ReadonlyArray<string | number>>): string | undefined {
  for (const path of paths) {
    let current: unknown = value
    for (const segment of path) {
      if (current === null || typeof current !== 'object') { current = undefined; break }
      current = (current as Record<string | number, unknown>)[segment]
    }
    if (typeof current === 'string' && current.trim()) return current.trim()
  }
  return undefined
}

/** 从有限 JSON 值中读取字符串数组。 */
function readNestedArray(value: unknown, paths: ReadonlyArray<ReadonlyArray<string | number>>): unknown[] | undefined {
  for (const path of paths) {
    let current: unknown = value
    for (const segment of path) {
      if (current === null || typeof current !== 'object') { current = undefined; break }
      current = (current as Record<string | number, unknown>)[segment]
    }
    if (Array.isArray(current)) return current
    if (typeof current === 'string' && current.trim()) return [current]
  }
  return undefined
}

/** 解析有限 JSON 文本。 */
function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID') }
}

/** 严格解码 base64，避免把任意文本伪装成媒体。 */
function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/^data:[^;]+;base64,/, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 === 1) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  const bytes = Buffer.from(normalized, 'base64')
  if (bytes.length === 0) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  return new Uint8Array(bytes)
}
