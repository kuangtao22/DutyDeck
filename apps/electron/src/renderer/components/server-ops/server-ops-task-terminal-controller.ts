import type { ServerOpsTaskSummary } from '@proma/shared'
import type { ServerOpsTaskPreloadApi } from '../../../preload/server-ops-task-preload'

/** xterm 最小接口；生产与测试使用同一读取生命周期。 */
export interface ServerOpsTaskTerminalSurface {
  readonly cols: number
  readonly rows: number
  write(data: string, callback?: () => void): void
  onData(listener: (data: string) => void): { dispose(): void }
  dispose(): void
}
/** 挂载依赖；错误必须显式展示，不能把读取或输入失败视为任务结束。 */
export interface ServerOpsTaskTerminalOptions {
  task: ServerOpsTaskSummary
  api: ServerOpsTaskPreloadApi
  terminal: ServerOpsTaskTerminalSurface
  fit(): void
  observeResize(callback: () => void): () => void
  onTask(task: ServerOpsTaskSummary): void
  onError(message: string): void
}

/** 订阅先于首次读取；合并通知并串行排空分页；卸载仅释放 UI 资源。 */
export function attachServerOpsTaskTerminal(options: ServerOpsTaskTerminalOptions): () => void {
  const { task, api, terminal } = options
  /** 完整连接代次也必须相同，防止错误主机任务混入当前终端。 */
  const matches = (value: ServerOpsTaskSummary): boolean => value.sessionId === task.sessionId && value.taskId === task.taskId
    && value.hostId === task.hostId && value.connectionId === task.connectionId
  /** 游标只在 xterm 完成渲染后推进；dirty 合并在途通知。 */
  let cursor = 0; let dirty = false; let reading = false; let disposed = false
  /** 最新状态约束尺寸同步，任务退出后不继续调整远端 PTY。 */
  let state = task.state
  /** 用户输入严格保序，且失败不记录原始输入（可能为密码）。 */
  let inputQueue = Promise.resolve()
  /** xterm 背压延续到读取下一页，防止 renderer 堆积全部输出。 */
  const write = (data: string): Promise<void> => new Promise((resolve) => { if (!data || disposed) resolve(); else terminal.write(data, resolve) })
  /** 对精确任务按游标读取，输出被裁剪时明确显示历史缺口。 */
  const drain = async (): Promise<void> => {
    if (reading || disposed) return
    reading = true
    try {
      while (dirty && !disposed) {
        dirty = false
        const result = await api.readServerOpsTask({ sessionId: task.sessionId, taskId: task.taskId, offset: cursor, waitMs: 0 })
        if (disposed) return
        if (!matches(result.task) || result.offset !== Math.max(cursor, result.availableStartOffset)
          || result.nextOffset - result.offset !== result.output.length
          || (result.truncatedAfter && result.nextOffset <= cursor)) throw new Error('任务输出身份或游标不匹配')
        if (result.truncatedBefore && result.offset > cursor) await write('\r\n\x1b[33m[较早输出已被裁剪]\x1b[0m\r\n')
        await write(result.output)
        if (disposed) return
        cursor = result.nextOffset; state = result.task.state; options.onTask(result.task)
        dirty = dirty || result.truncatedAfter
      }
    } catch { if (!disposed) options.onError('任务输出读取失败；可点击重新加载恢复输出。') }
    finally { reading = false }
  }
  /** 事件仅标记需要读取，不为每个输出片段并发调用 IPC。 */
  const unsubscribe = api.onServerOpsTaskChanged((value) => {
    if (!matches(value) || disposed) return
    const becameRunning = state !== 'running' && value.state === 'running'
    state = value.state; options.onTask(value)
    if (becameRunning) resize()
    dirty = true; void drain()
  })
  /** 写入来自用户的键盘；永远不经聊天或 Agent 工具。 */
  const input = terminal.onData((data) => {
    inputQueue = inputQueue.then(async () => { if (!disposed) await api.writeServerOpsTask({ sessionId: task.sessionId, taskId: task.taskId, data }) })
      .catch(() => { if (!disposed) options.onError('终端输入未发送，请检查任务与连接状态。') })
  })
  /** 只有可见且有尺寸的终端才通知远端调整 PTY。 */
  function resize(): void {
    if (disposed) return
    try { options.fit() } catch { return }
    if (state !== 'running') return
    void api.resizeServerOpsTask({ sessionId: task.sessionId, taskId: task.taskId, cols: Math.max(1, terminal.cols), rows: Math.max(1, terminal.rows) })
      .catch(() => { if (!disposed) options.onError('远程终端尺寸同步失败。') })
  }
  const unobserve = options.observeResize(resize)
  resize(); dirty = true; void drain()
  return () => { disposed = true; unsubscribe(); unobserve(); input.dispose(); terminal.dispose() }
}

/** 只接受订阅后创建、属于当前前台会话且首次出现的任务；快速退出同样可定位。 */
export function createServerOpsTaskFocusGate(sessionId: string, subscribedAt: number): (task: ServerOpsTaskSummary, foregroundSessionId: string | null) => boolean {
  /** 订阅生命期内所有见过的身份都记录，后台任务不得在切回后补抢焦点。 */
  const seen = new Set<string>()
  return (task, foregroundSessionId) => {
    if (task.sessionId !== sessionId || seen.has(task.taskId) || task.createdAt < subscribedAt) return false
    seen.add(task.taskId)
    return foregroundSessionId === sessionId
  }
}
