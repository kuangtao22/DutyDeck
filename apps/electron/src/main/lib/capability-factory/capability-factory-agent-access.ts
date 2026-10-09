import { isOrdinaryTopLevelAgentSession } from '@proma/shared'
import type { AgentSessionMeta } from '@proma/shared'

/** 宿主事实：来源、当前会话与存储根均不由模型提供。 */
interface CapabilityFactoryAccessOptions {
  sessionId: string
  toolMode: string
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'external'
  automation?: boolean
  getSession(sessionId: string): AgentSessionMeta | undefined
  getRootDir(workspaceId: string): string | null
  assertWritable(workspaceId: string): void
}

/** 仅普通前台会话获得完整操作面；返回的检查在每次读写与异步阶段重复核验归属。 */
export function createCapabilityFactoryAgentAccess(options: CapabilityFactoryAccessOptions) {
  const initial = options.getSession(options.sessionId)
  if (options.toolMode !== 'standard' || options.automation || (options.triggeredBy && options.triggeredBy !== 'user')
    || !isOrdinaryTopLevelAgentSession(initial) || initial.archived || !initial.workspaceId
    || initial.explorationParentSessionId !== undefined) return null
  const workspaceId = initial.workspaceId
  const rootDir = options.getRootDir(workspaceId)
  if (!rootDir) return null
  /** 取消信号单独处理，允许仍有归属的已停止批次保存真实终态。 */
  const assertCurrent = (): void => {
    const current = options.getSession(options.sessionId)
    if (!isOrdinaryTopLevelAgentSession(current) || current.id !== options.sessionId || current.archived
      || current.workspaceId !== workspaceId || current.explorationParentSessionId !== undefined
      || (current.toolMode ?? 'standard') !== 'standard' || options.getRootDir(workspaceId) !== rootDir) {
      throw new Error('编排工厂会话归属已变化')
    }
    options.assertWritable(workspaceId)
  }
  return { rootDir, workspaceId, assertCurrent }
}
