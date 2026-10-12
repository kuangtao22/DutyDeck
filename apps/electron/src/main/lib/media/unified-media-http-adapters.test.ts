import { describe, expect, test } from 'bun:test'
import type { MediaGenerationRequest } from '@proma/shared'
import { createUnifiedMediaHttpAdapters } from './unified-media-http-adapters'
import type { UnifiedMediaModelRoute } from './unified-media-model-catalog'

const request: MediaGenerationRequest = { projectId: 'p', operationId: 'o', modelRef: 'media:audio:minimax:audio:speech', prompt: '你好', inputs: {} }
function route(adapterId: string, kind: 'audio' | 'video' | 'image'): UnifiedMediaModelRoute {
  return { option: { ref: request.modelRef, name: 'model', kind, provider: 'minimax', profileId: 'audio', modelId: 'speech', capabilities: [], available: true, adapterId }, ref: { kind, provider: 'minimax', profileId: 'audio', modelId: 'speech' }, baseUrl: 'https://api.example.test/v1', apiKey: 'key' }
}

describe('统一媒体 HTTP 执行器', () => {
  test('Given OpenAI Images 返回 b64_json When 生成 Then 解析图片字节', async () => {
    const adapters = createUnifiedMediaHttpAdapters({ fetch: async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }), { status: 200 }) })
    const output = await adapters.find((adapter) => adapter.id === 'openai-images')!.generate({ request: { ...request, modelRef: 'media:image:openai-images:image:gpt-image-1' }, route: { ...route('openai-images', 'image'), ref: { kind: 'image', provider: 'openai-images', profileId: 'image', modelId: 'gpt-image-1' }, option: { ...route('openai-images', 'image').option, ref: 'media:image:openai-images:image:gpt-image-1', provider: 'openai-images', modelId: 'gpt-image-1', kind: 'image' } }, signal: new AbortController().signal })
    expect(new TextDecoder().decode(output[0]!.bytes)).toBe('image')
  })

  test('Given MiniMax Speech 返回 base64 When 生成 Then 解析为音频字节', async () => {
    const requests: Request[] = []
    const adapters = createUnifiedMediaHttpAdapters({ fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(JSON.stringify({ data: { audio: Buffer.from('voice').toString('base64') }, base_resp: { status_code: 0 } }), { status: 200 })
    } })
    const output = await adapters.find((adapter) => adapter.id === 'minimax-speech')!.generate({ request, route: route('minimax-speech', 'audio'), signal: new AbortController().signal })
    expect(new TextDecoder().decode(output[0]!.bytes)).toBe('voice')
    expect(requests[0]!.url).toBe('https://api.example.test/v1/t2a_v2')
  })

  test('Given MiniMax Video 异步任务 When 查询成功 Then 下载视频字节', async () => {
    let calls = 0
    const adapters = createUnifiedMediaHttpAdapters({ pollIntervalMs: 0, timeoutMs: 2_000, fetch: async (input) => {
      calls += 1
      const url = String(input)
      if (url.endsWith('/video_generation')) return new Response(JSON.stringify({ task_id: 'task-1', base_resp: { status_code: 0 } }), { status: 200 })
      if (url.includes('/query/video_generation')) return new Response(JSON.stringify({ status: 'Success', video_url: 'https://cdn.example.test/video.mp4' }), { status: 200 })
      return new Response(new Uint8Array([9, 8, 7]), { status: 200, headers: { 'content-type': 'video/mp4' } })
    } })
    const output = await adapters.find((adapter) => adapter.id === 'minimax-video')!.generate({ request, route: route('minimax-video', 'video'), signal: new AbortController().signal })
    expect([...output[0]!.bytes]).toEqual([9, 8, 7])
    expect(calls).toBe(3)
  })
})
