import type { ContentBlock, Message } from '../../atoms'

/** 助手消息中执行过程与最终回答的内容块边界。 */
export interface AssistantProcessContent {
  /** 默认折叠的思考、过程文字与工具调用。 */
  processBlocks: ContentBlock[]
  /** 独立展示的末尾最终回答。 */
  answerBlocks: ContentBlock[]
}

/** 执行过程摘要使用的轻量计数。 */
export interface AssistantProcessSummary {
  /** 过程组内的工具调用数。 */
  toolCount: number
  /** 过程组内的思考与过程消息数。 */
  messageCount: number
}

/** 将任意历史消息归一为可合并的结构化内容块。 */
function messageBlocks(message: Message): ContentBlock[] {
  const content = message.message?.content ?? message.content
  if (Array.isArray(content)) return content
  if (typeof content === 'string' && content) return [{ type: 'text', text: content }]
  if (message.reasoning) return [{ type: 'thinking', thinking: message.reasoning }]
  return []
}

/** 判断用户消息是否只是 SDK 工具结果回传，不应切断 Assistant turn。 */
function isToolResultOnlyMessage(message: Message): boolean {
  const blocks = messageBlocks(message)
  return blocks.length > 0
    && blocks.every((block) => block.type === 'tool_result')
}

/**
 * 参考桌面端 turn 分组，把连续 Assistant 消息合并为一轮。
 * @param messages 当前会话消息，保持服务端原始顺序
 * @returns 用户消息边界之间的合并消息；工具结果消息不单独输出
 */
export function groupAssistantMessages(messages: Message[]): Message[] {
  const grouped: Message[] = []
  let pending: Message | null = null

  /** 将待合并 Assistant turn 写入输出。 */
  const flush = (): void => {
    if (!pending) return
    grouped.push(pending)
    pending = null
  }

  for (const message of messages) {
    const isUser = message.type === 'user' || message.role === 'user'
    if (isUser) {
      if (isToolResultOnlyMessage(message)) continue
      flush()
      grouped.push(message)
      continue
    }

    const blocks = messageBlocks(message)
    if (blocks.length === 0) continue
    if (!pending) {
      pending = {
        ...message,
        id: `assistant-group:${message.id}`,
        type: 'assistant',
        role: 'assistant',
        content: blocks,
      }
      continue
    }

    const pendingBlocks = messageBlocks(pending)
    pending = {
      ...pending,
      model: message.model ?? pending.model,
      createdAt: message.createdAt ?? pending.createdAt,
      content: [...pendingBlocks, ...blocks],
    }
  }

  flush()
  return grouped
}

/**
 * 将末尾连续文本留作主要回答，其前的思考/工具活动归入执行过程。
 * @param blocks 助手消息按原始顺序排列的内容块
 * @returns 保序的过程块与最终回答块
 */
export function splitAssistantProcessBlocks(blocks: ContentBlock[]): AssistantProcessContent {
  /** 末尾连续文本的起点；没有末尾文本时指向数组结尾。 */
  let answerStart = blocks.length
  /** 反向扫描只需读取末尾连续文本，避免改写原始内容顺序。 */
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    /** 当前扫描到的内容块。 */
    const block = blocks[index]
    if (block?.type !== 'text') break
    answerStart = index
  }

  /** 只有存在思考或工具调用时才建立执行过程区。 */
  const hasProcess = blocks.some((block) => block.type === 'thinking' || block.type === 'tool_use')
  if (!hasProcess) return { processBlocks: [], answerBlocks: blocks }

  return {
    processBlocks: blocks.slice(0, answerStart),
    answerBlocks: blocks.slice(answerStart),
  }
}

/**
 * 统计执行过程摘要，不遍历工具结果正文。
 * @param blocks 执行过程中的内容块
 * @returns 工具调用数与思考/过程消息数
 */
export function summarizeAssistantProcessBlocks(blocks: ContentBlock[]): AssistantProcessSummary {
  /** 过程内的工具调用数量。 */
  let toolCount = 0
  /** 过程内的思考和说明消息数量。 */
  let messageCount = 0

  for (const block of blocks) {
    if (block.type === 'tool_use') toolCount += 1
    if (block.type === 'thinking' || block.type === 'text') messageCount += 1
  }

  return { toolCount, messageCount }
}
