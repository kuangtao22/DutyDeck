/** 模型调用观察器：仅接受供应商报告，不读取提示词或推断费用。 */
import { randomUUID } from 'node:crypto'
import type { TokenUsageAmounts, TokenUsageRecord } from '@proma/shared'

/** 调用前冻结的归属信息，不包含终态及供应商计量。 */
export type TokenUsageContext = Omit<TokenUsageRecord, keyof TokenUsageAmounts | 'id' | 'startedAt' | 'finishedAt' | 'status' | 'origin'>
/** 实际请求进入供应商端口及收到终态的时刻，不包含工具和人工等待。 */
export interface TokenUsageTiming { startedAt: number; finishedAt: number }
/** 单次尝试结束回调；每次调用表示一条独立传输记录。 */
export type TokenUsageObserver = (usage: TokenUsageAmounts | null, status: TokenUsageRecord['status'], timing?: TokenUsageTiming) => void

/** 校验 Pi usage 并把独立缓存并入输入；失败默认零不视为供应商报告。 */
export function normalizePiTokenUsage(value: unknown, status: TokenUsageRecord['status'] = 'completed'): TokenUsageAmounts | null {
  if (!value || typeof value !== 'object') return null
  /** 供应商边界字段逐项验证，保留部分报告。 */
  const fields = value as Record<string, unknown>
  if (fields.reported === false) return null
  /** 仅接受安全的非负整型 Token。 */
  const token = (amount: unknown): number | null => typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? amount : null
  /** Pi input 不含缓存，cacheRead/cacheWrite 单独报告。 */
  const input = token(fields.input)
  /** 输出及两个缓存分量均保留未知。 */
  const output = token(fields.output)
  const cacheRead = token(fields.cacheRead)
  const cacheWrite = token(fields.cacheWrite)
  if (input === null && output === null && cacheRead === null && cacheWrite === null) return null
  if (status !== 'completed' && fields.reported !== true && !(input || output || cacheRead || cacheWrite)) return null
  /** 分量合法但总和溢出时仍保留未知，不能写入不精确计数。 */
  const totalInput = input === null ? null : input + (cacheRead ?? 0) + (cacheWrite ?? 0)
  return { inputTokens: totalInput !== null && Number.isSafeInteger(totalInput) ? totalInput : null, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
}

/** 创建只增量记录终态的观察器；sink 的异常不影响模型成功、失败或取消。 */
export function createTokenUsageObserver(context: TokenUsageContext, sink: (record: TokenUsageRecord) => void): TokenUsageObserver {
  /** 固定快照防止调用方后来修改归属；计时由实际调用端提供。 */
  const snapshot = { ...context }
  return (usage, status, timing) => {
    /** 旧观察端无计时只能使用终态时刻，不能沿用上轮结束来虚构等待时长。 */
    const finishedAt = timing?.finishedAt ?? Date.now()
    const startedAt = timing?.startedAt ?? finishedAt
    try {
      sink({ ...snapshot, id: randomUUID(), startedAt, finishedAt, status, origin: 'live', ...(usage ?? { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }) })
    } catch {
      console.warn('[Token 统计] 用量记录失败，模型调用结果不受影响')
    }
  }
}
