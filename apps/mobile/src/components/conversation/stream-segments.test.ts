import { describe, expect, test } from 'bun:test'
import { appendMobileStreamDelta } from '../../lib/stream-segments'
import type { MobileStreamSegments } from '../../atoms'

describe('移动端流式思考与回答分流', () => {
  test('Given 思考增量 When 合并 Then 只更新思考区域', () => {
    /** 已有回答用于证明思考增量不会污染最终回答。 */
    const current: MobileStreamSegments = { answer: '回答', reasoning: '' }
    /** 思考事件按 LAN Bridge 的现有事件名进入专属字段。 */
    const next = appendMobileStreamDelta(current, 'stream.reasoning', '思考')

    expect(next).toEqual({ answer: '回答', reasoning: '思考' })
  })

  test('Given 正文增量 When 合并 Then 只更新回答区域', () => {
    /** 已有思考用于证明正文增量不会污染思考区域。 */
    const current: MobileStreamSegments = { answer: '', reasoning: '推理' }
    /** 正文事件继续使用现有 stream.chunk 协议。 */
    const next = appendMobileStreamDelta(current, 'stream.chunk', '完成')

    expect(next).toEqual({ answer: '完成', reasoning: '推理' })
  })

  test('Given 空增量 When 合并 Then 保留原状态引用', () => {
    /** 空 delta 模拟协议允许但不产生可见字符的边界。 */
    const current: MobileStreamSegments = { answer: '原文', reasoning: '思考' }

    expect(appendMobileStreamDelta(current, 'stream.chunk', '')).toBe(current)
  })
})
