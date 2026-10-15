import type { WebContents } from 'electron'
import type {
  AgentDeferredQueueMessageInput,
  AgentMoveQueuedMessageInput,
  AgentMessagePublicError,
  AgentQueuedMessageControlInput,
  AgentQueuedMessageStatus,
  AgentQueuedMessageSnapshot,
} from '@proma/shared'
import type { PreparedAgentCanvasMessage } from './agent-canvas-message-preparation'

type DispatchedQueueRunInput = AgentDeferredQueueMessageInput & { runGeneration: number }

interface QueueEntry {
  input: AgentDeferredQueueMessageInput
  queuedAt: number
}

/** deferred 在发布 started 前完成的权威运行准备结果。 */
export type PreparedAgentQueueRun = PreparedAgentCanvasMessage<AgentDeferredQueueMessageInput>

export interface AgentQueueCoordinatorOptions {
  isActive: (sessionId: string) => boolean
  getWebContents: (sessionId: string) => WebContents | null
  prepareRun: (input: AgentDeferredQueueMessageInput) => PreparedAgentQueueRun
  startRun: (prepared: PreparedAgentQueueRun, webContents: WebContents) => Promise<void>
  sendStatus: (webContents: WebContents, status: AgentQueuedMessageStatus) => void
  onPrepareError: (input: AgentDeferredQueueMessageInput, error: unknown) => AgentMessagePublicError
  /** 通知宿主未领取的消息被取消，或已接受的调度启动失败。 */
  onDiscard?: (input: AgentDeferredQueueMessageInput, reason: 'queue_cancelled' | 'dispatch_failed') => Promise<void> | void
}

/** 主进程持有 deferred queue；renderer 只保留展示投影。 */
export class AgentQueueCoordinator {
  private readonly queues = new Map<string, QueueEntry[]>()
  private readonly dispatching = new Map<string, string>()

  constructor(private readonly options: AgentQueueCoordinatorOptions) {}

  enqueue(input: AgentDeferredQueueMessageInput): 'started' | 'queued' {
    if (this.dispatching.get(input.sessionId) === input.queueMessageId) return 'started'
    const queue = this.queues.get(input.sessionId) ?? []
    if (queue.some((entry) => entry.input.queueMessageId === input.queueMessageId)) {
      const runStarted = this.dispatching.get(input.sessionId) === input.queueMessageId
      return runStarted ? 'started' : 'queued'
    }
    queue.push({ input, queuedAt: Date.now() })
    this.queues.set(input.sessionId, queue)
    this.tryDispatch(input.sessionId, input.queueMessageId)
    return 'queued'
  }

  cancel(input: AgentQueuedMessageControlInput): boolean {
    const queue = this.queues.get(input.sessionId)
    if (!queue) return false
    const index = queue.findIndex((entry) => entry.input.queueMessageId === input.messageId)
    if (index < 0) return false
    const [discarded] = queue.splice(index, 1)
    if (discarded) this.notifyDiscard(discarded.input, 'queue_cancelled')
    if (queue.length === 0) this.queues.delete(input.sessionId)
    return true
  }

  move(input: AgentMoveQueuedMessageInput): boolean {
    const queue = this.queues.get(input.sessionId)
    if (!queue || input.sourceId === input.targetId) return false
    const sourceIndex = queue.findIndex((entry) => entry.input.queueMessageId === input.sourceId)
    const targetIndex = queue.findIndex((entry) => entry.input.queueMessageId === input.targetId)
    if (sourceIndex < 0 || targetIndex < 0) return false
    const [source] = queue.splice(sourceIndex, 1)
    if (!source) return false
    const adjustedTarget = queue.findIndex((entry) => entry.input.queueMessageId === input.targetId)
    const insertIndex = input.placement === 'after' ? adjustedTarget + 1 : adjustedTarget
    queue.splice(insertIndex, 0, source)
    return true
  }

  onRunComplete(
    sessionId: string,
    queueMessageId: string | undefined,
    backgroundTasksPending: boolean,
    stoppedByUser: boolean,
  ): void {
    if (queueMessageId && this.dispatching.get(sessionId) === queueMessageId) {
      this.dispatching.delete(sessionId)
    }
    if (backgroundTasksPending || stoppedByUser) return
    this.tryDispatch(sessionId)
  }

