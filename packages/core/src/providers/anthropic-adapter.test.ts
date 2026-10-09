import { describe, expect, test } from 'bun:test'
import type { ProviderType } from '@proma/shared'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { setPromaVersion } from './user-agent.ts'

function buildRequest(provider: ProviderType, apiKey = 'test-key') {
  const adapter = new AnthropicAdapter(provider)
  const baseUrl = provider === 'xiaomi-token-plan'
    ? 'https://token-plan-cn.xiaomimimo.com/anthropic'
    : provider === 'qwen-token-plan'
      ? 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages'
      : provider === 'zhipu-coding-team'
      ? 'https://open.bigmodel.cn/api/anthropic'
      : 'https://api.xiaomimimo.com/anthropic'

  return adapter.buildStreamRequest({
    baseUrl,
    apiKey,
    modelId: 'mimo-v2.6-pro',
    history: [],
    userMessage: 'ping',
    readImageAttachments: () => [],
  })
}

describe('AnthropicAdapter headers', () => {
  test('xiaomi API uses api-key authentication', () => {
    const request = buildRequest('xiaomi')

    expect(request.headers['api-key']).toBe('test-key')
    expect(request.headers.Authorization).toBeUndefined()
    expect(request.headers['User-Agent']).toBeUndefined()
  })

  test('xiaomi token plan keeps bearer authentication with DutyDeck User-Agent', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest('xiaomi-token-plan')

    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['User-Agent']).toBe('DutyDeck/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['api-key']).toBeUndefined()
  })

  test('qwen token plan uses the complete Anthropic endpoint with bearer authentication and DutyDeck User-Agent', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest('qwen-token-plan')

    expect(request.url).toBe('https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages')
    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['User-Agent']).toBe('DutyDeck/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['x-api-key']).toBeUndefined()
  })

  test('zhipu team plan uses apiKey from JSON for model calls', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest(
      'zhipu-coding-team',
      '{"apiKey":"model-key","organization":"org","project":"proj"}',
    )

    expect(request.headers.Authorization).toBe('Bearer model-key')
    expect(request.headers['User-Agent']).toBe('DutyDeck/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['api-key']).toBeUndefined()
  })
})

