import type {
  AgentSubmitOrEnqueueInput,
  AgentToolMode,
  PromaPermissionMode,
} from '@proma/shared'
import type { AgentPendingPrompt } from '@/atoms/agent-atoms'

export interface AutoPendingPromptContext {
  channelId: string
  modelId?: string
  workspaceId?: string
  toolMode: AgentToolMode
  permissionMode: PromaPermissionMode
  queueMessageId: string
}

export interface AgentPendingPromptClaim {
  claimed: boolean
  next: AgentPendingPrompt | null
}

/**
 * 原子领取当前待发送任务；只有仍与组件观察到的对象相同时才清空并取得执行权。
 * @param current 原子中的实时任务。
 * @param candidate 当前组件准备消费的任务对象。
 * @returns 是否取得执行权及原子下一状态。
 */
export function claimAgentPendingPrompt(
  current: AgentPendingPrompt | null,
  candidate: AgentPendingPrompt,
): AgentPendingPromptClaim {
  return current === candidate
    ? { claimed: true, next: null }
    : { claimed: false, next: current }
}

/**
 * 将自动提示词转换为主进程统一消息路由输入。
 * @param prompt 已标记自动发送的外部任务。
 * @param context 当前 Agent 会话冻结的模型、工作区、权限与队列身份。
 * @returns 不打断当前任务的顺序提交参数；空闲会话可启动，忙碌会话进入 deferred queue。
 */
export function buildAutoPendingPromptSubmission(
  prompt: AgentPendingPrompt,
  context: AutoPendingPromptContext,
): AgentSubmitOrEnqueueInput {
  return {
    queueMessageId: context.queueMessageId,
    sessionId: prompt.sessionId,
    userMessage: prompt.message,
    rawUserMessage: prompt.message,
    channelId: context.channelId,
    modelId: context.modelId,
    workspaceId: context.workspaceId,
    additionalDirectories: prompt.additionalDirectories,
    toolMode: context.toolMode,
    permissionModeOverride: context.permissionMode,
    dispatch: 'after_current',
    interrupt: false,
    mentionedSkills: prompt.mentionedSkills,
    mentionedTodoIds: prompt.mentionedTodoIds,
  }
}
