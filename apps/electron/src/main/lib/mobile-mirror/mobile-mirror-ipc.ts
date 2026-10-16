import { MOBILE_MIRROR_CHANNELS, parseMobileMirrorSessionInput, parseMobileMirrorCaptureInput, parseMobileMirrorActionInput } from '@proma/shared'
import type { MobileMirrorService } from './service'

/** IPC 只将窗口身份传给服务；frame 的真实性由 Electron 入口检查。 */
export interface MobileMirrorIpcEvent { sender: { id: number } }
/** 生产主进程提供窗口授权和生命周期监听，测试可替换为纯内存实现。 */
interface MobileMirrorIpcDependencies {
  ipc: { handle(channel: string, handler: (event: MobileMirrorIpcEvent, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void }
  service: Pick<MobileMirrorService, 'open' | 'listDevices' | 'capture' | 'performAction' | 'close' | 'closeOwner' | 'dispose'>
  isAuthorizedSender(event: MobileMirrorIpcEvent): boolean
  watchOwner(event: MobileMirrorIpcEvent, invalidate: () => void): () => void
}

/** 注册有限手机接口；导航代次隔离同一 WebContents 中的旧异步请求。 */
export function registerMobileMirrorIpc(deps: MobileMirrorIpcDependencies): { dispose(): Promise<void> } {
  /** 每个主窗口只装一套监听，重复打开面板不会累积监听器。 */
  const owners = new Map<number, { revision: number; unwatch: () => void }>()
  for (const channel of Object.values(MOBILE_MIRROR_CHANNELS)) {
    deps.ipc.handle(channel, async (event, raw) => {
      if (!deps.isAuthorizedSender(event)) throw new Error('MOBILE_MIRROR_ACCESS_DENIED')
      /** 先解析字段白名单，杜绝 renderer 注入命令、配置或任意工具名。 */
      const input = channel === MOBILE_MIRROR_CHANNELS.ACTION ? parseMobileMirrorActionInput(raw)
        : channel === MOBILE_MIRROR_CHANNELS.CAPTURE ? parseMobileMirrorCaptureInput(raw)
          : parseMobileMirrorSessionInput(raw)
      const ownerId = event.sender.id
      let owner = owners.get(ownerId)
      if (!owner) {
        owner = { revision: 0, unwatch: () => undefined }
        owners.set(ownerId, owner)
        owner.unwatch = deps.watchOwner(event, () => {
          const current = owners.get(ownerId)
          if (current) current.revision++
          void deps.service.closeOwner(ownerId).catch(() => undefined)
        })
      }
      const revision = owner.revision
      let result: unknown
      switch (channel) {
        case MOBILE_MIRROR_CHANNELS.OPEN: result = await deps.service.open(ownerId, input); break
        case MOBILE_MIRROR_CHANNELS.LIST_DEVICES: result = await deps.service.listDevices(ownerId, input); break
        case MOBILE_MIRROR_CHANNELS.CAPTURE: result = await deps.service.capture(ownerId, parseMobileMirrorCaptureInput(input)); break
        case MOBILE_MIRROR_CHANNELS.ACTION: result = await deps.service.performAction(ownerId, parseMobileMirrorActionInput(input)); break
        case MOBILE_MIRROR_CHANNELS.CLOSE: result = await deps.service.close(ownerId, input); break
      }
      /** 导航时已清理旧代次；迟到请求不能再次关闭新页面刚建立的连接。 */
      if (owner.revision !== revision) throw new Error('MOBILE_MIRROR_ACCESS_DENIED')
      if (!deps.isAuthorizedSender(event)) {
        await deps.service.closeOwner(ownerId)
        throw new Error('MOBILE_MIRROR_ACCESS_DENIED')
      }
      return result
    })
  }
  return {
    dispose: async () => {
      for (const channel of Object.values(MOBILE_MIRROR_CHANNELS)) deps.ipc.removeHandler(channel)
      for (const owner of owners.values()) { owner.revision++; owner.unwatch() }
      owners.clear()
      await deps.service.dispose()
    },
  }
}
