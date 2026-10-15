import { randomUUID } from 'node:crypto'
import { isOrdinaryTopLevelAgentSession, isServerOpsId, parseServerOpsTaskInput, parseServerOpsTaskResizeInput,
  parseServerOpsTaskStartInput } from '@proma/shared'
import type { AgentSessionMeta, ServerOpsConnectionState, ServerOpsTaskAck, ServerOpsTaskExitEvent,
  ServerOpsTaskIdentity, ServerOpsTaskInput, ServerOpsTaskOutputEvent, ServerOpsTaskResizeInput,
  ServerOpsTaskSummary, ServerOpsTaskTarget, ServerOpsTaskReadInput, ServerOpsTaskReadResult,
  ServerOpsTaskUserInput, ServerOpsTaskUserResize } from '@proma/shared'
import type { ServerOpsActiveConnectionIdentity } from './server-ops-connection-service'
import type { ServerOpsAuditStore } from './server-ops-audit-store'

/** 独立任务所需的最小连接接口，事件携带主进程连接代次。 */
interface TaskConnection {
  getActiveIdentity(hostId: string): ServerOpsActiveConnectionIdentity
  startTask(identity: ServerOpsActiveConnectionIdentity, taskId: string, command: string, cols: number, rows: number): Promise<ServerOpsTaskIdentity>
  stopTask(identity: ServerOpsTaskIdentity): Promise<void>
  writeTask(input: ServerOpsTaskInput): void
  resizeTask(input: ServerOpsTaskResizeInput): void
  acknowledgeTask(input: ServerOpsTaskAck): void
  onTaskOutput(listener: (event: ServerOpsTaskOutputEvent & { generation: number }) => void): () => void
  onTaskExit(listener: (event: ServerOpsTaskExitEvent & { generation: number }) => void): () => void
  onState(listener: (state: ServerOpsConnectionState) => void): () => void
}
/** 注入会话、连接和审计，测试不触碰真实服务器或磁盘。 */
export interface ServerOpsTaskServiceDependencies {
  connection: TaskConnection
  audit: Pick<ServerOpsAuditStore, 'append'> & { prepareForWrites?: () => Promise<void> }
  getSession(sessionId: string): AgentSessionMeta | undefined
  /** 主机用户名、认证方式和凭据版本的稳定指纹；不返回凭据值。 */
  getHostBinding?(hostId: string): string
  uuid?: () => string
}
/** 内存记录只保存远端输出，不保存用户键盘输入。 */
interface TaskRecord {
  summary: ServerOpsTaskSummary
  identity: ServerOpsTaskIdentity
  generation: number
  /** 启动时冻结具体认证身份，避免同连接代次下继续使用旧凭据身份。 */
  hostBinding?: string
  output: string
  endOffset: number
  sequence: number
  /** 启动尚未确认时，即便用户中断也继续占用容量，防止悬挂请求无限累积。 */
  startPending: boolean
  waiters: Set<() => void>
  removeAbort?: () => void
  stopping?: Promise<void>
}
/** 单任务尾部缓冲与单次读取的原始 UTF-16 字符上限。 */
const BUFFER_LIMIT = 128 * 1024
const READ_LIMIT = 12_000

/** 按普通用户会话编排可观察、有界、独立于手动终端的远程任务。 */
export class ServerOpsTaskService {
  /** 记录总数最多 32，其中活动任务最多 8。 */
  private readonly tasks = new Map<string, TaskRecord>()
  /** 会话删除后仍未确认的启动也占容量，直到远端启动承诺收口。 */
  private readonly pendingStarts = new Set<TaskRecord>()
  private readonly listeners = new Set<(summary: ServerOpsTaskSummary) => void>()
  private readonly unsubscribe: Array<() => void>
  private disposed = false

  constructor(private readonly dependencies: ServerOpsTaskServiceDependencies) {
    this.unsubscribe = [dependencies.connection.onTaskOutput((event) => this.output(event)),
      dependencies.connection.onTaskExit((event) => this.exit(event)),
      dependencies.connection.onState(() => {
        for (const task of this.tasks.values()) {
          this.reconcile(task)
        }
      })]
  }

