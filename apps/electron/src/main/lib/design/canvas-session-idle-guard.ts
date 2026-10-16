import type { CanvasTarget, MediaRunSnapshot } from '@proma/shared'

/** 异步准备后必须在删除同一同步栈执行的检查及幂等清理。 */
export interface CanvasSessionIdleCheck {
  assertIdle: () => void
  dispose: () => void
}
/** 仅读现有运行事实，禁止恢复或提交任何媒体工作。 */
interface CanvasSessionIdleGuardDependencies {
  assertSynchronousIdle: (target: CanvasTarget) => void
  loadRunIds: (target: CanvasTarget) => Promise<string[]>
  runs: {
    get: (projectId: string, runId: string) => Pick<MediaRunSnapshot, 'phase'>
    getOrigin: (projectId: string, runId: string) => { canvasMedia?: CanvasTarget }
    subscribe: (listener: (run: MediaRunSnapshot) => void) => () => void
  }
}
/** 一次读取模块登记，期间捕获新运行；最终同步复查避免无限扫描。 */
export function createCanvasSessionIdleGuard(dependencies: CanvasSessionIdleGuardDependencies) {
  return async (target: CanvasTarget): Promise<CanvasSessionIdleCheck> => {
    dependencies.assertSynchronousIdle(target)
    /** 合并模块登记和异步读取期间新增的同图运行。 */
    const runIds = new Set<string>()
    /** 无法判断提交来源时保守拒删，不在观察者里抛错被调用方吞掉。 */
    let unreadableOrigin = false
    /** 订阅延续至实际删除前，不在异步函数返回时提前释放。 */
    const unsubscribe = dependencies.runs.subscribe((run) => {
      if (run.projectId !== target.projectId) return
      try {
        /** getOrigin 同步读取已持久化 manifest，来源不取自 renderer。 */
        const origin = dependencies.runs.getOrigin(run.projectId, run.id).canvasMedia
        if (origin?.projectId === target.projectId && origin.canvasId === target.canvasId) runIds.add(run.id)
      } catch { unreadableOrigin = true }
    })
    /** 清理可由异常路径及调用方 finally 重复执行。 */
    let disposed = false
    const dispose = (): void => { if (!disposed) { disposed = true; unsubscribe() } }
    try {
      for (const runId of await dependencies.loadRunIds(target)) runIds.add(runId)
      return {
        assertIdle: () => {
          if (disposed) throw new Error('CANVAS_SESSION_IDLE_CHECK_EXPIRED')
          dependencies.assertSynchronousIdle(target)
          if (unreadableOrigin) throw new Error('CANVAS_SESSION_BUSY: 媒体运行来源暂不可确认，请稍后重试。')
          for (const runId of runIds) {
            if (!['succeeded', 'failed', 'cancelled'].includes(dependencies.runs.get(target.projectId, runId).phase)) {
              throw new Error('CANVAS_SESSION_BUSY: 画布仍有音视频任务，请先停止后再删除。')
            }
          }
        },
        dispose,
      }
    } catch (error) { dispose(); throw error }
  }
}
