/** 工厂共享调用账本：同步预留避免 map 并发透支，持久化失败时不放行。 */
import { randomUUID } from 'node:crypto'
import type { CapabilityFactoryCallRecord, CapabilityFactoryCallUsage } from '@proma/shared'

/** 宿主冻结的次数和时间限制；货币硬封顶尚无可靠的供应商计价上界。 */
export interface CapabilityFactoryCallLedgerOptions {
  maxCalls: number
  maxTransportAttempts?: number
  deadlineAt?: number
  hardCurrencyLimit?: number
  initialRecords?: CapabilityFactoryCallRecord[]
  /** 同步原子持久化；抛错时必须阻止发送。 */
  onChange?: (records: CapabilityFactoryCallRecord[]) => void
  now?: () => number
}
/** 请求前提交的模型身份与取消信号。 */
export interface CapabilityFactoryCallReservation {
  purpose: CapabilityFactoryCallRecord['purpose']
  stepId: string
  channelId: string
  modelId: string
  signal?: AbortSignal
}
/** 金额和用量必须是有限非负数；不能让 NaN 污染汇总。 */
function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
/** 次数必须可精确加总，拒绝浮点计数和超过安全整数的值。 */
function safeCount(value: unknown): value is number {
  return finiteNonnegative(value) && Number.isSafeInteger(value)
}
/** 持久 usage 来自不可信 JSON，缺失整体只能显式为 null。 */
function validUsage(value: unknown): value is CapabilityFactoryCallUsage | null {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  /** 供应商字段必须逐项验证；可选缓存字段缺失不代表零。 */
  const usage = value as Record<string, unknown>
  return finiteNonnegative(usage.inputTokens) && finiteNonnegative(usage.outputTokens)
    && (usage.cacheReadTokens === undefined || finiteNonnegative(usage.cacheReadTokens))
    && (usage.cacheWriteTokens === undefined || finiteNonnegative(usage.cacheWriteTokens))
}
/** 验证恢复记录及累计传输计数，返回可信总额；不修改原始证据。 */
function validateInitialRecords(records: CapabilityFactoryCallRecord[]): number {
  if (!Array.isArray(records)) throw new Error('持久调用记录无效')
  /** 身份重复会使后续结算指向错误请求，必须拒绝恢复。 */
  const ids = new Set<string>()
  /** 累计值在每次加法后验证，避免大整数溢出绕过预算。 */
  let attempts = 0
  for (const record of records) {
    if (!record || typeof record !== 'object'
      || ![record.id, record.stepId, record.channelId, record.modelId].every((value) => typeof value === 'string' && value.trim().length > 0)
      || ids.has(record.id) || !['execution', 'review', 'retry'].includes(record.purpose)
      || !['reserved', 'completed', 'failed', 'cancelled'].includes(record.status)
      || !safeCount(record.transportAttempts) || typeof record.sent !== 'boolean' || typeof record.hiddenRetriesPossible !== 'boolean'
      || !finiteNonnegative(record.startedAt) || !(record.finishedAt === null || finiteNonnegative(record.finishedAt))
      || !(record.durationMs === null || finiteNonnegative(record.durationMs))
      || !validUsage(record.usage) || !(record.amount === null || finiteNonnegative(record.amount))
      || !(record.priceSource === null || typeof record.priceSource === 'string')
      || !['not-sent', 'unknown'].includes(record.billing)
      || (record.sent !== (record.transportAttempts > 0))
      || (record.billing !== (record.sent ? 'unknown' : 'not-sent'))
      || (record.status === 'reserved' ? record.finishedAt !== null || record.durationMs !== null
        : record.finishedAt === null || record.durationMs === null)) throw new Error('持久调用记录无效')
    ids.add(record.id)
    attempts += record.transportAttempts
    if (!safeCount(attempts)) throw new Error('持久调用记录累计传输次数溢出')
  }
  return attempts
}
/** 只支持可信次数/期限限制，不把未知供应商账单包装为硬金额保证。 */
export function createCapabilityFactoryCallLedger(options: CapabilityFactoryCallLedgerOptions) {
  if (!safeCount(options.maxCalls)) throw new Error('调用额度必须是非负整数')
  if (options.maxTransportAttempts !== undefined && !safeCount(options.maxTransportAttempts)) throw new Error('传输额度必须是非负整数')
  if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) throw new Error('截止时间无效')
  if (options.hardCurrencyLimit !== undefined) throw new Error('缺少可靠价格和用量上界，不能保证硬金额封顶')
  /** 复制历史防止宿主意外修改正在执行的额度。 */
  const records = structuredClone(options.initialRecords === undefined ? [] : options.initialRecords)
  /** 每次发送只更新可信计数，不反复遍历全部历史；恢复仍逐项完整验证。 */
  let transportAttempts = validateInitialRecords(records)
  if (records.length > options.maxCalls) throw new Error('持久调用记录超过调用额度')
  if (options.maxTransportAttempts !== undefined && transportAttempts > options.maxTransportAttempts) throw new Error('持久调用记录超过传输额度')
  /** 落盘失败后同一账本永久失去新发送权限，等待上层终止实验。 */
  let persistenceFailed = false
  /** 时钟可注入以离线验证截止条件。 */
  const now = options.now ?? Date.now
  /** 每次变更保存完整小账本；不逐 token 写盘。 */
  const persist = (): void => {
    try { options.onChange?.(structuredClone(records)) } catch (error) {
      persistenceFailed = true
      throw error
    }
  }
  /** 每个发送边界均重新校验信号和期限。 */
  const assertAvailable = (signal?: AbortSignal): void => {
    if (persistenceFailed) throw new Error('调用账本持久化失败，禁止继续发送')
    signal?.throwIfAborted()
    if (options.deadlineAt !== undefined && now() >= options.deadlineAt) throw new Error('实验已到截止时间')
  }
  /** 不接受不存在的预留身份。 */
  const requireRecord = (id: string): CapabilityFactoryCallRecord => {
    const record = records.find((entry) => entry.id === id)
    if (!record || record.status !== 'reserved') throw new Error('调用预留不存在或已经结算')
    return record
  }
  return {
    /** 返回脱离内部状态的可持久化快照。 */
    snapshot: (): CapabilityFactoryCallRecord[] => structuredClone(records),
    /** 返回预留 ID；检查、记账和持久化不跨异步间隙。 */
    reserve(request: CapabilityFactoryCallReservation): string {
      assertAvailable(request.signal)
      if (records.length >= options.maxCalls) throw new Error('实验调用额度已用尽')
      const id = randomUUID()
      records.push({ id, purpose: request.purpose, stepId: request.stepId, channelId: request.channelId,
        modelId: request.modelId, startedAt: now(), finishedAt: null, durationMs: null, status: 'reserved',
        sent: false, transportAttempts: 0, hiddenRetriesPossible: false, usage: null, amount: null,
        priceSource: null, billing: 'not-sent' })
      persist()
      return id
    },
    /** 必须在真实传输前调用；每个 SSE 内部重试都消耗传输额度。 */
    markSent(id: string, signal?: AbortSignal, hiddenRetriesPossible = false): void {
      assertAvailable(signal)
      const record = requireRecord(id)
      if (transportAttempts >= Number.MAX_SAFE_INTEGER || (options.maxTransportAttempts !== undefined && transportAttempts >= options.maxTransportAttempts)) throw new Error('实验传输额度已用尽')
      record.sent = true
      record.billing = 'unknown'
      record.transportAttempts += 1
      transportAttempts += 1
      record.hiddenRetriesPossible ||= hiddenRetriesPossible
      persist()
    },
    /** 所有终态保留额度；已经发送但失败的请求可能计费，不能退款式回收。 */
    settle(id: string, result: { status: 'completed' | 'failed' | 'cancelled'; usage?: CapabilityFactoryCallUsage }): void {
      const record = requireRecord(id)
      if (result.usage !== undefined && !validUsage(result.usage)) throw new Error('调用用量无效')
      record.status = result.status
      record.finishedAt = now()
      record.durationMs = Math.max(0, record.finishedAt - record.startedAt)
      record.usage = result.usage ? structuredClone(result.usage) : null
      persist()
    },
  }
}
/** 一个实验所有阶段、并行项和评审共享该实例。 */
export type CapabilityFactoryCallLedger = ReturnType<typeof createCapabilityFactoryCallLedger>
