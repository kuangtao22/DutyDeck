import { describe, expect, test } from 'bun:test'
import { estimateTokens as estimateCodingAgentTokens } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai/compat'
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import { estimateContextTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'

/** 构造用于预算测试的最小 OpenAI Completions 模型。 */
function createBudgetModel(): Model<Api> {
  return {
    id: 'deepseek-flash-test',
    name: 'DeepSeek Flash test',
    api: 'openai-completions',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    input: ['text'],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  }
}

describe('Pi 上下文 token 预算', () => {
  test('Given ASCII 与中文混合文本 When 估算 Then 非 ASCII 字符不会按四分之一低估', () => {
    expect(estimateTextTokens('a'.repeat(4_000))).toBe(1_000)
    expect(estimateTextTokens('中'.repeat(4_000))).toBe(4_000)
    expect(estimateTextTokens(`${'a'.repeat(2_000)}${'中'.repeat(2_000)}`)).toBe(2_500)
  })

  test('Given 截图中的 935k 中文上下文 When 计算 DeepSeek Flash 请求预算 Then maxTokens 收紧到剩余窗口', () => {
    const context = normalizeContext({
      messages: [{ role: 'user', content: '中'.repeat(935_061), timestamp: 1 }],
    })
    const model = createBudgetModel()

    expect(estimateContextTokens(context).tokens).toBe(935_061)
    expect(clampMaxTokensToContext(model, context, model.maxTokens)).toBe(60_843)
  })

  test('Given coding-agent 自动压缩使用同一条消息 When 估算中文消息 Then 压缩阈值与发送预算保持一致', () => {
    expect(estimateCodingAgentTokens({
      role: 'user',
      content: '中'.repeat(4_000),
      timestamp: 1,
    })).toBe(4_000)
  })
})
