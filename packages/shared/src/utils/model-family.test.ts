import { describe, expect, test } from 'bun:test'
import { isCodexFastModeSupportedModel } from '../types/agent'
import { resolveReasoningProfile } from '../types/reasoning-profile'
import { inferContextWindow } from './context-window'
import { isGpt6AstraFamily, isGpt6SolFamily, isGpt6LunaFamily } from './model-family'

describe('Pi 0.87 GPT-6 能力一致性', () => {
  test.each(['gpt-6-sol', 'gpt-6-luna'])('Given %s When 选择模型 Then UI 与请求使用相同窗口、推理和 Fast Mode', (modelId) => {
    /** 两种协议必须使用一致的可选推理档位。 */
    for (const transport of ['openai-completions', 'openai-responses'] as const) {
      const profile = resolveReasoningProfile({ modelId, transport })
      expect(profile?.levels).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
      expect(profile?.normalize(undefined)).toBe('medium')
      expect(profile?.normalize('minimal')).toBe('low')
      expect(profile?.encodings[transport]?.effortMap?.off).toBe('none')
    }
    expect(inferContextWindow(modelId)).toBe(372_000)
    expect(isCodexFastModeSupportedModel(modelId)).toBe(true)
  })

  test('Given 历史 ID 大小写与上下文后缀 When 识别 Then 仍正确识别家族', () => {
    expect(isGpt6SolFamily(' GPT-6-SOL[1m] ')).toBe(true)
    expect(isGpt6LunaFamily('GPT-6-LUNA')).toBe(true)
    expect(isGpt6AstraFamily('gpt-6-astra-high')).toBe(true)
    expect(inferContextWindow('gpt-6-astra-high')).toBe(372_000)
  })

  test.each(['gpt-6-solar', 'gpt-6-luna-preview', 'gpt-6-astrafoo', 'gpt-6-astra-'])('Given 相似但未验证名称 %s When 识别 Then 不套用官方能力', (modelId) => {
    expect(isCodexFastModeSupportedModel(modelId)).toBe(false)
    expect(resolveReasoningProfile({ modelId, transport: 'openai-responses' })).toBeUndefined()
  })
})