describe('AnthropicAdapter 显式关闭思考', () => {
  test('Given 采样参数 When buildStreamRequest Then 透传 temperature 与 max_tokens', () => {
    const adapter = new AnthropicAdapter('zhipu-coding')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'test-key',
      modelId: 'glm-5.3', history: [], userMessage: '只返回 JSON',
      temperature: 0.1, maxTokens: 321, thinkingEnabled: false, readImageAttachments: () => [],
    })
    const body = JSON.parse(request.body) as { temperature?: number; max_tokens?: number }
    expect(body.temperature).toBe(0.1)
    expect(body.max_tokens).toBe(321)
  })

  test('Given GLM 不支持关闭思考 When 调用方关闭 Then 归一化为有效 high', () => {
    const adapter = new AnthropicAdapter('zhipu-coding')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'test-key',
      modelId: 'glm-5.3', history: [], userMessage: '只返回 JSON',
      thinkingEnabled: false, readImageAttachments: () => [],
    })
    const body = JSON.parse(request.body) as { thinking?: unknown; output_config?: unknown }
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  test('Given 不支持禁用字段的 Token Plan When 关闭思考 Then 仍省略 thinking', () => {
    const adapter = new AnthropicAdapter('qwen-token-plan')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://example.invalid', apiKey: 'test-key',
      modelId: 'qwen3.7-max', history: [], userMessage: '测试',
      thinkingEnabled: false, readImageAttachments: () => [],
    })
    expect(JSON.parse(request.body).thinking).toBeUndefined()
  })

  test('Given DeepSeek V4 Pro 请求 low When 构建请求 Then 保留有效 low 而不是固定 max', () => {
    const adapter = new AnthropicAdapter('deepseek')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'test-key',
      modelId: 'deepseek-v4-pro', history: [], userMessage: '测试',
      thinkingEnabled: true, thinkingLevel: 'low', readImageAttachments: () => [],
    })
    expect(JSON.parse(request.body).output_config).toEqual({ effort: 'low' })
  })

  test('Given Claude 支持 effort When 请求 low Then adaptive 请求携带 low', () => {
    const adapter = new AnthropicAdapter('anthropic')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://api.anthropic.com', apiKey: 'test-key',
      modelId: 'claude-opus-4-7', history: [], userMessage: '测试',
      thinkingEnabled: true, thinkingLevel: 'low', readImageAttachments: () => [],
    })
    const body = JSON.parse(request.body) as { thinking?: unknown; output_config?: unknown }
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'low' })
  })

  test('Given Claude 不支持 temperature When 调用方传入温度 Then 请求省略 temperature', () => {
    const adapter = new AnthropicAdapter('anthropic')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://api.anthropic.com', apiKey: 'test-key',
      modelId: 'claude-opus-4-7', history: [], userMessage: '测试',
      temperature: 0.2, readImageAttachments: () => [],
    })
    expect(JSON.parse(request.body).temperature).toBeUndefined()
  })

  test('Given manual thinking 开启 When 构建请求 Then 预算合法且省略 temperature', () => {
    const adapter = new AnthropicAdapter('anthropic')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://api.anthropic.com', apiKey: 'test-key',
      modelId: 'claude-haiku-4-5', history: [], userMessage: '测试',
      thinkingEnabled: true, thinkingLevel: 'minimal', temperature: 0.2,
      maxTokens: 5000, readImageAttachments: () => [],
    })
    const body = JSON.parse(request.body) as { thinking?: { budget_tokens?: number }; temperature?: number }

    expect(body.thinking?.budget_tokens).toBeGreaterThanOrEqual(1024)
    expect(body.thinking?.budget_tokens).toBeLessThan(5000)
    expect(body.temperature).toBeUndefined()
  })

  test('Given maxTokens 无法容纳 manual 最小预算 When 构建请求 Then 明确拒绝', () => {
    const adapter = new AnthropicAdapter('anthropic')

    expect(() => adapter.buildStreamRequest({
      baseUrl: 'https://api.anthropic.com', apiKey: 'test-key',
      modelId: 'claude-haiku-4-5', history: [], userMessage: '测试',
      thinkingEnabled: true, thinkingLevel: 'minimal', maxTokens: 1024,
      readImageAttachments: () => [],
    })).toThrow('budget_tokens')
  })

  test('Given manual 高档位和可用的较小输出上限 When 构建请求 Then 收紧预算并保持用户输出上限', () => {
    /** 高档预算应服从调用方总上限，不能拒绝仍容得下最低思考预算的合法请求。 */
    const request = new AnthropicAdapter('anthropic').buildStreamRequest({
      baseUrl: 'https://api.anthropic.com', apiKey: 'test-key',
      modelId: 'claude-haiku-4-5', history: [], userMessage: '测试',
      thinkingEnabled: true, thinkingLevel: 'high', maxTokens: 5000,
      readImageAttachments: () => [],
    })
    /** 输出硬上限和协议预算必须同时满足。 */
    const body = JSON.parse(request.body) as { max_tokens: number; thinking: { budget_tokens: number } }
    expect(body.max_tokens).toBe(5000)
    expect(body.thinking.budget_tokens).toBeGreaterThanOrEqual(1024)
    expect(body.thinking.budget_tokens).toBeLessThan(5000)
  })

  test('Given 显式输出上限超过模型能力 When 构建 Anthropic 请求 Then 清晰拒绝', () => {
    const adapter = new AnthropicAdapter('anthropic')

    expect(() => adapter.buildStreamRequest({
      baseUrl: 'https://api.anthropic.com', apiKey: 'test-key',
      modelId: 'claude-haiku-4-5', history: [], userMessage: '测试',
      maxTokens: 64001, readImageAttachments: () => [],
    })).toThrow('maxTokens')
  })
})

describe('AnthropicAdapter 流内错误', () => {
  test('Given HTTP 成功后返回 error 事件 When 解析 Then 保留服务端错误供调用方结束请求', () => {
    const adapter = new AnthropicAdapter('zhipu-coding')
    expect(adapter.parseSSELine(JSON.stringify({
      type: 'error', error: { type: 'overloaded_error', message: '模型暂时繁忙' },
    }))).toEqual([{ type: 'error', error: '模型暂时繁忙' }])
  })
})
