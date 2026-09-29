/** 注册表对外抛出的稳定码；读与写各有一组，避免把取消写成「查询已取消」。 */
export interface ServerOpsQueryRegistryCodes {
  busy: string
  cancelled: string
}

/** 写请求保留不可撤销的终态，并在来源级阻止重复提交；读取维持原取消语义。 */
interface ServerOpsQueryRegistryPolicy {
  preserveOutcome?: boolean
  singleFlightPerSource?: boolean
}

/** SQL 查询按真实窗口和请求身份归属，避免一个窗口取消另一个窗口的任务。 */
export class ServerOpsQueryRegistry {
  /** 当前实例使用的稳定码；默认保持既有只读查询语义。 */
  private readonly codes: ServerOpsQueryRegistryCodes

  /**
   * 创建注册表。
   *
   * @param codes 繁忙与取消的稳定码；写链传入自己的码，避免用户看到「查询已取消」
   */
  constructor(codes: ServerOpsQueryRegistryCodes = { busy: 'SERVER_OPS_SQL_BUSY', cancelled: 'SERVER_OPS_SQL_CANCELLED' }, private readonly policy: ServerOpsQueryRegistryPolicy = {}) {
    this.codes = codes
  }

  /** 条目一直保留到驱动结束清理，取消请求本身不释放执行槽。 */
  private readonly active = new Map<string, { owner: number; sourceId: string; controller: AbortController; done: Promise<void> }>()

  /** 在窗口与精确请求身份下执行；读取丢弃取消后的结果，写入保留实际终态。 */
  async run<T>(owner: number, input: { sourceId: string; queryId: string }, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    /** 元组编码避免用户 ID 中分隔符造成所有权碰撞。 */
    const key = JSON.stringify([owner, input.sourceId, input.queryId])
    if (this.active.has(key) || this.active.size >= 32) throw new Error(this.codes.busy)
    if (this.policy.singleFlightPerSource && [...this.active.values()].some((entry) => entry.sourceId === input.sourceId)) throw new Error(this.codes.busy)
    /** 结束通知只表示底层操作已退出，不携带业务结果。 */
    let finish!: () => void
    const entry = { owner, sourceId: input.sourceId, controller: new AbortController(), done: new Promise<void>((resolve) => { finish = resolve }) }
    this.active.set(key, entry)
    try {
      const result = await operation(entry.controller.signal)
      if (!this.policy.preserveOutcome && entry.controller.signal.aborted) throw new Error(this.codes.cancelled)
      return result
    } finally {
      this.active.delete(key)
      finish()
    }
  }

  /** 仅取消真实所有者的匹配查询；重复取消幂等，并等待真实清理完成。 */
  async cancel(owner: number, input: { sourceId: string; queryId: string }): Promise<void> {
    const entry = this.active.get(JSON.stringify([owner, input.sourceId, input.queryId]))
    if (!entry) return
    entry.controller.abort()
    await entry.done
  }

  /** 窗口关闭后立即中止本窗口查询，底层结束时自行移除条目。 */
  closeOwner(owner: number): void {
    for (const entry of this.active.values()) if (entry.owner === owner) entry.controller.abort()
  }

  /** IPC 注册器退出时中止所有在途读取，避免留下无人接收的结果。 */
  closeAll(): void {
    for (const entry of this.active.values()) entry.controller.abort()
  }
}
