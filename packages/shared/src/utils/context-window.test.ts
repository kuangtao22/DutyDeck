import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CONTEXT_WINDOW,
  ONE_MILLION_CONTEXT_WINDOW,
  inferContextWindow,
  isMimoV26Model,
  supports1MContext,
} from './context-window'

describe('MiMo V2.6 上下文能力', () => {
  test('精确识别三个官方 V2.6 模型 ID，并归一化大小写和空白', () => {
    expect(isMimoV26Model('mimo-v2.6-pro')).toBe(true)
    expect(isMimoV26Model(' mimo-v2.6-flash ')).toBe(true)
    expect(isMimoV26Model('MIMO-V2.6-PRO-ULTRASPEED')).toBe(true)
  })

  test('不把 V2.5、未来版本或兼容模型名误判为 V2.6', () => {
    expect(isMimoV26Model('mimo-v2.5-pro')).toBe(false)
    expect(isMimoV26Model('mimo-v2.60-preview')).toBe(false)
    expect(isMimoV26Model('vendor-mimo-v2.6-compatible')).toBe(false)
    expect(supports1MContext('mimo-v2.60-preview')).toBe(false)
  })

  test('V2.6 与保留历史的 V2.5 模型使用 1M 上下文', () => {
    expect(inferContextWindow('mimo-v2.6-pro')).toBe(ONE_MILLION_CONTEXT_WINDOW)
    expect(inferContextWindow('mimo-v2.6-flash')).toBe(ONE_MILLION_CONTEXT_WINDOW)
    expect(inferContextWindow('mimo-v2.6-pro-ultraspeed')).toBe(ONE_MILLION_CONTEXT_WINDOW)
    expect(inferContextWindow('mimo-v2.5')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('未知相近模型仍使用默认上下文窗口', () => {
    expect(inferContextWindow('mimo-v2.60-preview')).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})
