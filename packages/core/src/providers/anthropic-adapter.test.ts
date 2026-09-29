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
    modelId: 'mimo-v2.5-pro',
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
  test('Given GLM 默认开启思考 When 调用方关闭 Then 请求显式发送 disabled', () => {
    const adapter = new AnthropicAdapter('zhipu-coding')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'test-key',
      modelId: 'glm-5.3', history: [], userMessage: '只返回 JSON',
      thinkingEnabled: false, readImageAttachments: () => [],
    })
    expect(JSON.parse(request.body).thinking).toEqual({ type: 'disabled' })
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
})

describe('AnthropicAdapter 流内错误', () => {
  test('Given HTTP 成功后返回 error 事件 When 解析 Then 保留服务端错误供调用方结束请求', () => {
    const adapter = new AnthropicAdapter('zhipu-coding')
    expect(adapter.parseSSELine(JSON.stringify({
      type: 'error', error: { type: 'overloaded_error', message: '模型暂时繁忙' },
    }))).toEqual([{ type: 'error', error: '模型暂时繁忙' }])
  })
})
