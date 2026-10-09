/** 批次取消归属只保存在宿主；模型不能声明会话、根目录或运行代际。 */
interface ActiveFactoryBatch {
  sessionId: string
  batchId?: string
  controller: AbortController
}

/** 同一工作区场景只运行一个批次，避免两个入口重复消耗并覆盖上下文。 */
const activeBatches = new Map<string, ActiveFactoryBatch>()

/** 宿主执行端口：受信任归属与实际批次执行器。 */
interface FactoryBatchControlOptions<T> {
  rootDir: string
  sessionId: string
  sceneId: string
  signal?: AbortSignal
  execute(signal: AbortSignal, bindBatchId: (batchId: string) => void): Promise<T>
}

/** 为一次批次持有取消信号与场景锁，结束或失败均释放；返回执行器的真实结果。 */
export async function withCapabilityFactoryBatchControl<T>(options: FactoryBatchControlOptions<T>): Promise<T> {
  /** JSON 元组避免路径和标识中的分隔符形成键碰撞。 */
  const key = JSON.stringify([options.rootDir, options.sceneId])
  if (activeBatches.has(key)) throw new Error('当前场景已有批次正在运行，请先等待或停止。')
  options.signal?.throwIfAborted()
  const entry: ActiveFactoryBatch = { sessionId: options.sessionId, controller: new AbortController() }
  activeBatches.set(key, entry)
  /** 外部回合停止和右侧停止按钮共同控制本批次。 */
  const signal = options.signal ? AbortSignal.any([entry.controller.signal, options.signal]) : entry.controller.signal
  try {
    return await options.execute(signal, (batchId) => {
      if (entry.batchId && entry.batchId !== batchId) throw new Error('批次身份发生变化')
      entry.batchId = batchId
    })
  } finally {
    if (activeBatches.get(key) === entry) activeBatches.delete(key)
  }
}

/** 只取消当前会话、根目录及场景匹配的活动批次；不删除已完成记录。 */
export function cancelCapabilityFactoryBatch(rootDir: string, sessionId: string, sceneId: string, batchId: string): boolean {
  const entry = activeBatches.get(JSON.stringify([rootDir, sceneId]))
  if (!entry || entry.sessionId !== sessionId || entry.batchId !== batchId) return false
  entry.controller.abort(new Error('用户停止了批次'))
  return true
}
