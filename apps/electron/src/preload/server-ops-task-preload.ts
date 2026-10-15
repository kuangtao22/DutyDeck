import { SERVER_OPS_TASK_IPC_CHANNELS, parseServerOpsTaskSummary, parseServerOpsTaskTarget, parseServerOpsTaskReadInput, parseServerOpsTaskReadResult, parseServerOpsTaskUserInput, parseServerOpsTaskUserResize } from '../../../../packages/shared/src/types/server-ops-task-session'
import type { ServerOpsTaskSummary, ServerOpsTaskTarget, ServerOpsTaskReadInput, ServerOpsTaskReadResult, ServerOpsTaskUserInput, ServerOpsTaskUserResize } from '@proma/shared'
import type { ServerOpsConsolePreloadIpc } from './server-ops-console-preload'

/** 远程任务桥接；输入只来自用户终端，页面卸载不终止任务。 */
export interface ServerOpsTaskPreloadApi {
  listServerOpsTasks(sessionId: string): Promise<ServerOpsTaskSummary[]>
  readServerOpsTask(input: ServerOpsTaskReadInput): Promise<ServerOpsTaskReadResult>
  writeServerOpsTask(input: ServerOpsTaskUserInput): Promise<void>
  resizeServerOpsTask(input: ServerOpsTaskUserResize): Promise<void>
  interruptServerOpsTask(input: ServerOpsTaskTarget): Promise<ServerOpsTaskSummary>
  onServerOpsTaskChanged(listener: (task: ServerOpsTaskSummary) => void): () => void
}

/** DTO 或响应身份非法时统一拒绝。 */
function invalid(): never { throw new Error('SERVER_OPS_TASK_RESULT_INVALID') }
/** 响应必须属于发起读取的精确会话和任务。 */
function match(task: ServerOpsTaskSummary, input: ServerOpsTaskTarget): ServerOpsTaskSummary {
  if (task.sessionId !== input.sessionId || task.taskId !== input.taskId) return invalid()
  return task
}
/** 构造可单测的 IPC 桥，校验所有返回值及事件身份。 */
export function createServerOpsTaskPreload(ipc: ServerOpsConsolePreloadIpc): ServerOpsTaskPreloadApi {
  /** void IPC 返回额外负载时拒绝。 */
  const invokeVoid = async (channel: string, input: unknown): Promise<void> => { if (await ipc.invoke(channel, input) !== undefined) invalid() }
  return {
    listServerOpsTasks: async (sessionId) => {
      parseServerOpsTaskTarget({ sessionId, taskId: 'list' })
      const result = await ipc.invoke(SERVER_OPS_TASK_IPC_CHANNELS.LIST, sessionId)
      if (!Array.isArray(result)) return invalid()
      return result.map((value) => { const task = parseServerOpsTaskSummary(value); if (task.sessionId !== sessionId) return invalid(); return task })
    },
    readServerOpsTask: async (input) => {
      const request = parseServerOpsTaskReadInput(input)
      const result = parseServerOpsTaskReadResult(await ipc.invoke(SERVER_OPS_TASK_IPC_CHANNELS.READ, request))
      match(result.task, request)
      if (request.offset !== undefined && (result.offset !== Math.max(request.offset, result.availableStartOffset)
        || result.truncatedBefore !== (request.offset < result.availableStartOffset))) return invalid()
      return result
    },
    writeServerOpsTask: (input) => invokeVoid(SERVER_OPS_TASK_IPC_CHANNELS.WRITE, parseServerOpsTaskUserInput(input)),
    resizeServerOpsTask: (input) => invokeVoid(SERVER_OPS_TASK_IPC_CHANNELS.RESIZE, parseServerOpsTaskUserResize(input)),
    interruptServerOpsTask: async (input) => match(parseServerOpsTaskSummary(await ipc.invoke(SERVER_OPS_TASK_IPC_CHANNELS.INTERRUPT, parseServerOpsTaskTarget(input))), input),
    onServerOpsTaskChanged: (listener) => {
      const bridge = (_event: unknown, value: unknown): void => { listener(parseServerOpsTaskSummary(value)) }
      ipc.on(SERVER_OPS_TASK_IPC_CHANNELS.CHANGED, bridge)
      return () => ipc.removeListener(SERVER_OPS_TASK_IPC_CHANNELS.CHANGED, bridge)
    },
  }
}
