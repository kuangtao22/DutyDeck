import * as React from 'react'
import { sameCanvasViewTarget } from '@proma/shared'
import type { CanvasViewCommandRequest, CanvasViewCommandResponse, CanvasViewCommandTarget, CanvasViewSnapshot } from '@proma/shared'
import { createCanvasViewRequestHandler } from './native-canvas-view-command'

/** 可在真实 React 生命周期测试中注入的精简 Preload 边界。 */
export interface CanvasViewCommandBridge {
  registerCanvasViewTarget: (target: CanvasViewCommandTarget | null) => Promise<void>
  onCanvasViewCommand: (listener: (request: CanvasViewCommandRequest) => void) => () => void
  onCanvasViewCommandCancelled: (listener: (request: CanvasViewCommandTarget & { requestId: string }) => void) => () => void
  respondCanvasViewCommand: (response: CanvasViewCommandResponse) => Promise<void>
}
/** Hook 所需的当前前台业务上下文。 */
export interface CanvasViewCommandBridgeOptions {
  target: CanvasViewCommandTarget
  enabled: boolean
  bridge?: CanvasViewCommandBridge
  isAvailable: () => boolean
  execute: (request: CanvasViewCommandRequest, signal: AbortSignal) => Promise<CanvasViewSnapshot>
  observeAvailability: (changed: () => void) => () => void
}
/**
 * 注册当前前台会话，切换/卸载同步取消旧命令，实际执行结束后才发送回执。
 * @param options 宿主身份、真实命令和可见性观察边界。
 */
export function useCanvasViewCommandBridge(options: CanvasViewCommandBridgeOptions): void {
  /** callbacks 保持最新，而视口或选区更新不重置正在执行的命令。 */
  const latest = React.useRef(options)
  latest.current = options
  React.useEffect(() => {
    const bridge = options.bridge
    if (!options.enabled || !bridge) return
    const target = options.target
    let mounted = true
    const available = (): boolean => mounted && latest.current.enabled
      && sameCanvasViewTarget(target, latest.current.target) && latest.current.isAvailable()
    const handler = createCanvasViewRequestHandler({
      isAvailable: (request) => sameCanvasViewTarget(target, request) && available(),
      execute: (request, signal) => latest.current.execute(request, signal),
    })
    const releaseRequest = bridge.onCanvasViewCommand((request) => {
      if (!sameCanvasViewTarget(target, request)) return
      void handler.handle(request).then((response) => bridge.respondCanvasViewCommand(response)).catch(() => undefined)
    })
    const releaseCancel = bridge.onCanvasViewCommandCancelled((request) => {
      if (sameCanvasViewTarget(target, request)) handler.cancel(request.requestId)
    })
    const register = (): void => {
      if (!available()) handler.cancelActive()
      void bridge.registerCanvasViewTarget(available() ? target : null).catch(() => undefined)
    }
    const releaseAvailability = latest.current.observeAvailability(register)
    register()
    return () => {
      mounted = false
      handler.dispose()
      releaseAvailability()
      releaseRequest()
      releaseCancel()
      void bridge.registerCanvasViewTarget(null).catch(() => undefined)
    }
  }, [options.enabled, options.target.projectId, options.target.sessionId, options.target.canvasId, options.bridge])
}
