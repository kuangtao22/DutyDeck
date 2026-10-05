import type { MobileStreamSegments } from '../atoms'

/**
 * 按既有 LAN Bridge 事件类型累计对应的实时文本。
 * @param current 当前回答与思考缓冲
 * @param eventType 区分回答和思考的服务端事件类型
 * @param delta 本次增量文本
 * @returns 只更新目标区域的新缓冲；空增量复用原引用
 */
export function appendMobileStreamDelta(
  current: MobileStreamSegments,
  eventType: 'stream.chunk' | 'stream.reasoning',
  delta: string,
): MobileStreamSegments {
  if (!delta) return current
  if (eventType === 'stream.reasoning') return { ...current, reasoning: current.reasoning + delta }
  return { ...current, answer: current.answer + delta }
}
