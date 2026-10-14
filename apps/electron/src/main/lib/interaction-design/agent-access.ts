import { isOrdinaryTopLevelAgentSession } from '@proma/shared'
import type { AgentSessionMeta } from '@proma/shared'
import type { InteractionDesignExecutor } from './access'

/** 前台运行事实由编排器提供，不允许工具参数声明来源。 */
interface InteractionAgentAccessOptions {
  sessionId: string
  toolMode: string
  triggeredBy?: string
  automation: boolean
  getSession(sessionId: string): AgentSessionMeta | undefined
  assertRunActive(): void
  canWrite(): boolean
  createAccess(sessionId: string, options: { assertCaller(): void; canWrite(): boolean }): InteractionDesignExecutor
}

/** 仅当前普通前台运行注册能力，且每次调用重新检查归属、模式和取消状态。 */
export function createInteractionDesignAgentAccess(options: InteractionAgentAccessOptions): InteractionDesignExecutor | null {
  /** 当前会话的初始归属。 */
  const initial = options.getSession(options.sessionId)
  if (options.toolMode !== 'standard' || options.automation || (options.triggeredBy && options.triggeredBy !== 'user')
    || !isOrdinaryTopLevelAgentSession(initial) || initial.archived || !initial.workspaceId
    || initial.explorationParentSessionId !== undefined) return null
  /** 固定标量身份，不能持有随后可能被就地更新的会话对象引用。 */
  const workspaceId = initial.workspaceId
  return options.createAccess(options.sessionId, {
    canWrite: options.canWrite,
    assertCaller: () => {
      options.assertRunActive()
      /** 后续回合不能继承已改变的运行归属。 */
      const current = options.getSession(options.sessionId)
      if (!isOrdinaryTopLevelAgentSession(current) || current.archived || current.workspaceId !== workspaceId
        || current.explorationParentSessionId !== undefined || (current.toolMode ?? 'standard') !== 'standard') {
        throw new Error('INTERACTION_DESIGN_ACCESS_CHANGED: Agent 运行归属已变化')
      }
    },
  })
}
