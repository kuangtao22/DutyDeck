import { describe, expect, test } from 'bun:test'
import { GoogleAdapter } from './google-adapter.ts'

/** 构造 Google 请求并返回可断言的请求体。 */
function buildBody(overrides: Partial<Parameters<GoogleAdapter['buildStreamRequest']>[0]> = {}): Record<string, unknown> {
  const adapter = new GoogleAdapter()
  const request = adapter.buildStreamRequest({
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'test-key',
    modelId: 'gemini-3-flash-preview',
    history: [],
    userMessage: '测试',
    readImageAttachments: () => [],
    ...overrides,
  })
  return JSON.parse(request.body) as Record<string, unknown>
}

describe('GoogleAdapter 请求参数', () => {
  test('Given Gemini 支持思考深度 When 请求 medium Then 写入 MEDIUM', () => {
    const body = buildBody({ thinkingEnabled: true, thinkingLevel: 'medium' })

    expect(body.generationConfig).toEqual(expect.objectContaining({
      thinkingConfig: { includeThoughts: true, thinkingLevel: 'MEDIUM' },
    }))
  })

  test('Given Gemini 关闭思考 When 构建请求 Then 显式写入零预算', () => {
    const body = buildBody({
      modelId: 'gemini-2.5-flash',
      thinkingEnabled: false,
      thinkingLevel: 'off',
    })

    expect(body.generationConfig).toEqual(expect.objectContaining({
      thinkingConfig: { includeThoughts: false, thinkingBudget: 0 },
    }))
  })

  test('Given 快照声明模型不支持思考 When 调用方开启 Then 不写入 thinkingConfig', () => {
    const body = buildBody({
      modelId: 'lyria-3-pro-preview',
      thinkingEnabled: true,
      thinkingLevel: 'high',
    })

    expect(body.generationConfig).toBeUndefined()
  })

  test('Given Gemini Flash Lite 支持 toggle When 关闭思考 Then 忽略开启态最小预算并发送零预算', () => {
    const body = buildBody({
      modelId: 'gemini-2.5-flash-lite',
      thinkingEnabled: false,
      thinkingLevel: 'off',
    })

    expect(body.generationConfig).toEqual(expect.objectContaining({
      thinkingConfig: { includeThoughts: false, thinkingBudget: 0 },
    }))
  })

  test('Given Google toggle-only Gemma When 开启思考 Then 写入 HIGH 等级', () => {
    const body = buildBody({
      modelId: 'gemma-4-31b-it',
      thinkingEnabled: true,
      thinkingLevel: 'high',
    })

    expect(body.generationConfig).toEqual(expect.objectContaining({
      thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' },
    }))
  })

  test('Given 显式输出上限超过模型能力 When 构建 Google 请求 Then 清晰拒绝', () => {
    expect(() => buildBody({ maxTokens: 65537 })).toThrow('maxTokens')
  })
})
