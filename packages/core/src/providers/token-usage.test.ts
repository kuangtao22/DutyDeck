import { describe, expect, spyOn, test } from 'bun:test'
import type { TokenUsageAmounts } from '@proma/shared'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { GoogleAdapter } from './google-adapter.ts'
import { OpenAIAdapter } from './openai-adapter.ts'
import { OpenAIResponsesAdapter } from './openai-responses-adapter.ts'
import { fetchTitle, streamSSE } from './sse-reader.ts'
import type { ProviderAdapter } from './types.ts'

/** 生成内存 SSE 响应，不连接真实模型。 */
function streamResponse(lines: unknown[]): Response {
  return new Response(lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join(''))
}
/** 将测试响应函数适配为 fetch，保留 Bun fetch 的静态类型。 */
function fakeFetch(response: () => Promise<Response> | Response): typeof fetch {
  return Object.assign(async () => response(), { preconnect: fetch.preconnect }) as typeof fetch
}
/** 测试用请求不包含真实地址或凭据。 */
const request = { url: 'https://example.invalid', headers: {}, body: '{}' }
/** 读取一组供应商事件的最终标准用量。 */
async function usageFor(adapter: ProviderAdapter, lines: unknown[]): Promise<TokenUsageAmounts> {
  return (await streamSSE({ request, adapter, onEvent: () => {}, fetchFn: fakeFetch(() => streamResponse(lines)) })).usage
}

describe('给定供应商真实 usage，标准口径保留未知并避免重复计数', () => {
  test('Anthropic start 输入含两类缓存，delta 顶层输出累计覆盖而非相加', async () => {
    expect(await usageFor(new AnthropicAdapter('anthropic'), [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 } } },
      { type: 'message_delta', usage: { output_tokens: 9 }, delta: { stop_reason: 'end_turn' } },
    ])).toEqual({ inputTokens: 45, outputTokens: 9, cacheReadTokens: 30, cacheWriteTokens: 5 })
  })
  test('OpenAI empty choices 尾帧报告零和缓存，不重复加入 reasoning', async () => {
    expect(await usageFor(new OpenAIAdapter('openai'), [{ choices: [], usage: { prompt_tokens: 40, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 10 } } }])).toEqual({ inputTokens: 40, outputTokens: 0, cacheReadTokens: 20, cacheWriteTokens: null })
  })
  test('Responses 保留 cached_tokens', async () => {
    expect((await usageFor(new OpenAIResponsesAdapter('openai'), [{ type: 'response.completed', response: { usage: { input_tokens: 40, output_tokens: 3, input_tokens_details: { cached_tokens: 20 } } } }])).cacheReadTokens).toBe(20)
  })
  test('Google 输出包含 candidates 和 thoughts，缺失 candidates 保持未知', async () => {
    expect((await usageFor(new GoogleAdapter(), [{ usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5 } }])).outputTokens).toBe(15)
    expect((await usageFor(new GoogleAdapter(), [{ usageMetadata: { promptTokenCount: 20 } }])).outputTokens).toBeNull()
  })
})

describe('给定真实 transport attempt，只观察一次且不改变业务', () => {
  test('请求前已取消，不发起 fetch、不生成记录', async () => {
    let calls = 0
    let observations = 0
    await expect(streamSSE({ request, adapter: new OpenAIAdapter('openai'), signal: AbortSignal.abort(), onEvent: () => {}, fetchFn: fakeFetch(() => { calls++; return streamResponse([]) }), onUsageAttempt: () => { observations++ } })).rejects.toThrow()
    expect(calls).toBe(0)
    expect(observations).toBe(0)
  })
  test('非成功标题响应记录 failed 一次', async () => {
    const observations: unknown[] = []
    expect(await fetchTitle(request, new OpenAIAdapter('openai'), fakeFetch(() => new Response('', { status: 401 })), (usage, status) => observations.push([usage, status]))).toBeNull()
    expect(observations).toEqual([[null, 'failed']])
  })
  test('标题解析异常只记录一次且保留响应 usage', async () => {
    const adapter = new AnthropicAdapter('anthropic')
    adapter.parseTitleResponse = () => { throw new Error('invalid title') }
    const observations: unknown[] = []
    await fetchTitle(request, adapter, fakeFetch(() => Response.json({ usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 20 } })), (usage, status) => observations.push([usage, status]))
    expect(observations).toEqual([[{ inputTokens: 30, outputTokens: 3, cacheReadTokens: 20, cacheWriteTokens: null }, 'failed']])
  })
  test('失败的 SSE 保留此前完整 usage；observer 抛出不替代供应商错误', async () => {
    const observations: unknown[] = []
    await expect(streamSSE({ request, adapter: new AnthropicAdapter('anthropic'), onEvent: () => {}, fetchFn: fakeFetch(() => streamResponse([
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'error', error: { message: 'provider refused' } },
    ])), onUsageAttempt: (usage, status) => { observations.push([usage, status]); throw new Error('observer error') } })).rejects.toThrow('provider refused')
    expect(observations).toEqual([[{ inputTokens: 10, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null }, 'failed']])
  })
})

