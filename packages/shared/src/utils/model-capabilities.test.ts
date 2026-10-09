import { describe, expect, test } from 'bun:test'
import { getModelCapabilities, getModelReasoningCapability } from './model-capabilities'

describe('端点能力查询边界', () => {
  test('Given API 与订阅同名模型 When 查询 Then 不跨供应商填充订阅能力', () => {
    expect(getModelCapabilities('openai', 'gpt-6-astra')?.contextWindow).toBe(1_050_000)
    expect(getModelCapabilities('openai-codex', 'gpt-6-astra')).toBeUndefined()
    expect(getModelCapabilities('custom', 'gpt-6-astra')).toBeUndefined()
  })

  test.each(['constructor', '__proto__'])('Given 非模型键 %s When 查询 Then 明确返回未知', (modelId) => {
    expect(getModelCapabilities('openai', modelId)).toBeUndefined()
  })

  test('Given Gemini 默认强度 When 从快照生成能力 Then 保持已知产品偏好', () => {
    expect(getModelReasoningCapability('google', 'gemini-3.8-flash')?.defaultLevel).toBe('medium')
    expect(getModelReasoningCapability('google', 'gemini-3.1-flash-lite')?.defaultLevel).toBe('minimal')
  })

  test('Given Claude 预算模式 When 展示开关 Then 开启后的最低预算不等于禁止关闭', () => {
    expect(getModelReasoningCapability('anthropic', 'claude-opus-4-5')?.levels).toContain('off')
  })
})
