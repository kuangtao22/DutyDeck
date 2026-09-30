import type {
  Agent,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentRequestUpdate,
  PrepareNextTurnContext,
} from '@earendil-works/pi-agent-core'
import type { SystemMessage } from '@earendil-works/pi-ai'
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'

/** Proma 动态项目指令在 Pi transcript 中使用的稳定 section 名称。 */
const DYNAMIC_PROJECT_INSTRUCTIONS_SECTION = 'proma_dynamic_project_instructions'

/** Pi 0.87 仅开放 ESM 运行时入口；缓存动态导入，避免 Electron CJS bundle 生成非法 require。 */
let piAiTranscriptPromise: Promise<Pick<
  typeof import('@earendil-works/pi-ai'),
  'getCurrentSystemMessage' | 'getCurrentSystemPrompt'
>> | undefined

/** 加载 transcript 回放函数；同一进程内所有会话复用同一个模块 Promise。 */
function loadPiAiTranscript() {
  piAiTranscriptPromise ??= import('@earendil-works/pi-ai').then((module) => ({
    getCurrentSystemMessage: module.getCurrentSystemMessage,
    getCurrentSystemPrompt: module.getCurrentSystemPrompt,
  }))
  return piAiTranscriptPromise
}

/** 动态项目指令生成器；返回完整的新系统提示词，未发生变化时返回原值。 */
export type AppendPendingSystemPrompt = (currentSystemPrompt: string) => string

/** 仅暴露动态 system section 恢复所需的原始分支读取能力。 */
export type SessionTranscriptReader = Pick<SessionManager, 'getBranch'>

/** 读取一个会话条目携带的 system message；其它条目不参与动态规则恢复。 */
function getEntrySystemMessage(entry: SessionEntry): SystemMessage | undefined {
  if (entry.type === 'message' && entry.message.role === 'system') return entry.message
  if (entry.type === 'compaction') return entry.systemMessage
  return undefined
}

/**
 * 从追加式历史恢复最后一次有效的动态规则。
 * Pi 写入 null 只表示基础 prompt 刷新删除未知 section，不代表产品撤销已激活的路径规则。
 */
function restoreDynamicProjectInstructions(sessionManager: SessionTranscriptReader): string | undefined {
  /** context_edit 是显式的会话语义，最终为 null 的目标不能因历史扫描而复活。 */
  const omittedEntryIds = new Set<string>()
  const branch = sessionManager.getBranch()
  for (const entry of branch) {
    if (entry.type !== 'context_edit') continue
    if (entry.replacement === null) omittedEntryIds.add(entry.targetId)
    else omittedEntryIds.delete(entry.targetId)
  }

  let restoredInstructions: string | undefined
  for (const entry of branch) {
    if (omittedEntryIds.has(entry.id)) continue
    const sectionValue = getEntrySystemMessage(entry)?.sections?.[DYNAMIC_PROJECT_INSTRUCTIONS_SECTION]
    if (typeof sectionValue === 'string') restoredInstructions = sectionValue
  }
  return restoredInstructions
}

/** 创建只更新动态项目指令 section 的 system message。 */
function createDynamicProjectInstructionsMessage(instructions: string): SystemMessage {
  return {
    role: 'system',
    content: '',
    sections: { [DYNAMIC_PROJECT_INSTRUCTIONS_SECTION]: instructions },
    timestamp: Date.now(),
  }
}

/** 确保本次请求上下文包含当前动态规则；返回值只影响请求，不写入 session artifact。 */
function restoreDynamicProjectInstructionsForRequest(
  messages: AgentMessage[],
  instructions: string | undefined,
  getCurrentSystemMessage: Awaited<ReturnType<typeof loadPiAiTranscript>>['getCurrentSystemMessage'],
): AgentMessage[] {
  if (!instructions) return messages
  const currentValue = getCurrentSystemMessage(messages)?.sections?.[DYNAMIC_PROJECT_INSTRUCTIONS_SECTION]
  if (currentValue === instructions) return messages
  return [...messages, createDynamicProjectInstructionsMessage(instructions)]
}

/** 仅暴露会话投影清理所需的最小接口，便于验证真实 SessionManager 与边界替身。 */
export type SessionProjectionEditor = Pick<SessionManager, 'appendContextEdit' | 'buildSessionProjection'>

/**
 * 将同一 Agent 运行中发现的项目指令写入 system transcript。
 * 返回 messages 而不是只替换临时 context，确保 Pi 会发出 message_end 并由 SessionManager 持久化。
 */
