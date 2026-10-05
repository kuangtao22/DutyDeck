import { memo } from 'react'
import { Bot, UserRound } from 'lucide-react'
import { ProcessBlockGroup } from './ProcessBlockGroup'
import { renderMd } from '../../utils/markdown'
import type { Message, ContentBlock, ToolResultContent } from '../../atoms'
import { groupAssistantMessages, splitAssistantProcessBlocks } from './process-blocks'

/** 读取消息兼容字段，统一支持新旧 LAN Bridge 消息结构。
 * @param m 当前消息
 * @returns 结构化内容、纯文本或缺省值
 */
function getContent(m: Message): ContentBlock[] | string | undefined {
  if (m.message?.content) return m.message.content
  return m.content
}

/** 只保留结构化内容块，供执行过程分组使用。
 * @param content 消息内容
 * @returns 内容块数组；纯文本和缺省内容返回空数组
 */
function asBlocks(content: ContentBlock[] | string | undefined): ContentBlock[] {
  if (Array.isArray(content)) return content
  return []
}

/** 从消息中提取可直接展示的正文文本。
 * @param m 当前消息
 * @returns 拼接后的正文文本
 */
function extractText(m: Message): string {
  const content = getContent(m)
  if (Array.isArray(content)) {
    return content
      .filter((c): c is typeof c & { text: string } => c.type === 'text' && 'text' in c)
      .map(c => c.text)
      .join('\n')
  }
  if (typeof content === 'string') return content
  return ''
}

/** 判断消息是否包含工具回传块，以便过滤无正文的内部回传。
 * @param m 当前消息
 * @returns 是否存在工具结果
 */
function hasToolResult(m: Message): boolean {
  return asBlocks(getContent(m)).some((c): c is ToolResultContent => c.type === 'tool_result')
}

/** 渲染移动端统一的 Proma 助手标识。
 * @returns 助手头像元素
 */
function AssistantAvatar() {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-card-foreground">
      <Bot aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
    </div>
  )
}

/** 渲染单条用户或助手消息，并按桌面端语义拆分执行过程和最终回答。
 * @param message 待渲染消息
 * @param resultMap 工具调用 ID 到结果块的索引
 * @returns 消息气泡；无可见正文的内部回传返回 null
 */
export function MessageBubble({ message: m, resultMap }: { message: Message; resultMap: Map<string, ToolResultContent> }) {
  const isUser = m.type === 'user' || m.role === 'user'
  /** 原始消息正文，支持旧版纯字符串和新版结构化内容块。 */
  const content = getContent(m)
  /** 结构化块数组保留模型给出的过程顺序。 */
  const contentBlocks = asBlocks(content)
  /** 兼容旧版只在顶层提供 reasoning 字符串的消息。 */
  const assistantBlocks = !Array.isArray(content) && m.reasoning
    ? [{ type: 'thinking' as const, thinking: m.reasoning }]
    : contentBlocks
  /** 仅助手消息拆分执行过程，用户消息沿用原有正文逻辑。 */
  const assistantContent = isUser
    ? { processBlocks: [], answerBlocks: contentBlocks }
    : splitAssistantProcessBlocks(assistantBlocks)
  /** 用户文本与旧版字符串直接提取；助手只显示分组边界后的最终回答。 */
  const text = isUser || !Array.isArray(content)
    ? extractText(m)
    : assistantContent.answerBlocks
      .filter((block): block is ContentBlock & { text: string } => block.type === 'text' && 'text' in block)
      .map((block) => block.text)
      .join('\n')

  if (isUser && hasToolResult(m) && !text) return null

  if (!isUser) {
    if (!text && assistantContent.processBlocks.length === 0) return null
    return (
      <article data-message-role="assistant" className="flex min-w-0 gap-2.5">
        <AssistantAvatar />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-[11px] font-medium text-foreground/70">{m.model || 'Proma'}</span>
            {m.createdAt && <span className="text-[10px] text-muted-foreground">{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
          {assistantContent.processBlocks.length > 0 && (
            <ProcessBlockGroup blocks={assistantContent.processBlocks} resultMap={resultMap} />
          )}
          {text && (
            <div
              className={`prose prose-sm max-w-none break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere] ${assistantContent.processBlocks.length > 0 ? 'rounded-lg border border-border/80 bg-card/30 px-3.5 py-3' : ''}`}
              dangerouslySetInnerHTML={{ __html: renderMd(text) }}
            />
          )}
        </div>
      </article>
    )
  }

  return (
    <article data-message-role="user" className="flex min-w-0 flex-row-reverse gap-2.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-card-foreground">
        <UserRound aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="flex min-w-0 flex-col items-end" style={{ maxWidth: 'calc(100% - 38px)' }}>
        {!hasToolResult(m) && (
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] font-medium text-foreground/70">我</span>
            {m.createdAt && <span className="text-[10px] text-muted-foreground">{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
        )}
        <div className="min-w-0 rounded-md bg-secondary px-3 py-2 text-sm leading-6 text-secondary-foreground">
          <div
            className="prose prose-sm max-w-none break-words [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{ __html: renderMd(text) }}
          />
        </div>
      </div>
    </article>
  )
}

/**
 * 为整段会话建立一次工具结果索引，再按原序渲染消息。
 * @param messages 当前会话已确认归属的消息列表
 * @returns 可复用消息列表；流式局部状态变化时跳过历史子树重渲染
 */
export const MessageList = memo(function MessageList({ messages }: { messages: Message[] }) {
  /** 每个工具结果通过 tool_use_id 与原调用配对。 */
  const resultMap = new Map<string, ToolResultContent>()
  for (const m of messages) {
    const blocks = asBlocks(getContent(m))
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        resultMap.set(block.tool_use_id, block as ToolResultContent)
      }
    }
  }

  /** 连续 Assistant 消息按用户输入边界合并，贴近桌面端 turn 语义。 */
  const groupedMessages = groupAssistantMessages(messages)

  return (
    <>
      {groupedMessages.map((m, i) => (
        <MessageBubble key={m.id || i} message={m} resultMap={resultMap} />
      ))}
    </>
  )
})
