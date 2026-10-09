import type { KnowledgeSnapshot } from '@proma/shared'

/** 串行轮询只在前一请求完成后排下一次，生命周期结束后停止投递。 */
export function startKnowledgePolling(options: {
  /** 每次轮询读取当前可见性，隐藏窗口不发送 IPC。 */
  visible(): boolean
  /** 当前运行态或空闲态间隔。 */
  intervalMs: number
  /** 一次完整刷新，包含调用方的项目代次校验。 */
  refresh(): Promise<void>
  /** 可注入时钟，便于验证最大一个在途请求。 */
  schedule?(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  cancel?(timer: ReturnType<typeof setTimeout>): void
}): () => void {
  const schedule = options.schedule ?? setTimeout
  const cancel = options.cancel ?? clearTimeout
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async (): Promise<void> => {
    if (disposed) return
    try { if (options.visible()) await options.refresh() }
    catch { /* 调用方展示业务错误；失败后仍按预算继续下一轮。 */ }
    finally { if (!disposed) timer = schedule(() => { void tick() }, options.intervalMs) }
  }
  timer = schedule(() => { void tick() }, options.intervalMs)
  return () => { disposed = true; if (timer !== undefined) cancel(timer) }
}

export interface WaitForKnowledgeScanOptions {
  initialSnapshot: KnowledgeSnapshot
  getSnapshot(): Promise<KnowledgeSnapshot>
  isCurrent(): boolean
  onSnapshot(snapshot: KnowledgeSnapshot): void
  delay?(): Promise<void>
}

/**
 * 等待当前来源扫描结束，并在项目切换或取消后停止后续任务。
 * @param options 扫描初始快照、权威读取函数和调用方代次守卫。
 * @returns 完成快照；存在可用来源的部分失败也返回，供 Agent 带说明继续提炼。
 */
export async function waitForKnowledgeScan(options: WaitForKnowledgeScanOptions): Promise<KnowledgeSnapshot> {
  const delay = options.delay ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 600)))
  let snapshot = options.initialSnapshot
  while (snapshot.scan.status === 'running') {
    await delay()
    if (!options.isCurrent()) throw new Error('知识库扫描已失效')
    snapshot = await options.getSnapshot()
    if (!options.isCurrent()) throw new Error('知识库扫描已失效')
    options.onSnapshot(snapshot)
  }
  if (snapshot.scan.status === 'cancelled') throw new Error('知识库扫描已取消')
  if (snapshot.scan.status === 'failed' && (snapshot.sourceCount ?? 0) === 0) {
    throw new Error(snapshot.scan.message || '知识库扫描失败')
  }
  if (snapshot.scan.status !== 'completed' && snapshot.scan.status !== 'failed') {
    throw new Error('知识库扫描未完成')
  }
  return snapshot
}