export function installPendingSystemPromptTranscript(
  agent: Pick<Agent, 'prepareNextTurnWithContext' | 'prepareRequest'>,
  sessionManager: SessionTranscriptReader,
  appendPendingSystemPrompt: AppendPendingSystemPrompt,
): void {
  /** 已激活规则独立于 Pi 对未知 section 的基础刷新删除，并可从磁盘会话恢复。 */
  let activeInstructions = restoreDynamicProjectInstructions(sessionManager)

  /** 保留 Pi AgentSession 已安装的压缩、工具状态与系统提示词刷新逻辑。 */
  const previousPrepareNextTurnWithContext = agent.prepareNextTurnWithContext
  agent.prepareNextTurnWithContext = async (
    turn: PrepareNextTurnContext,
    signal?: AbortSignal,
  ): Promise<AgentLoopTurnUpdate | undefined> => {
    /** 先执行上游刷新，动态指令必须基于真正将发送给 provider 的 transcript。 */
    const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal)
    /** 运行时必须通过 ESM dynamic import 读取 Pi transcript API。 */
    const { getCurrentSystemMessage, getCurrentSystemPrompt } = await loadPiAiTranscript()
    /** 上游可能替换本轮上下文；未替换时沿用 Agent 循环提供的上下文。 */
    const nextContext = previousSnapshot?.context ?? turn.context
    /** 上游返回的 section 删除会先于 Proma 更新落入 transcript，因此计算时必须包含这些待追加消息。 */
    const preparedMessages = [...nextContext.messages, ...(previousSnapshot?.messages ?? [])]
    /** 计算新规则前临时恢复旧规则，确保更深目录的规则只追加而不会截断已激活祖先规则。 */
    const effectiveMessages = restoreDynamicProjectInstructionsForRequest(
      preparedMessages,
      activeInstructions,
      getCurrentSystemMessage,
    )
    /** 通过 transcript 回放取得当前完整提示词，兼容中途 system message 更新。 */
    const currentSystemPrompt = getCurrentSystemPrompt(effectiveMessages)
    /** 控制器返回包含待激活规则的完整提示词。 */
    const nextSystemPrompt = appendPendingSystemPrompt(currentSystemPrompt)
    if (nextSystemPrompt === currentSystemPrompt) return previousSnapshot
    if (!nextSystemPrompt.startsWith(currentSystemPrompt)) {
      throw new Error('动态项目指令只能追加系统提示词，不能覆盖既有系统与安全规则')
    }

    /** 仅提取本次新增部分，旧规则由 activeInstructions 持续累积。 */
    const appendedContent = nextSystemPrompt.slice(currentSystemPrompt.length).replace(/^\n{2}/, '')
    activeInstructions = activeInstructions
      ? `${activeInstructions}\n\n${appendedContent}`
      : appendedContent
    /** 命名 section 持久化后位于基础 sections 之后，保持稳定缓存前缀和安全规则优先级。 */
    const instructionMessage = createDynamicProjectInstructionsMessage(activeInstructions)
    return {
      ...previousSnapshot,
      context: nextContext,
      messages: [...(previousSnapshot?.messages ?? []), instructionMessage],
    }
  }

  /**
   * Pi 在新 prompt 起点会持久化删除未知 section；canonical 投影完成后只为真实请求补回。
   * 该消息不经 message_end，因此不会制造每次请求一次的持久化写入。
   */
  const previousPrepareRequest = agent.prepareRequest
  agent.prepareRequest = async (request, signal) => {
    /** Pi 的类型将 Promise<void> 与 Promise<update> 分列，先收窄为统一的可选更新。 */
    const previousUpdate: AgentRequestUpdate | undefined = await previousPrepareRequest?.(request, signal) ?? undefined
    const nextContext = previousUpdate?.context ?? request.context
    if (!activeInstructions) return previousUpdate

    const { getCurrentSystemMessage } = await loadPiAiTranscript()
    const restoredMessages = restoreDynamicProjectInstructionsForRequest(
      nextContext.messages,
      activeInstructions,
      getCurrentSystemMessage,
    )
    if (restoredMessages === nextContext.messages) return previousUpdate
    return {
      ...previousUpdate,
      context: { ...nextContext, messages: restoredMessages },
    }
  }
}

/**
 * 从会话的权威投影中隐藏最后一条 aborted assistant。
 * context_edit 是追加式记录，既不删除用户/工具证据，也能在重新打开会话后保持清理结果。
 */
export function omitTrailingAbortedAssistantFromSession(sessionManager: SessionProjectionEditor): boolean {
  /** 投影保留每条模型可见消息对应的源 entry，便于精确编辑而不按文本猜测。 */
  const projectedEntries = sessionManager.buildSessionProjection().entries
  /** 最后一个仍贡献消息的 entry 对应当前模型上下文末尾。 */
  const trailingEntry = projectedEntries.findLast((entry) => entry.messages.length > 0)
  /** 一个 entry 通常贡献一条消息；压缩 entry 可能贡献多条，因此检查其最后一条。 */
  const trailingMessage = trailingEntry?.messages.at(-1)
  if (!trailingEntry || trailingMessage?.role !== 'assistant' || trailingMessage.stopReason !== 'aborted') {
    return false
  }

  sessionManager.appendContextEdit(trailingEntry.sourceEntry.id, null)
  return true
}
