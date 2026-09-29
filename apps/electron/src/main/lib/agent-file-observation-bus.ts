/** 原始 watcher 信号在 UI 防抖前交给运行记录器，避免最后一次写入在结束后丢失。 */
const listeners = new Set<(path: string) => void>()

/** 订阅受管范围的原始变化路径；返回清理函数，不引入额外文件监听。 */
export function subscribeAgentFileObservations(listener: (path: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 发布已被现有 watcher 过滤的路径；订阅异常不得中断文件面板刷新。 */
export function publishAgentFileObservation(path: string): void {
  for (const listener of listeners) {
    try { listener(path) } catch (error) { console.warn('[本轮文件统计] 监听记录失败', error) }
  }
}
