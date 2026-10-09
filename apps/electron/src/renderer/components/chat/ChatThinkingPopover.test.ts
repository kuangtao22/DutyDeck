import { describe, expect, test } from 'bun:test'
import type { ReasoningCapability } from '@proma/shared'
import { resolveChatThinkingControlState } from './ChatThinkingPopover'

/** 支持关闭的测试能力。 */
const optionalReasoning: ReasoningCapability = {
  source: 'profile',
  levels: ['off', 'low', 'high'],
  defaultLevel: 'high',
}

/** 不支持关闭的测试能力。 */
const forcedReasoning: ReasoningCapability = {
  source: 'profile',
  levels: ['low', 'high', 'max'],
  defaultLevel: 'high',
}

describe('Chat 思考控件状态', () => {
  test('Given 支持关闭思考的已知模型 When 已保存 high Then 展示真实档位并允许关闭', () => {
    const state = resolveChatThinkingControlState({
      capability: optionalReasoning,
      knownNonReasoning: false,
      storedLevel: 'high',
      legacyEnabled: true,
    })

    expect(state).toEqual({
      mode: 'levels',
      levels: ['off', 'low', 'high'],
      effectiveLevel: 'high',
      enabled: true,
      canToggle: true,
    })
  })

  test('Given 可关闭模型沿用旧关闭开关 When 历史档位仍为 medium Then 保持关闭状态', () => {
    const state = resolveChatThinkingControlState({
      capability: optionalReasoning,
      knownNonReasoning: false,
      storedLevel: 'medium',
      legacyEnabled: false,
    })

    expect(state.effectiveLevel).toBe('off')
    expect(state.enabled).toBe(false)
  })

  test('Given 不支持 off 的强制思考模型 When 旧开关为关闭 Then 保持启用且不提供开关', () => {
    const state = resolveChatThinkingControlState({
      capability: forcedReasoning,
      knownNonReasoning: false,
      storedLevel: 'high',
      legacyEnabled: false,
    })

    expect(state.enabled).toBe(true)
    expect(state.canToggle).toBe(false)
    expect(state.mode).toBe('levels')
  })

  test('Given 强制思考模型和旧关闭状态 When 历史档位为 low Then UI 与请求都按 off 归一为 high', () => {
    /** 请求优先解释旧开关，界面不能单独展示已失效的历史 low。 */
    const state = resolveChatThinkingControlState({
      capability: forcedReasoning,
      knownNonReasoning: false,
      storedLevel: 'low',
      legacyEnabled: false,
    })

    expect(state.effectiveLevel).toBe('high')
  })

  test('Given 已知模型明确不支持思考 When 打开设置 Then 显示无思考且不展示档位', () => {
    const state = resolveChatThinkingControlState({
      capability: undefined,
      knownNonReasoning: true,
      storedLevel: 'high',
      legacyEnabled: true,
    })

    expect(state).toEqual({
      mode: 'unsupported',
      levels: [],
      effectiveLevel: undefined,
      enabled: false,
      canToggle: false,
    })
  })

  test('Given 切换到只支持 low/high 的模型 When 原档位为 max Then 归一化到模型支持的档位', () => {
    const capability: ReasoningCapability = {
      source: 'profile',
      levels: ['low', 'high'],
      defaultLevel: 'low',
    }

    const state = resolveChatThinkingControlState({
      capability,
      knownNonReasoning: false,
      storedLevel: 'max',
      legacyEnabled: true,
    })

    expect(state.effectiveLevel).toBe('high')
  })

  test('Given 未知模型 When 使用旧设置 Then 保留通用布尔开关', () => {
    const state = resolveChatThinkingControlState({
      capability: undefined,
      knownNonReasoning: false,
      storedLevel: 'medium',
      legacyEnabled: true,
    })

    expect(state).toEqual({
      mode: 'legacy-toggle',
      levels: [],
      effectiveLevel: undefined,
      enabled: true,
      canToggle: true,
    })
  })

  test('Given 已知思考模型未声明可控档位 When 使用旧设置 Then 不误判为无思考', () => {
    const state = resolveChatThinkingControlState({
      capability: undefined,
      knownNonReasoning: false,
      storedLevel: 'medium',
      legacyEnabled: false,
    })

    expect(state.mode).toBe('legacy-toggle')
    expect(state.enabled).toBe(false)
  })
})
