/** 普通整链运行的可选硬限额；不承诺未知单价下的金额封顶。 */
export interface CapabilityFactoryRunLimits {
  /** 最多逻辑调用数，包含执行与评审。 */
  maxCalls: number
  /** 最多可观测传输尝试次数。 */
  maxTransportAttempts: number
  /** 绝对截止时间，Unix 毫秒；过期判断由运行时完成。 */
  deadlineAt: number
}

/** 校验不可信限额并返回独立快照；只检查结构与整数边界，不读取时钟。 */
export function validateCapabilityFactoryRunLimits(value: unknown): CapabilityFactoryRunLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CAPABILITY_FACTORY_INVALID: limits')
  }
  /** 显式三字段白名单防止把额外执行控制带入运行时。 */
  const limits = value as Record<string, unknown>
  if (Object.keys(limits).length !== 3 || Object.keys(limits).some((key) => !['maxCalls', 'maxTransportAttempts', 'deadlineAt'].includes(key))) {
    throw new Error('CAPABILITY_FACTORY_INVALID: limits')
  }
  /** 分别限制逻辑调用、可观察传输和绝对时间的安全整数范围。 */
  for (const [key, maximum] of [['maxCalls', 1000], ['maxTransportAttempts', 2000], ['deadlineAt', Number.MAX_SAFE_INTEGER]] as const) {
    if (typeof limits[key] !== 'number' || !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) {
      throw new Error(`CAPABILITY_FACTORY_INVALID: limits.${key}`)
    }
  }
  return { maxCalls: limits.maxCalls as number, maxTransportAttempts: limits.maxTransportAttempts as number, deadlineAt: limits.deadlineAt as number }
}

/** 供应商实际返回的 token 用量；缺少用量时整项为 null，不推断为零。 */
export interface CapabilityFactoryCallUsage {
  /** 输入 token。 */
  inputTokens: number
  /** 输出 token。 */
  outputTokens: number
  /** 缓存读取 token；供应商未提供时省略。 */
  cacheReadTokens?: number
  /** 缓存写入 token；供应商未提供时省略。 */
  cacheWriteTokens?: number
}
/** 可序列化的一次逻辑调用及其可观察传输尝试。 */
export interface CapabilityFactoryCallRecord {
  /** 账本内唯一身份。 */
  id: string
  /** 调用目的；重试同样消耗一个逻辑额度。 */
  purpose: 'execution' | 'review' | 'retry'
  /** 所属步骤和真实模型。 */
  stepId: string
  channelId: string
  modelId: string
  /** 预留/结算时间及实际耗时，毫秒。 */
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  /** 未结算的调用也占用额度，恢复时不重发。 */
  status: 'reserved' | 'completed' | 'failed' | 'cancelled'
  /** 是否已经到达供应商发送边界。 */
  sent: boolean
  /** 可观察到的传输启动次数；不包含不可见供应商重试。 */
  transportAttempts: number
  /** Pi/供应商内部重试无法完整观测。 */
  hiddenRetriesPossible: boolean
  /** 用量、金额未知时明确为 null；订阅不视为免费。 */
  usage: CapabilityFactoryCallUsage | null
  amount: number | null
  priceSource: string | null
  billing: 'not-sent' | 'unknown'
}
