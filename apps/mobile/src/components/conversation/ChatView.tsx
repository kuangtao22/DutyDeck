import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { LoaderCircle, MessageSquareText, RefreshCw } from 'lucide-react'
import {
  activeConvAtom, messagesAtom, tokenAtom,
  streamingAtom, streamSegmentsAtom,
  type Message, type MobileStreamSegments,
} from '../../atoms'
import { wsReq, onPush } from '../../lib/ws-client'
import { appendMobileStreamDelta } from '../../lib/stream-segments'
import {
  createGenerationTracker,
  shouldClearMessagesBeforeLoad,
  type MessageLoadReason,
} from '../../lib/recovery-guards'
import { InputBar } from './InputBar'
import { MessageList } from './MessageBubble'
import { StreamingAssistantMessage } from './StreamingAssistantMessage'

interface MessagesResponse { messages: Message[] }
interface StreamChunk { sessionId?: string; conversationId?: string; text?: string }
interface StreamEnd { sessionId?: string; conversationId?: string }
type HistoryLoadStatus = 'loading' | 'ready' | 'error'

interface HistoryState {
  conversationKey: string | null
  status: HistoryLoadStatus
}

interface ConversationHistoryStateProps {
  status: HistoryLoadStatus
  messageCount: number
  onRetry: () => void
}

function fetchMessages(type: string, token: string, id: string): Promise<MessagesResponse> {
  const cmd = type === 'agent' ? 'agent.sessions.messages' : 'conversations.messages'
  const idKey = type === 'agent' ? 'sessionId' : 'conversationId'
  return wsReq(cmd, { token, [idKey]: id }) as Promise<MessagesResponse>
}

/** 仅在历史状态属于当前会话时返回消息，避免切换瞬间显示旧会话内容。 */
export function selectVisibleMessages(
  messages: Message[],
  historyConversationKey: string | null,
  activeConversationKey: string | null,
): Message[] {
  return historyConversationKey === activeConversationKey ? messages : []
}