  onBackgroundTaskComplete(sessionId: string): void {
    this.tryDispatch(sessionId)
  }

  /** Renderer/webContents 重新可用后唤醒等待中的队列。tryDispatch 自身负责去重 active/dispatching。 */
  onTargetAvailable(sessionId: string): void {
    this.tryDispatch(sessionId)
  }

  snapshot(sessionId: string): AgentQueuedMessageSnapshot[] {
    return (this.queues.get(sessionId) ?? []).map((entry) => ({ input: { ...entry.input }, queuedAt: entry.queuedAt }))
  }

  isDispatching(sessionId: string): boolean {
    return this.dispatching.has(sessionId)
  }

  hasPending(sessionId: string): boolean {
    return this.dispatching.has(sessionId) || (this.queues.get(sessionId)?.length ?? 0) > 0
  }

  clear(sessionId: string): void {
    const queued = this.queues.get(sessionId) ?? []
    this.queues.delete(sessionId)
    for (const entry of queued) this.notifyDiscard(entry.input, 'queue_cancelled')
    this.dispatching.delete(sessionId)
  }

  /** 回传失败不能破坏普通队列，也不能产生未处理的 Promise 拒绝。 */
  private notifyDiscard(input: AgentDeferredQueueMessageInput, reason: 'queue_cancelled' | 'dispatch_failed'): void {
    try {
      void Promise.resolve(this.options.onDiscard?.(input, reason)).catch((error: unknown) => {
        console.error('[Agent 队列] 调度终态回传失败', error)
      })
    } catch (error) {
      console.error('[Agent 队列] 调度终态回传失败', error)
    }
  }

  private tryDispatch(sessionId: string, synchronousMessageId?: string): void {
    if (this.dispatching.has(sessionId) || this.options.isActive(sessionId)) return
    while (true) {
      const queue = this.queues.get(sessionId)
      const entry = queue?.[0]
      if (!entry) return
      const messageId = entry.input.queueMessageId
      const webContents = this.options.getWebContents(sessionId)
      if (!webContents || webContents.isDestroyed()) return
      const startedAt = Date.now()
      let prepared: PreparedAgentQueueRun
      try {
        prepared = this.options.prepareRun({ ...entry.input, startedAt, userMessageUuid: messageId })
      } catch (error) {
        this.notifyDiscard(entry.input, 'dispatch_failed')
        const publicError = this.options.onPrepareError(entry.input, error)
        queue.shift()
        if (queue.length === 0) this.queues.delete(sessionId)
        if (messageId === synchronousMessageId) throw error
        this.options.sendStatus(webContents, {
          sessionId,
          messageId,
          status: 'failed',
          error: publicError,
        })
        continue
      }
      queue.shift()
      if (queue.length === 0) this.queues.delete(sessionId)
      this.dispatching.set(sessionId, messageId)
      this.options.sendStatus(webContents, {
        sessionId,
        messageId,
        status: 'started',
        userMessage: entry.input.userMessage,
        rawUserMessage: entry.input.rawUserMessage,
        startedAt,
      })
      /** 启动端口既可能同步抛错，也可能异步拒绝；二者都必须释放精确槽位。 */
      const failed = (): void => {
        this.notifyDiscard(entry.input, 'dispatch_failed')
        this.options.sendStatus(webContents, {
          sessionId, messageId, status: 'failed',
          error: { code: 'AGENT_RUN_FAILED', message: '排队消息未能启动，请稍后重试。' },
        })
      }
      let run: Promise<void>
      try {
        run = this.options.startRun(prepared, webContents)
      } catch {
        failed()
        if (this.dispatching.get(sessionId) === messageId) this.dispatching.delete(sessionId)
        continue
      }
      void run.then(() => {
        // 正常返回也可能发生在 claim 前（预检失败或停止）；宿主仅清理仍匹配的未领取调度。
        this.notifyDiscard(entry.input, 'dispatch_failed')
        if (this.dispatching.get(sessionId) === messageId) this.dispatching.delete(sessionId)
      }, () => {
        try { failed() } finally {
          if (this.dispatching.get(sessionId) === messageId) this.dispatching.delete(sessionId)
          this.tryDispatch(sessionId)
        }
      }).catch((error: unknown) => {
        console.error('[Agent 队列] 启动失败回执发送失败', error)
      })
      return
    }
  }
}