describe('部分累计、重试及取消边界', () => {
  test('Anthropic 缓存更新只重算基数，输入省略时仍保留起始基数', async () => {
    expect(await usageFor(new AnthropicAdapter('anthropic'), [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20 } } },
      { type: 'message_delta', usage: { output_tokens: 2, cache_read_input_tokens: 30 } },
      { type: 'message_delta', usage: { output_tokens: 3 } },
    ])).toEqual({ inputTokens: 40, outputTokens: 3, cacheReadTokens: 30, cacheWriteTokens: null })
  })
  test('只有 usage 不禁止旧首可见事件前重试，每次实际尝试各报一次', async () => {
    /** 第一次只发用量后中断，第二次成功。 */
    let attempts = 0
    const observations: unknown[] = []
    const result = await streamSSE({ request, adapter: new OpenAIAdapter('openai'), onEvent: () => {}, fetchFn: fakeFetch(() => {
      attempts++
      if (attempts > 1) return streamResponse([{ choices: [{ delta: { content: 'ok' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }])
      let reads = 0
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":3}}\n\n'))
        else controller.error(new Error('connection interrupted'))
      } }))
    }), onUsageAttempt: (usage, status) => observations.push([usage, status]) })
    expect(result.content).toBe('ok')
    expect(attempts).toBe(2)
    expect(observations).toEqual([
      [{ inputTokens: 3, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }, 'failed'],
      [{ inputTokens: 4, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null }, 'completed'],
    ])
  })
  test('流取消保留已报告值并仅发 cancelled 一次', async () => {
    const observations: unknown[] = []
    let reads = 0
    await expect(streamSSE({ request, adapter: new OpenAIAdapter('openai'), onEvent: () => {}, fetchFn: fakeFetch(() => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\n'))
      else controller.error(new DOMException('cancelled', 'AbortError'))
    } }))), onUsageAttempt: (usage, status) => observations.push([usage, status]) })).rejects.toThrow('cancelled')
    expect(observations).toEqual([[{ inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null }, 'cancelled']])
  })
  test('未报告 usage 的成功调用保留 null；观察器异常不改变成功结果', async () => {
    const observations: unknown[] = []
    const result = await streamSSE({ request, adapter: new OpenAIAdapter('openai'), onEvent: () => {}, fetchFn: fakeFetch(() => streamResponse([{ choices: [{ delta: { content: 'ok' } }] }])), onUsageAttempt: (usage, status) => { observations.push([usage, status]); throw new Error('observer') } })
    expect(result.content).toBe('ok')
    expect(observations).toEqual([[null, 'completed']])
  })
  test('非流式 Google 和 Responses 与流式口径一致', async () => {
    const observations: unknown[] = []
    await fetchTitle(request, new GoogleAdapter(), fakeFetch(() => Response.json({ candidates: [{ content: { parts: [{ text: '标题' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 5, cachedContentTokenCount: 2 } })), (usage, status) => observations.push([usage, status]))
    await fetchTitle(request, new OpenAIResponsesAdapter('openai'), fakeFetch(() => Response.json({ output_text: '标题', usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } })), (usage, status) => observations.push([usage, status]))
    expect(observations).toEqual([
      [{ inputTokens: 10, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: null }, 'completed'],
      [{ inputTokens: 10, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: null }, 'completed'],
    ])
  })
  test('非法计数不入账，未知输入不被仅缓存推成完整输入', async () => {
    expect(await usageFor(new AnthropicAdapter('anthropic'), [{ type: 'message_start', message: { usage: { input_tokens: -1, output_tokens: 1.5, cache_read_input_tokens: 5 } } }])).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: 5, cacheWriteTokens: null })
  })
})


describe('调用时间来自实际 transport 边界', () => {
  test('重试单独记录开始和结束时间，不沿用前次时间或计入等待', async () => {
    /** 模拟跨日期工具等待/重试后时间推进，不依赖测试机器时钟。 */
    let now = 1_000
    let attempts = 0
    const observations: unknown[] = []
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    try {
      await streamSSE({ request, adapter: new OpenAIAdapter('openai'), onEvent: () => {}, fetchFn: fakeFetch(() => {
        attempts++
        now = attempts === 1 ? 1_100 : 2_100
        if (attempts === 1) throw new Error('retry network')
        return streamResponse([])
      }), onUsageAttempt: (_usage, status, timing) => {
        observations.push({ status, timing })
        now = 2_000
      } })
      expect(observations).toEqual([
        { status: 'failed', timing: { startedAt: 1_000, finishedAt: 1_100 } },
        { status: 'completed', timing: { startedAt: 2_000, finishedAt: 2_100 } },
      ])
    } finally { clock.mockRestore() }
  })
  test('请求取消记录真实结束时间，旧两参数观察器仍兼容', async () => {
    /** 手动时钟使取消边界的断言不依赖执行速度。 */
    let now = 4_000
    /** 收集取消观察结果，确保不存在重试或重复收口。 */
    const observations: unknown[] = []
    /** 在 fetch 已开始后推进到取消时刻。 */
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    try {
      await expect(streamSSE({ request, adapter: new OpenAIAdapter('openai'), onEvent: () => {}, fetchFn: fakeFetch(() => {
        now = 4_500
        throw new DOMException('cancelled', 'AbortError')
      }), onUsageAttempt: (usage, status, timing) => observations.push({ usage, status, timing }) })).rejects.toThrow('cancelled')
      expect(observations).toEqual([{ usage: null, status: 'cancelled', timing: { startedAt: 4_000, finishedAt: 4_500 } }])
    } finally { clock.mockRestore() }
  })
  test('标题失败也报告本次 fetch 的起止时间', async () => {
    let now = 3_000
    const observations: unknown[] = []
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    try {
      await fetchTitle(request, new OpenAIAdapter('openai'), fakeFetch(() => {
        now = 3_200
        return new Response('', { status: 401 })
      }), (_usage, status, timing) => observations.push({ status, timing }))
      expect(observations).toEqual([{ status: 'failed', timing: { startedAt: 3_000, finishedAt: 3_200 } }])
    } finally { clock.mockRestore() }
  })
})
