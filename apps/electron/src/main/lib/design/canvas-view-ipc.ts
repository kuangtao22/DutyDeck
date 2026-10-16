import { CANVAS_VIEW_IPC_CHANNELS, isCanvasViewCommandTarget } from '@proma/shared'
import type { CanvasViewCommandTarget } from '@proma/shared'
import type { IpcMainInvokeEvent } from 'electron'
import type { CanvasViewCommandService } from './canvas-view-command-service'
import { isSafeDesignStableId } from './design-paths'

/** 主窗口 invoke 注册能力，不接收 renderer 自报 sender 身份。 */
interface CanvasViewIpcRegistrar {
  handle: (channel: string, handler: (event: IpcMainInvokeEvent, value?: unknown) => unknown) => void
  removeHandler: (channel: string) => void
}
/** IPC 复用主进程唯一视图路由器与 fresh 关联校验。 */
export interface CanvasViewIpcOptions {
  ipc: CanvasViewIpcRegistrar
  service: Pick<CanvasViewCommandService, 'register' | 'respond'>
  isAuthorizedSender: (event: IpcMainInvokeEvent) => boolean
  assertTargetAuthorized: (target: CanvasViewCommandTarget) => void
}
/** 注册前台视图身份及单次回执入口，返回可重复清理的注册结果。 */
export function registerCanvasViewIpcHandlers(options: CanvasViewIpcOptions): { dispose: () => void } {
  /** 仅声明本注册器拥有的两个 invoke 通道。 */
  const channels = [CANVAS_VIEW_IPC_CHANNELS.REGISTER, CANVAS_VIEW_IPC_CHANNELS.RESPONSE]
  for (const channel of channels) options.ipc.removeHandler(channel)
  options.ipc.handle(CANVAS_VIEW_IPC_CHANNELS.REGISTER, (event, value) => {
    if (!options.isAuthorizedSender(event)) throw new Error('CANVAS_VIEW_ACCESS_DENIED')
    if (value === null) { options.service.register(event.sender.id, null); return }
    if (!isCanvasViewCommandTarget(value)
      || Object.keys(value).length !== 3
      || !isSafeDesignStableId(value.projectId)
      || !isSafeDesignStableId(value.sessionId)
      || !isSafeDesignStableId(value.canvasId)) throw new Error('CANVAS_VIEW_INVALID_TARGET')
    /** 登记前校验当前普通 Agent 与目标画布的真实持久化关联。 */
    options.assertTargetAuthorized(value)
    options.service.register(event.sender.id, {
      projectId: value.projectId, sessionId: value.sessionId, canvasId: value.canvasId,
    })
  })
  options.ipc.handle(CANVAS_VIEW_IPC_CHANNELS.RESPONSE, (event, value) => {
    if (!options.isAuthorizedSender(event)) throw new Error('CANVAS_VIEW_ACCESS_DENIED')
    return options.service.respond(event.sender.id, value)
  })
  return { dispose: () => { for (const channel of channels) options.ipc.removeHandler(channel) } }
}