  /** 校验权限与审计后派发命令；等待期间再次校验，快速退出不能复活。 */
  async start(sessionId: string, input: { hostId: string; connectionId: string; command: string },
    assertAvailable: () => void, runSignal?: AbortSignal): Promise<ServerOpsTaskSummary> {
    this.session(sessionId); assertAvailable()
    if (runSignal?.aborted) throw new Error('SERVER_OPS_TASK_ABORTED')
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) => !['hostId', 'connectionId', 'command'].includes(key))) {
      throw new Error('SERVER_OPS_TASK_START_INPUT_INVALID')
    }
    /** 启动身份由主进程生成并交给共享严格校验器。 */
    const parsed = parseServerOpsTaskStartInput({ ...input, taskId: (this.dependencies.uuid ?? randomUUID)(), cols: 100, rows: 30 })
    if (parsed.command.length > 8192) throw new Error('SERVER_OPS_TASK_START_INPUT_INVALID')
    if (this.dependencies.audit.prepareForWrites) {
      try { await this.dependencies.audit.prepareForWrites() } catch { throw new Error('SERVER_OPS_AUDIT_START_WRITE_FAILED') }
      this.session(sessionId); assertAvailable()
      if (runSignal?.aborted) throw new Error('SERVER_OPS_TASK_ABORTED')
    }
    // 所有等待之后再校验身份和容量，随后同步保留记录，避免并发超额或覆盖。
    if (this.tasks.has(parsed.taskId) || [...this.pendingStarts].some((task) => task.identity.taskId === parsed.taskId)) throw new Error('SERVER_OPS_TASK_ALREADY_EXISTS')
    const identity = this.dependencies.connection.getActiveIdentity(parsed.hostId)
    if (identity.connectionId !== parsed.connectionId) throw new Error('SERVER_OPS_TASK_CONNECTION_CHANGED')
    /** 审计与远端派发前记录身份快照；后续比较失败必须关闭原任务。 */
    const hostBinding = this.binding(parsed.hostId)
    const active = [...new Set([...this.tasks.values(), ...this.pendingStarts])].filter((task) => this.active(task) || task.startPending)
    if (active.length >= 8 || active.filter((task) => task.summary.sessionId === sessionId).length >= 4) throw new Error('SERVER_OPS_TASK_LIMIT')
    this.evict()
    /** 在插入和派发之前写开始审计；失败不能产生远端副作用。 */
    let createdAt: number
    try {
      createdAt = this.dependencies.audit.append({ actor: 'agent', operation: 'exec', operationId: parsed.taskId,
        sessionId, hostId: parsed.hostId, command: parsed.command, phase: 'start', outcome: 'pending' }).timestamp
    } catch { throw new Error('SERVER_OPS_AUDIT_START_WRITE_FAILED') }
    const task: TaskRecord = { summary: { taskId: parsed.taskId, sessionId, hostId: parsed.hostId,
      connectionId: parsed.connectionId, command: parsed.command, state: 'starting', createdAt },
      identity: { taskId: parsed.taskId, hostId: parsed.hostId, connectionId: parsed.connectionId },
      generation: identity.generation, hostBinding, output: '', endOffset: 0, sequence: 0, startPending: true, waiters: new Set() }
    this.tasks.set(parsed.taskId, task)
    this.pendingStarts.add(task)
    /** AbortSignal 只绑定这次远端任务，在终态释放监听器。 */
    const abort = () => { void this.stop(task).catch(() => {}) }
    runSignal?.addEventListener('abort', abort, { once: true })
    task.removeAbort = () => runSignal?.removeEventListener('abort', abort)
    try {
      this.notify(task)
      this.session(sessionId); assertAvailable()
      if (!this.active(task)) return this.snapshot(task)
      if (runSignal?.aborted || !this.current(task)) throw new Error('SERVER_OPS_TASK_ABORTED')
      const started = await this.dependencies.connection.startTask(identity, parsed.taskId, parsed.command, parsed.cols, parsed.rows)
      assertAvailable()
      this.session(sessionId)
      if (!this.matches(task, { ...started, generation: identity.generation })) throw new Error('SERVER_OPS_TASK_CONNECTION_CHANGED')
      if (!this.active(task)) {
        if (task.summary.state !== 'exited') await this.dependencies.connection.stopTask(task.identity).catch(() => {})
        return this.snapshot(task)
      }
      if (runSignal?.aborted || !this.current(task)) throw new Error('SERVER_OPS_TASK_CONNECTION_CHANGED')
      task.summary.state = 'running'; this.notify(task)
      return this.snapshot(task)
    } catch (error) {
      this.finish(task, 'unknown', { message: '任务启动未能确认，远端结果未知' })
      await this.dependencies.connection.stopTask(task.identity).catch(() => {})
      throw error
    } finally {
      task.startPending = false
      this.pendingStarts.delete(task)
    }
  }

  /** 返回所属会话摘要快照，不含输出和键盘输入。 */
  list(sessionId: string): ServerOpsTaskSummary[] {
    this.session(sessionId)
    return [...this.tasks.values()].filter((task) => task.summary.sessionId === sessionId).map((task) => { this.reconcile(task); return this.snapshot(task) })
  }

  /** 有界事件驱动读取；取消只终止当前等待，不中断远程任务。 */
  async read(input: ServerOpsTaskReadInput, signal?: AbortSignal): Promise<ServerOpsTaskReadResult> {
    this.keys(input, ['sessionId', 'taskId', 'offset', 'waitMs'])
    const task = this.owned(input)
    const offset = input.offset ?? 0
    const waitMs = input.waitMs ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > task.endOffset
      || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new Error('SERVER_OPS_TASK_READ_INVALID')
    if (signal?.aborted) throw new Error('SERVER_OPS_TASK_READ_ABORTED')
    if (offset === task.endOffset && this.active(task) && waitMs > 0) {
      if (task.waiters.size >= 32) throw new Error('SERVER_OPS_TASK_READ_LIMIT')
      await new Promise<void>((resolve, reject) => {
        /** 完成、数据和取消共享清理，避免长期保留定时器及闭包。 */
        const clean = () => { clearTimeout(timer); task.waiters.delete(wake); signal?.removeEventListener('abort', abort) }
        const wake = () => { clean(); resolve() }
        const abort = () => { clean(); reject(new Error('SERVER_OPS_TASK_READ_ABORTED')) }
        const timer = setTimeout(wake, waitMs)
        task.waiters.add(wake); signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    }
    this.owned(input)
    const availableStartOffset = task.endOffset - task.output.length
    const start = Math.max(offset, availableStartOffset)
    const output = task.output.slice(start - availableStartOffset, start - availableStartOffset + READ_LIMIT)
    return { task: this.snapshot(task), output, offset: start, nextOffset: start + output.length,
      availableStartOffset, availableEndOffset: task.endOffset, truncatedBefore: offset < availableStartOffset,
      truncatedAfter: start + output.length < task.endOffset }
  }

  /** 用户键盘输入直接转发，不进入任何历史或审计。 */
  write(input: ServerOpsTaskUserInput): void {
    this.keys(input, ['sessionId', 'taskId', 'data'])
    const task = this.writable(input)
    this.dependencies.connection.writeTask(parseServerOpsTaskInput({ ...task.identity, data: input.data }))
  }

  /** 仅原始活动 SSH 连接可以调整此任务 PTY 尺寸。 */
  resize(input: ServerOpsTaskUserResize): void {
    this.keys(input, ['sessionId', 'taskId', 'cols', 'rows'])
    const task = this.writable(input)
    this.dependencies.connection.resizeTask(parseServerOpsTaskResizeInput({ ...task.identity, cols: input.cols, rows: input.rows }))
  }

  /** 中断不表示撤销已执行的远端动作。 */
  async interrupt(target: ServerOpsTaskTarget): Promise<ServerOpsTaskSummary> {
    this.keys(target, ['sessionId', 'taskId'])
    const task = this.owned(target)
    await this.stop(task)
    return this.snapshot(task)
  }

  /** 订阅无输出的摘要变化，返回取消函数。 */
  onChanged(listener: (summary: ServerOpsTaskSummary) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener)
  }

  /** 会话销毁后关闭其所有在途任务并移除缓冲。 */
  disposeSession(sessionId: string): void {
    for (const [id, task] of this.tasks) {
      if (task.summary.sessionId !== sessionId) continue
      this.tasks.delete(id)
      void this.stop(task).catch(() => {})
    }
  }

  /** 上下文释放时先解绑连接事件，再关闭所有任务。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.unsubscribe.forEach((unsubscribe) => unsubscribe())
    for (const task of this.tasks.values()) void this.stop(task).catch(() => {})
    this.tasks.clear(); this.listeners.clear()
  }

  /** 校验 IPC 对象字段，拒绝数组、空值和多余属性。 */
  private keys(value: unknown, keys: string[]): void {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('SERVER_OPS_TASK_INPUT_INVALID')
  }

  /** 只允许普通未归档顶层会话。 */
  private session(sessionId: string): void {
    if (this.disposed || !isServerOpsId(sessionId)) throw new Error('SERVER_OPS_TASK_UNAVAILABLE')
    const session = this.dependencies.getSession(sessionId)
    if (!session || session.id !== sessionId || session.archived || !isOrdinaryTopLevelAgentSession(session)) {
      this.disposeSession(sessionId)
      throw new Error('SERVER_OPS_TASK_SESSION_UNAVAILABLE')
    }
  }

  /** 精确查找会话私有任务；淘汰后不可借相同 ID 获取其他数据。 */
  private owned(target: ServerOpsTaskTarget): TaskRecord {
    this.session(target.sessionId)
    const task = isServerOpsId(target.taskId) ? this.tasks.get(target.taskId) : undefined
    if (!task || task.summary.sessionId !== target.sessionId) throw new Error('SERVER_OPS_TASK_NOT_FOUND')
    this.reconcile(task)
    return task
  }

  /** 仅活动任务接受输入，同时防止重连后的代次冒用。 */
  private writable(target: ServerOpsTaskTarget): TaskRecord {
    const task = this.owned(target)
    if (!this.active(task)) throw new Error('SERVER_OPS_TASK_NOT_ACTIVE')
    return task
  }

  /** 状态判断仅依赖本服务生命周期，不依赖过期 Agent run。 */
  private active(task: TaskRecord): boolean { return task.summary.state === 'starting' || task.summary.state === 'running' }

  /** 比较远端事件的完整身份及连接代次。 */
  private matches(task: TaskRecord, event: ServerOpsTaskIdentity & { generation: number }): boolean {
    return task.identity.taskId === event.taskId && task.identity.hostId === event.hostId
      && task.identity.connectionId === event.connectionId && task.generation === event.generation
  }

  /** 可选绑定提供者一旦启用便必须返回非空指纹，读取失败按身份失效处理。 */
  private binding(hostId: string): string | undefined {
    if (!this.dependencies.getHostBinding) return undefined
    const binding = this.dependencies.getHostBinding(hostId)
    if (typeof binding !== 'string' || !binding) throw new Error('SERVER_OPS_TASK_HOST_BINDING_UNAVAILABLE')
    return binding
  }

  /** 活动任务统一验证权限与身份；失效时仅关闭原任务通道，保留已接收历史。 */
  private reconcile(task: TaskRecord): boolean {
    if (!this.active(task)) return false
    if (this.current(task)) return true
    this.finish(task, 'unknown', { message: 'SSH 连接或认证身份已变化，远端结果未知' })
    if (!task.stopping) task.stopping = this.dependencies.connection.stopTask(task.identity).catch(() => {
      task.summary.message = '原任务通道关闭未确认，远端结果未知'; this.notify(task)
    })
    return false
  }

  /** 检查原连接与具体认证身份；已结束任务的历史读取不依赖当前主机配置。 */
  private current(task: TaskRecord): boolean {
    try {
      this.session(task.summary.sessionId)
      const identity = this.dependencies.connection.getActiveIdentity(task.identity.hostId)
      return identity.connectionId === task.identity.connectionId && identity.generation === task.generation
        && this.binding(task.identity.hostId) === task.hostBinding
    } catch { return false }
  }

  /** 保存有界尾部后立即 ACK；重复序列不重复追加。 */
  private output(event: ServerOpsTaskOutputEvent & { generation: number }): void {
    const task = this.tasks.get(event.taskId)
    if (!task || !this.matches(task, event) || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || typeof event.data !== 'string') return
    if (!this.reconcile(task)) return
    if (event.sequence > task.sequence) {
      task.sequence = event.sequence; task.endOffset += event.data.length
      task.output = (task.output + event.data.slice(-BUFFER_LIMIT)).slice(-BUFFER_LIMIT)
      this.notify(task)
    }
    try { this.dependencies.connection.acknowledgeTask({ ...task.identity, sequence: event.sequence }) } catch { /* 断连由状态或退出事件统一收口。 */ }
  }

  /** 真正的退出事件才携带结果码；没有退出码保持未知。 */
  private exit(event: ServerOpsTaskExitEvent & { generation: number }): void {
    const task = this.tasks.get(event.taskId)
    if (!task || !this.matches(task, event) || !this.reconcile(task)) return
    this.finish(task, event.exitCode === undefined ? 'unknown' : 'exited', {
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      ...(event.signal === undefined ? {} : { signal: event.signal }), message: event.message,
    })
  }

  /** 终态和结果审计恰好发生一次；审计失败只增加警告。 */
  private finish(task: TaskRecord, state: ServerOpsTaskSummary['state'], result: Partial<Pick<ServerOpsTaskSummary, 'exitCode' | 'signal' | 'message'>>): void {
    if (!this.active(task)) return
    // unknown/interrupted 不携带代表确定终态的退出字段；真实信号仍保留在审计证据里。
    Object.assign(task.summary, state === 'exited' ? result : { message: result.message }, { state })
    task.removeAbort?.(); task.removeAbort = undefined
    try {
      this.dependencies.audit.append({ actor: 'agent', operation: 'exec', operationId: task.identity.taskId,
        sessionId: task.summary.sessionId, hostId: task.identity.hostId, command: task.summary.command,
        phase: 'result', outcome: state === 'exited' ? (result.exitCode === 0 && !result.signal ? 'success' : 'error') : 'unknown',
        durationMs: Math.max(0, Date.now() - task.summary.createdAt),
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.signal === undefined ? {} : { signal: result.signal }) })
    } catch { task.summary.warnings = ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'] }
    this.notify(task)
  }

  /** 中断立即进入终态；启动晚返回时由 start 再补关闭一次。 */
  private async stop(task: TaskRecord): Promise<void> {
    if (task.stopping) return task.stopping
    if (!this.active(task)) return
    this.finish(task, 'interrupted', { message: '任务通道已中断，不代表远端动作已回滚' })
    task.stopping = this.dependencies.connection.stopTask(task.identity).catch(() => {
      task.summary.message = '任务通道中断未确认，远端结果未知'; this.notify(task)
    })
    return task.stopping
  }

  /** 返回隔离快照，防止 UI 调用者修改内部状态。 */
  private snapshot(task: TaskRecord): ServerOpsTaskSummary {
    return { ...task.summary, ...(task.summary.warnings ? { warnings: [...task.summary.warnings] } : {}) }
  }

  /** 数据与终态唤醒读者，通知只携带摘要。 */
  private notify(task: TaskRecord): void {
    for (const wake of [...task.waiters]) wake()
    for (const listener of this.listeners) { try { listener(this.snapshot(task)) } catch { /* 单个窗口失效不影响任务和 ACK。 */ } }
  }

  /** 容量满时仅淘汰最早的已完成记录，活动任务不会丢失。 */
  private evict(): void {
    while (this.tasks.size >= 32) {
      const completed = [...this.tasks.entries()].find(([, task]) => !this.active(task) && !task.startPending)
      if (!completed) throw new Error('SERVER_OPS_TASK_LIMIT')
      this.tasks.delete(completed[0])
    }
  }
}
