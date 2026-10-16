import { describe, expect, test } from 'bun:test'
import { CANVAS_VIEW_IPC_CHANNELS } from '@proma/shared'
import type { IpcMainInvokeEvent } from 'electron'
import { registerCanvasViewIpcHandlers } from './canvas-view-ipc'
import { createCanvasViewCommandService } from './canvas-view-command-service'

/** 生成可信或非可信 IPC sender 事件。 */
function event(senderId: number): IpcMainInvokeEvent {
  return { sender: { id: senderId } } as unknown as IpcMainInvokeEvent
}

describe('Canvas 视图 IPC 可信边界', () => {
  test('Given 非主窗口或非法目标 When 注册 Then 在路由登记前拒绝', () => {
    /** 注册器持有的 invoke handlers。 */
    const handlers = new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => unknown>()
    /** 主进程记录的有效登记次数。 */
    let registered = 0
    /** 目标授权必须匹配原会话关联。 */
    const registration = registerCanvasViewIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      service: { register: () => { registered += 1 }, respond: () => false },
      isAuthorizedSender: (source) => source.sender.id === 1,
      assertTargetAuthorized: (target) => { if (target.sessionId !== 'agent-1') throw new Error('DENIED') },
    })
    /** 实际注册入口。 */
    const register = handlers.get(CANVAS_VIEW_IPC_CHANNELS.REGISTER)!
    expect(() => register(event(2), null)).toThrow('CANVAS_VIEW_ACCESS_DENIED')
    expect(() => register(event(1), { projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'other' })).toThrow('DENIED')
    expect(() => register(event(1), { projectId: '../escape', canvasId: 'canvas-1', sessionId: 'agent-1' })).toThrow('CANVAS_VIEW_INVALID_TARGET')
    expect(() => register(event(1), { projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'agent-1', extra: true })).toThrow('CANVAS_VIEW_INVALID_TARGET')
    expect(registered).toBe(0)
    register(event(1), null)
    expect(registered).toBe(1)
    registration.dispose()
    expect(handlers.size).toBe(0)
  })

  test('Given 请求绑定某窗口 When 跨窗口应答或会话撤权 Then 无法伪造成功回执', async () => {
    /** 已安装的 IPC handlers。 */
    const handlers = new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => unknown>()
    /** 原会话授权可在等待期间失效。 */
    let authorized = true
    /** 完整的原会话视图目标。 */
    const target = { projectId: 'project-1', canvasId: 'canvas-1', sessionId: 'agent-1' }
    /** 真实服务校验 sender 和回执中的全部身份。 */
    const service = createCanvasViewCommandService({ isAvailable: () => authorized, send: () => undefined })
    registerCanvasViewIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      service,
      isAuthorizedSender: () => true,
      assertTargetAuthorized: () => { if (!authorized) throw new Error('DENIED') },
    })
    handlers.get(CANVAS_VIEW_IPC_CHANNELS.REGISTER)!(event(1), target)
    /** 待等待的实际视图请求。 */
    const pending = service.execute(target, { action: 'query' }, { requestId: 'request-1' })
    /** 失败回执无需携带完整快照，仍必须匹配窗口。 */
    const response = { ...target, requestId: 'request-1', ok: false, code: 'CANVAS_EXAMPLE' }
    expect(handlers.get(CANVAS_VIEW_IPC_CHANNELS.RESPONSE)!(event(2), response)).toBe(false)
    authorized = false
    expect(handlers.get(CANVAS_VIEW_IPC_CHANNELS.RESPONSE)!(event(1), response)).toBe(true)
    await expect(pending).rejects.toThrow('CANVAS_VIEW_NOT_AVAILABLE')
    service.dispose()
  })
})
