import { describe, expect, test } from 'bun:test'
import { OpenAIAdapter } from './openai-adapter.ts'

/** 构造 OpenAI Chat 请求并返回可断言的请求体。 */
function buildBody(overrides: Partial<Parameters<OpenAIAdapter['buildStreamRequest']>[0]> = {}): Record<string, unknown> {
  const adapter = new OpenAIAdapter('openai')
  const request = adapter.buildStreamRequest({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    modelId: 'gpt-5.1',
    history: [],
    userMessage: '测试',
    readImageAttachments: () => [],
    ...overrides,
  })
  return JSON.parse(request.body) as Record<string, unknown>
}

describe('OpenAIAdapter 请求参数', () => {
  test('Given 支持关闭推理的模型 When thinkingEnabled=false Then 显式发送 none', () => {
    const body = buildBody({ thinkingEnabled: false, thinkingLevel: 'off' })

    expect(body.reasoning_effort).toBe('none')
  })

  test('Given 仅支持 high 的模型 When 请求 xhigh Then 归一化为 high', () => {
    const body = buildBody({ modelId: 'gpt-5-pro', thinkingEnabled: true, thinkingLevel: 'xhigh' })

    expect(body.reasoning_effort).toBe('high')
  })

  test('Given 模型不支持 temperature When 调用方传入温度 Then 请求省略 temperature', () => {
    const body = buildBody({ modelId: 'gpt-5-pro', temperature: 0.2 })

    expect(body.temperature).toBeUndefined()
  })

  test('Given 工具续接包含本轮推理 When 构建请求 Then assistant 回传 reasoning_content', () => {
    const body = buildBody({
      continuationMessages: [{
        role: 'assistant',
        content: '',
        reasoning: '先查询项目状态',
        toolCalls: [{ id: 'call-1', name: 'status', arguments: {} }],
      }],
    })

    expect(body.messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      reasoning_content: '先查询项目状态',
    }))
  })

  test('Given effort 原始关闭值为 none When 关闭思考 Then 不把产品 off 发给协议', () => {
    const body = buildBody({
      modelId: 'gpt-daybreak-blue-latest',
      thinkingEnabled: false,
      thinkingLevel: 'off',
    })

    expect(body.reasoning_effort).toBe('none')
  })

  test('Given ZAI toggle 模型 When 开启思考 Then 写入已验证 thinking 字段', () => {
    const adapter = new OpenAIAdapter('zhipu')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'test-key',
      modelId: 'glm-4.7', history: [], userMessage: '测试',
      thinkingEnabled: true, thinkingLevel: 'high', readImageAttachments: () => [],
    })
    const body = JSON.parse(request.body) as Record<string, unknown>

    expect(body.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect(body.reasoning_effort).toBeUndefined()
  })

  test('Given Qwen toggle+budget 模型 When 请求 low Then 写入开关与合法预算', () => {
    const adapter = new OpenAIAdapter('qwen')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'test-key',
      modelId: 'qwen3.7-plus', history: [], userMessage: '测试',
      thinkingEnabled: true, thinkingLevel: 'low', readImageAttachments: () => [],
    })
    const body = JSON.parse(request.body) as { enable_thinking?: boolean; thinking_budget?: number }

    expect(body.enable_thinking).toBe(true)
    expect(body.thinking_budget).toBeGreaterThan(0)
    expect(body.thinking_budget).toBeLessThan(64000)
  })

  test('Given Qwen effort 使用 none When 关闭思考 Then 回写 none 并关闭开关', () => {
    const adapter = new OpenAIAdapter('qwen')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'test-key',
      modelId: 'qwen3.8-omni-flash', history: [], userMessage: '测试',
      thinkingEnabled: false, thinkingLevel: 'off', readImageAttachments: () => [],
    })
    const body = JSON.parse(request.body) as { enable_thinking?: boolean; reasoning_effort?: string }

    expect(body.enable_thinking).toBe(false)
    expect(body.reasoning_effort).toBe('none')
  })

  test('Given 显式输出上限超过模型能力 When 构建请求 Then 清晰拒绝', () => {
    expect(() => buildBody({ modelId: 'gpt-5.1', maxTokens: 128001 })).toThrow('maxTokens')
  })

  test('Given OpenAI reasoning 模型 When 指定输出上限 Then 使用 max_completion_tokens', () => {
    const body = buildBody({ modelId: 'gpt-5.1', maxTokens: 32000 })

    expect(body.max_completion_tokens).toBe(32000)
    expect(body.max_tokens).toBeUndefined()
  })

  test('Given 未知模型 When 显式输出上限有效 Then 保留原值', () => {
    const body = buildBody({ modelId: 'private-model', maxTokens: 999999 })

    expect(body.max_tokens).toBe(999999)
  })

  test('Given Qwen 思考预算无法小于输出上限 When 构建请求 Then 清晰拒绝', () => {
    const adapter = new OpenAIAdapter('qwen')

    expect(() => adapter.buildStreamRequest({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'test-key',
      modelId: 'qwen3.7-plus', history: [], userMessage: '测试',
      thinkingEnabled: true, thinkingLevel: 'low', maxTokens: 1,
      readImageAttachments: () => [],
    })).toThrow('thinking_budget')
  })

  test.each([0, Number.POSITIVE_INFINITY])(
    'Given maxTokens=%p When 构建请求 Then 拒绝非法数值',
    (maxTokens) => {
      expect(() => buildBody({ maxTokens })).toThrow('maxTokens')
    },
  )
})
