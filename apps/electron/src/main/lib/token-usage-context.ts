/** 在主进程冻结会话归属；不把提示词或项目路径写入统计。 */
import { randomUUID } from 'node:crypto'
import type { TokenUsageSource } from '@proma/shared'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { listConversations } from './conversation-manager'
import type { TokenUsageContext } from './token-usage-observer'

/** 解析根 Agent 任务和工作区；删除会话后已经记录的快照不受影响。 */
export function agentTokenUsageContext(sessionId: string | undefined, source: TokenUsageSource = 'agent'): Pick<TokenUsageContext, 'taskId' | 'taskTitle' | 'sessionId' | 'sessionType' | 'projectId' | 'projectName' | 'source'> {
  /** 子任务只改变来源，不把父任务汇总重复作为调用。 */
  const session = readUsageSnapshot(() => sessionId ? getAgentSessionMeta(sessionId) : undefined)
  const rootId = session?.rootSessionId ?? session?.parentSessionId ?? sessionId
  const root = readUsageSnapshot(() => rootId ? getAgentSessionMeta(rootId) : undefined)
  const workspaceId = session?.workspaceId ?? root?.workspaceId
  const workspace = readUsageSnapshot(() => workspaceId ? getAgentWorkspace(workspaceId) : undefined)
  return { taskId: rootId ? `agent:${rootId}` : `background:${randomUUID()}`, taskTitle: root?.title ?? session?.title ?? '后台模型任务', ...(sessionId ? { sessionId, sessionType: 'agent' as const } : {}), projectId: workspaceId ?? null, projectName: workspace?.name ?? '未关联项目', source }
}

/** Chat 没有项目归属字段，显式归入未关联项目，不根据文件路径猜测。 */
export function chatTokenUsageContext(conversationId: string | undefined, source: TokenUsageSource = 'chat'): Pick<TokenUsageContext, 'taskId' | 'taskTitle' | 'sessionId' | 'sessionType' | 'projectId' | 'projectName' | 'source'> {
  /** 对话标题在实际调用前读取一次。 */
  const conversation = readUsageSnapshot(() => conversationId ? listConversations().find((item) => item.id === conversationId) : undefined)
  return { taskId: conversationId ? `chat:${conversationId}` : `background:${randomUUID()}`, taskTitle: conversation?.title ?? '普通 Chat', ...(conversationId ? { sessionId: conversationId, sessionType: 'chat' as const } : {}), projectId: null, projectName: '未关联项目', source }
}

/** 统计读取失败只降低归属完整度，不阻断业务调用或改变其终态。 */
function readUsageSnapshot<T>(read: () => T): T | undefined {
  try { return read() } catch { return undefined }
}
