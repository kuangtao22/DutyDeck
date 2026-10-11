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