/** 渲染历史消息的加载、失败或真实空状态。 */
export function ConversationHistoryState({ status, messageCount, onRetry }: ConversationHistoryStateProps) {
  if (messageCount > 0) return null

  if (status === 'loading') {
    return (
      <div role="status" className="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center text-muted-foreground">
        <LoaderCircle aria-hidden="true" className="mb-3 h-5 w-5 animate-spin" strokeWidth={1.7} />
        <p className="text-sm font-medium text-foreground/80">正在加载对话</p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div role="alert" className="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center text-muted-foreground">
        <p className="text-sm font-medium text-foreground/80">对话加载失败</p>
        <p className="mt-1 text-xs">请检查连接后重试</p>
        <button
          type="button"
          aria-label="重新加载对话"
          onClick={onRetry}
          className="mt-3 flex min-h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center text-muted-foreground">
      <MessageSquareText aria-hidden="true" className="mb-3 h-5 w-5" strokeWidth={1.7} />
      <p className="text-sm font-medium text-foreground/80">开始一段新对话</p>
      <p className="mt-1 text-xs">输入消息后，回复会显示在这里</p>
    </div>
  )
}

export function ChatView() {
  const [active] = useAtom(activeConvAtom)
  const [messages, setMessages] = useAtom(messagesAtom)
  const token = useAtomValue(tokenAtom)
  const [streaming, setStreaming] = useAtom(streamingAtom)
  /** 回答与思考在同一快照中保留，避免实时内容混排。 */
  const [streamSegments, setStreamSegments] = useAtom(streamSegmentsAtom)
  const listRef = useRef<HTMLDivElement>(null)
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 下一帧提交前暂存的增量，合并高频推送以限制移动端重渲染。 */
  const pendingStreamSegmentsRef = useRef<MobileStreamSegments>({ answer: '', reasoning: '' })
  /** 同时最多保留一个流式文本提交帧。 */
  const streamFrameRef = useRef<number | null>(null)
  /** 同步锁定首个流事件，避免 React 提交状态前重复清空缓冲。 */
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming
  /** 历史加载与订阅各自使用 generation，避免互相误伤。 */
  const historyGenerations = useRef(createGenerationTracker())
  const subscriptionGenerations = useRef(createGenerationTracker())
  /** 使用原始字段作为依赖，避免同一会话对象刷新导致重复订阅。 */
  const activeId = active?.id
  const activeType = active?.type
  /** 会话键用于在 effect 执行前识别刚发生的会话切换。 */
  const activeKey = activeId && activeType ? `${activeType}:${activeId}` : null
  const [historyState, setHistoryState] = useState<HistoryState>(() => ({
    conversationKey: activeKey,
    status: 'loading',
  }))

  /** 将一帧内积累的回答与思考增量一次性提交到 Jotai。 */
  const flushStreamSegments = useCallback((): void => {
    /** 当前帧待提交的完整增量快照。 */
    const pending = pendingStreamSegmentsRef.current
    pendingStreamSegmentsRef.current = { answer: '', reasoning: '' }
    streamFrameRef.current = null
    if (!pending.answer && !pending.reasoning) return
    setStreamSegments((current) => ({
      answer: current.answer + pending.answer,
      reasoning: current.reasoning + pending.reasoning,
    }))
  }, [setStreamSegments])

  /**
   * 把 LAN Bridge 的单条 delta 合并到下一动画帧。
   * @param eventType 当前回答或思考事件类型
   * @param delta 本次新增文本
   * @returns 无返回值；只调度至多一个动画帧
   */
  const queueStreamDelta = useCallback((
    eventType: 'stream.chunk' | 'stream.reasoning',
    delta: string,
  ): void => {
    if (!delta) return
    pendingStreamSegmentsRef.current = appendMobileStreamDelta(
      pendingStreamSegmentsRef.current,
      eventType,
      delta,
    )
    if (streamFrameRef.current === null) {
      streamFrameRef.current = requestAnimationFrame(flushStreamSegments)
    }
  }, [flushStreamSegments])

  /** 丢弃已被历史消息替代或已结束的临时流式文本。 */
  const clearPendingStream = useCallback((): void => {
    if (streamFrameRef.current !== null) cancelAnimationFrame(streamFrameRef.current)
    streamFrameRef.current = null
    pendingStreamSegmentsRef.current = { answer: '', reasoning: '' }
    setStreamSegments({ answer: '', reasoning: '' })
  }, [setStreamSegments])

  /** 按触发原因加载当前历史，后台刷新不提前清空现有消息。 */
  const loadMessages = useCallback((reason: MessageLoadReason) => {
    if (!activeId || !activeType || !token) return
    const generation = historyGenerations.current.begin()
    /** 请求捕获自己的会话键，防止晚到响应覆盖新会话状态。 */
    const conversationKey = `${activeType}:${activeId}`
    const clearsMessages = shouldClearMessagesBeforeLoad(reason)
    if (clearsMessages) {
      setMessages([])
      setHistoryState({ conversationKey, status: 'loading' })
    }
    fetchMessages(activeType, token, activeId)
      .then(d => {
        if (!historyGenerations.current.isCurrent(generation)) return
        setMessages(d.messages ?? [])
        setHistoryState({ conversationKey, status: 'ready' })
      })
      .catch(() => {
        if (historyGenerations.current.isCurrent(generation) && clearsMessages) {
          setMessages([])
          setHistoryState({ conversationKey, status: 'error' })
        }
      })
  }, [activeId, activeType, setMessages, token])

  /** 用户主动重试时重新进入前台加载态。 */
  const retryLoadMessages = useCallback(() => {
    loadMessages('active-change')
  }, [loadMessages])

  useEffect(() => {
    if (!activeId || !activeType || !token) {
      historyGenerations.current.invalidate()
      subscriptionGenerations.current.invalidate()
      return
    }
    loadMessages('active-change')
    const subKey = activeType === 'agent' ? 'sessionId' : 'conversationId'
    subscriptionGenerations.current.begin()
    void wsReq('subscribe', { token, [subKey]: activeId }).catch(() => {})
    return () => {
      historyGenerations.current.invalidate()
      subscriptionGenerations.current.invalidate()
      void wsReq('unsubscribe', { token, [subKey]: activeId }).catch(() => {})
    }
  }, [activeId, activeType, loadMessages, token])

  // WS 重连后重新加载
  useEffect(() => {
    const handler = () => {
      if (!activeId || !activeType || !token) return
      loadMessages('reconnect')
      const subKey = activeType === 'agent' ? 'sessionId' : 'conversationId'
      const generation = subscriptionGenerations.current.begin()
      void wsReq('unsubscribe', { token, [subKey]: activeId })
        .catch(() => {})
        .then(() => {
          if (!subscriptionGenerations.current.isCurrent(generation)) return
          return wsReq('subscribe', { token, [subKey]: activeId }).catch(() => {})
        })
    }
    window.addEventListener('proma:ws-reconnected', handler)
    return () => window.removeEventListener('proma:ws-reconnected', handler)
  }, [activeId, activeType, loadMessages, token])

  // 流式推送
  useEffect(() => {
    const unsub = onPush((msg) => {
      if (!activeId) return
      const d = msg.data as StreamChunk | StreamEnd
      const id = d.sessionId ?? d.conversationId
      if (id && id !== activeId) return

      if (msg.type === 'stream.chunk' || msg.type === 'stream.reasoning') {
        if (streamTimeoutRef.current) { clearTimeout(streamTimeoutRef.current); streamTimeoutRef.current = null }
        if (!streamingRef.current) {
          streamingRef.current = true
          setStreaming(true)
          clearPendingStream()
        }
        queueStreamDelta(msg.type, (d as StreamChunk).text ?? '')
        return
      }

      switch (msg.type) {
        case 'stream.complete':
          if (streamTimeoutRef.current) { clearTimeout(streamTimeoutRef.current); streamTimeoutRef.current = null }
          /** 完成事件可能紧跟最后一个 delta，先提交当前帧避免丢掉尾部文字。 */
          if (streamFrameRef.current !== null) {
            cancelAnimationFrame(streamFrameRef.current)
            flushStreamSegments()
          }
          streamingRef.current = false
          setStreaming(false)
          loadMessages('stream-complete')
          break
        case 'stream.error':
          if (streamTimeoutRef.current) { clearTimeout(streamTimeoutRef.current); streamTimeoutRef.current = null }
          streamingRef.current = false
          setStreaming(false)
          clearPendingStream()
          break
      }
    })
    return () => {
      unsub()
      clearPendingStream()
    }
  }, [activeId, clearPendingStream, flushStreamSegments, loadMessages, queueStreamDelta, setStreaming])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, streamSegments])

  if (!active) return null

  /** 会话刚切换但 effect 尚未执行时立即显示加载态，避免闪现错误空状态。 */
  const visibleHistoryStatus = historyState.conversationKey === activeKey
    ? historyState.status
    : 'loading'
  /** 消息列表与状态占位共用同一会话隔离结果。 */
  const visibleMessages = selectVisibleMessages(messages, historyState.conversationKey, activeKey)

  return (
    <div className="flex h-full flex-col bg-content">
      <div ref={listRef} className="min-w-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto px-3 py-4 sm:px-4">
        {!streaming && (
          <ConversationHistoryState
            status={visibleHistoryStatus}
            messageCount={visibleMessages.length}
            onRetry={retryLoadMessages}
          />
        )}
        <MessageList messages={visibleMessages} />
        {streaming && (streamSegments.reasoning || streamSegments.answer) && (
          <StreamingAssistantMessage segments={streamSegments} />
        )}
      </div>

      <InputBar disabled={streaming} />
    </div>
  )
}
