import { randomUUID } from 'node:crypto'
import { CANVAS_VIEW_IPC_CHANNELS, isCanvasViewCommand, isCanvasViewCommandResponse, isCanvasViewCommandTarget, isCanvasViewResponseWithinBudget, sameCanvasViewTarget } from '@proma/shared'
import type { CanvasViewCommand, CanvasViewCommandRequest, CanvasViewCommandResponse, CanvasViewCommandTarget, CanvasViewSnapshot } from '@proma/shared'

/** 主进程提供窗口存活/可见检查与定向发送，禁止广播。 */
export interface CanvasViewCommandServiceDependencies {
  isAvailable: (senderId: number, target: CanvasViewCommandTarget) => boolean
  send: (senderId: number, channel: string, payload: unknown) => void
}
/** 每次请求的取消、鉴权与有界等待参数。 */
export interface CanvasViewCommandExecutionOptions {
  signal?: AbortSignal
  assertAuthorized?: () => void
  timeoutMs?: number
  requestId?: string
}
/** 活跃请求保存匹配所需身份和统一终结器。 */
interface PendingCanvasViewCommand {
  senderId: number
  request: CanvasViewCommandRequest
  finish: (response?: CanvasViewCommandResponse, error?: string) => void
}
/** 创建会话视图路由器。返回注册、执行、应答与清理接口，所有写操作仍由既有业务入口处理。 */
export function createCanvasViewCommandService(dependencies: CanvasViewCommandServiceDependencies) {
  /** 每个窗口最多登记一个前台目标。 */
  const targets = new Map<number, CanvasViewCommandTarget>()
  /** 活跃请求在取消、超时或目标切换时立即失效。 */
  const pending = new Map<string, PendingCanvasViewCommand>()
  return {
    /** 主进程提交写锁获准后重新检查前台宿主，不能复用准备阶段的旧登记。 */
    assertAvailable(target: CanvasViewCommandTarget): void {
      if (![...targets].some(([senderId, registered]) => sameCanvasViewTarget(registered, target)
        && dependencies.isAvailable(senderId, target))) throw new Error('CANVAS_VIEW_NOT_AVAILABLE')
    },
    register(senderId: number, target: CanvasViewCommandTarget | null): void {
      const previous = targets.get(senderId)
      if (!target || (previous && !sameCanvasViewTarget(previous, target))) {
        for (const entry of [...pending.values()]) {
          if (entry.senderId === senderId) entry.finish(undefined, 'CANVAS_VIEW_NOT_AVAILABLE')
        }
      }
      if (target) targets.set(senderId, { ...target })
      else targets.delete(senderId)
    },
    execute(target: CanvasViewCommandTarget, command: CanvasViewCommand, options: CanvasViewCommandExecutionOptions = {}): Promise<CanvasViewSnapshot> {
      options.assertAuthorized?.()
      if (!isCanvasViewCommand(command)) return Promise.reject(new Error('CANVAS_VIEW_INVALID_COMMAND'))
      if (options.signal?.aborted) return Promise.reject(new Error('CANVAS_VIEW_CANCELLED'))
      const receiver = [...targets].find(([senderId, registered]) => sameCanvasViewTarget(registered, target)
        && dependencies.isAvailable(senderId, target))
      if (!receiver) return Promise.reject(new Error('CANVAS_VIEW_NOT_AVAILABLE'))
      const senderId = receiver[0]
      const requestId = options.requestId ?? randomUUID()
      if (pending.has(requestId)) return Promise.reject(new Error('CANVAS_VIEW_REQUEST_CONFLICT'))
      const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 12_000, 15_000))
      const request: CanvasViewCommandRequest = { ...target, command, requestId, expiresAt: Date.now() + timeoutMs }
      return new Promise((resolve, reject) => {
        const abort = (): void => finish(undefined, 'CANVAS_VIEW_CANCELLED')
        const timer = setTimeout(() => finish(undefined, 'CANVAS_VIEW_TIMEOUT'), timeoutMs)
        const finish = (response?: CanvasViewCommandResponse, error?: string): void => {
          if (!pending.delete(requestId)) return
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', abort)
          if (error) {
            try { dependencies.send(senderId, CANVAS_VIEW_IPC_CHANNELS.CANCEL, { ...target, requestId }) } catch { /* 窗口已销毁仍必须结束等待。 */ }
            reject(new Error(error))
            return
          }
          try {
            options.assertAuthorized?.()
            if (!dependencies.isAvailable(senderId, target)) throw new Error('CANVAS_VIEW_NOT_AVAILABLE')
            if (!response?.ok) throw new Error(response?.code ?? 'CANVAS_VIEW_NOT_AVAILABLE')
            resolve(response.snapshot)
          } catch (failure) { reject(failure) }
        }
        pending.set(requestId, { senderId, request, finish })
        options.signal?.addEventListener('abort', abort, { once: true })
        try { dependencies.send(senderId, CANVAS_VIEW_IPC_CHANNELS.REQUEST, request) }
        catch { finish(undefined, 'CANVAS_VIEW_NOT_AVAILABLE') }
      })
    },
    respond(senderId: number, response: unknown): boolean {
      if (!isCanvasViewCommandTarget(response) || !('requestId' in response) || typeof response.requestId !== 'string') return false
      const entry = pending.get(response.requestId)
      if (!entry || entry.senderId !== senderId || !sameCanvasViewTarget(entry.request, response)) return false
      if (!isCanvasViewResponseWithinBudget(response)) {
        entry.finish(undefined, 'CANVAS_VIEW_RESPONSE_TOO_LARGE')
        return true
      }
      if (!isCanvasViewCommandResponse(response)) return false
      if (response.ok) {
        const command = entry.request.command
        const arrangement = response.snapshot.arrangement
        if (command.action === 'arrange'
          ? !arrangement || arrangement.expectedRevision !== command.expectedRevision || response.snapshot.revision !== command.expectedRevision
          : arrangement !== undefined) {
          entry.finish(undefined, 'CANVAS_VIEW_INVALID_RESPONSE')
          return true
        }
      }
      entry.finish(response)
      return true
    },
    dispose(): void {
      for (const entry of [...pending.values()]) entry.finish(undefined, 'CANVAS_VIEW_NOT_AVAILABLE')
      targets.clear()
    },
  }
}
/** 生产与测试共享的路由器实例类型。 */
export type CanvasViewCommandService = ReturnType<typeof createCanvasViewCommandService>
