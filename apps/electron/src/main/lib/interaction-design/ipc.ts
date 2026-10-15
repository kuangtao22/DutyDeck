import { INTERACTION_DESIGN_CHANNELS, parseInteractionDesignCommand } from '@proma/shared'
import type { InteractionDesignExecutor } from './access'

/** 不泄漏 Electron 对象到业务服务的 sender 形状。 */
export interface InteractionDesignIpcEvent { sender: { id: number } }

/** 注册宿主最小能力。 */
export interface InteractionDesignIpcDependencies {
  /** 只注册一个严格解析的命令通道。 */
  ipc: { handle(channel: string, handler: (event: InteractionDesignIpcEvent, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void }
  /** 仅允许应用正式窗口。 */
  isAuthorizedSender(event: InteractionDesignIpcEvent): boolean
  /** 身份、项目路径和权限一律由宿主解析。 */
  createAccess(sessionId: string, assertCaller: () => void): InteractionDesignExecutor
}

/** 注册经过 sender、命令和会话三层校验的模块 IPC。 */
export function registerInteractionDesignIpc(dependencies: InteractionDesignIpcDependencies): { dispose(): void } {
  dependencies.ipc.handle(INTERACTION_DESIGN_CHANNELS.INVOKE, async (event, value) => {
    const assertCaller = (): void => {
      if (!dependencies.isAuthorizedSender(event)) throw new Error('INTERACTION_DESIGN_ACCESS_DENIED: 非法窗口')
    }
    assertCaller()
    const command = parseInteractionDesignCommand(value)
    const access = dependencies.createAccess(command.input.sessionId, assertCaller)
    return access.execute(command.method, command.input)
  })
  return { dispose: () => dependencies.ipc.removeHandler(INTERACTION_DESIGN_CHANNELS.INVOKE) }
}
