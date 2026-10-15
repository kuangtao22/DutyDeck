import { StringDecoder } from 'node:string_decoder'
import type { ServerOpsTaskAck, ServerOpsTaskExitEvent, ServerOpsTaskIdentity, ServerOpsTaskInput, ServerOpsTaskOutputEvent, ServerOpsTaskResizeInput, ServerOpsTaskStartInput } from '@proma/shared'
import type { ServerOpsConsoleRuntimeChannel } from './server-ops/server-ops-console-runtime'
import { acknowledgeRuntimeOutput, createRuntimeOutputState, enqueueRuntimeOutput, takeRuntimeOutput } from './server-ops/server-ops-runtime-core'

/** 独立任务通道增加错误终态，不能影响用户正在操作的终端。 */
export interface ServerOpsTaskRuntimeChannel extends ServerOpsConsoleRuntimeChannel { onceError(listener: () => void): void }
export type ServerOpsTaskRuntimeMessage =
  | { type: 'server-ops.task-started'; session: ServerOpsTaskIdentity }
  | { type: 'server-ops.task-output'; event: ServerOpsTaskOutputEvent }
  | { type: 'server-ops.task-exit'; event: ServerOpsTaskExitEvent }
/** SSH client、消息与时钟为可替换依赖。 */
interface TaskDependencies<TTimer> {
  execute(command: string, options: { pty: { term: string; cols: number; rows: number } }, callback: (error?: Error, channel?: ServerOpsTaskRuntimeChannel) => void): void
  post(message: ServerOpsTaskRuntimeMessage): void
  setTimer(callback: () => void, delayMs: number): TTimer
  clearTimer(timer: TTimer): void
}
/** 在 exec 回调之前就登记的任务状态。 */
interface ManagedTask<TTimer> {
  identity: ServerOpsTaskIdentity
  channel?: ServerOpsTaskRuntimeChannel
  output: ReturnType<typeof createRuntimeOutputState>
  stdout: StringDecoder
  stderr: StringDecoder
  startTimer?: TTimer
  flushTimer?: TTimer
  exitEvent?: ServerOpsTaskExitEvent
  closed: boolean
}
/** 单连接独立任务生命周期；仅启动有 deadline，运行时间不限。 */
export class ServerOpsTaskRuntimeController<TTimer> {
  private readonly tasks = new Map<string, ManagedTask<TTimer>>()
  private disposed = false
  constructor(private readonly dependencies: TaskDependencies<TTimer>) {}

  /** 登记完整身份后用既有 SSH client 打开独立 exec PTY。 */
  start(input: ServerOpsTaskStartInput): void {
    const identity = { taskId: input.taskId, hostId: input.hostId, connectionId: input.connectionId }
    if (this.tasks.has(input.taskId)) return
    if (this.disposed || this.tasks.size >= 8) {
      this.dependencies.post({ type: 'server-ops.task-exit', event: { ...identity, message: '远程任务通道不可用或已达并发上限' } }); return
    }
    const managed: ManagedTask<TTimer> = { identity, output: createRuntimeOutputState(65_536), stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8'), closed: false }
    this.tasks.set(input.taskId, managed)
    managed.startTimer = this.dependencies.setTimer(() => this.forceFinish(managed, '远程任务启动超时'), 10_000)
    try {
      this.dependencies.execute(input.command, { pty: { term: 'xterm-256color', cols: input.cols, rows: input.rows } }, (error, channel) => {
        if (this.tasks.get(input.taskId) !== managed || this.disposed) { try { channel?.close() } catch {} return }
        if (managed.startTimer !== undefined) this.dependencies.clearTimer(managed.startTimer)
        managed.startTimer = undefined
        if (error || !channel) { this.forceFinish(managed, '远程任务无法启动'); return }
        managed.channel = channel
        channel.onData(data => this.enqueue(managed, typeof data === 'string' ? data : managed.stdout.write(data)))
        channel.onStderrData(data => this.enqueue(managed, typeof data === 'string' ? data : managed.stderr.write(data)))
        channel.onceExit((code, signal) => { managed.exitEvent = { ...identity, ...(typeof code === 'number' ? { exitCode: code } : {}), ...(signal ? { signal } : {}), message: '远程任务已退出' } })
        channel.onceClose(() => {
          if (this.tasks.get(input.taskId) !== managed) return
          this.enqueue(managed, managed.stdout.end() + managed.stderr.end())
          managed.closed = true
          managed.exitEvent ??= { ...identity, message: '远程任务通道已关闭，退出状态未知' }
          this.flush(managed); this.finishWhenDrained(managed)
        })
        channel.onceError(() => this.forceFinish(managed, '远程任务通道异常，退出状态未知'))
        this.dependencies.post({ type: 'server-ops.task-started', session: identity })
      })
    } catch { this.forceFinish(managed, '远程任务无法启动') }
  }
  /** 仅将用户输入写入完整身份匹配的运行通道。 */
  write(input: ServerOpsTaskInput): void { const managed = this.match(input); if (!managed?.closed) managed?.channel?.write(input.data) }
  /** 更新指定任务 PTY 的尺寸。 */
  resize(input: ServerOpsTaskResizeInput): void { this.match(input)?.channel?.setWindow(input.rows, input.cols, 0, 0) }
  /** 关闭通道不等价于回滚已经发生的远端操作。 */
  stop(input: ServerOpsTaskIdentity): void { const managed = this.match(input); if (managed) this.forceFinish(managed, '远程任务通道已取消；已执行操作不会自动回滚') }
  /** 精确 ACK 当前批次并继续排空。 */
  acknowledge(input: ServerOpsTaskAck): void {
    const managed = this.match(input); if (!managed) return
    if (acknowledgeRuntimeOutput(managed.output, input.sequence)) this.flush(managed)
    this.finishWhenDrained(managed)
  }
  /** 连接释放时立即收口，不等待 renderer 或主进程 ACK。 */
  dispose(message = 'SSH 连接已关闭，远程任务结果未知'): void { this.disposed = true; for (const managed of [...this.tasks.values()]) this.forceFinish(managed, message) }
  /** 完整身份检查避免跨连接操作。 */
  private match(input: ServerOpsTaskIdentity): ManagedTask<TTimer> | undefined { const managed = this.tasks.get(input.taskId); return managed?.identity.hostId === input.hostId && managed.identity.connectionId === input.connectionId ? managed : undefined }
  /** 有界缓冲批量输出，避免输出风暴占满 IPC。 */
  private enqueue(managed: ManagedTask<TTimer>, data: string): void {
    if (this.tasks.get(managed.identity.taskId) !== managed || managed.closed || !data) return
    enqueueRuntimeOutput(managed.output, data)
    if (managed.flushTimer === undefined) managed.flushTimer = this.dependencies.setTimer(() => this.flush(managed), 16)
  }
  /** 发布单个等待 ACK 的输出批次。 */
  private flush(managed: ManagedTask<TTimer>): void {
    if (managed.flushTimer !== undefined) this.dependencies.clearTimer(managed.flushTimer)
    managed.flushTimer = undefined
    const output = takeRuntimeOutput(managed.output, managed.identity.hostId, managed.identity.connectionId)
    if (output) this.dependencies.post({ type: 'server-ops.task-output', event: { ...managed.identity, sequence: output.sequence, data: output.data } })
  }
  /** 自然终态等最后输出完成主进程接收后再发布。 */
  private finishWhenDrained(managed: ManagedTask<TTimer>): void {
    if (this.tasks.get(managed.identity.taskId) !== managed || !managed.closed || !managed.exitEvent || managed.output.inFlight || managed.output.pending || managed.output.droppedChars) return
    this.tasks.delete(managed.identity.taskId)
    this.dependencies.post({ type: 'server-ops.task-exit', event: managed.exitEvent })
  }
  /** 强制终态优先释放资源且不伪造退出码；未确认尾部明确标注。 */
  private forceFinish(managed: ManagedTask<TTimer>, message: string): void {
    if (this.tasks.get(managed.identity.taskId) !== managed) return
    this.tasks.delete(managed.identity.taskId)
    if (managed.startTimer !== undefined) this.dependencies.clearTimer(managed.startTimer)
    if (managed.flushTimer !== undefined) this.dependencies.clearTimer(managed.flushTimer)
    try { managed.channel?.close() } catch { /* 本地释放不受远端错误影响。 */ }
    this.dependencies.post({ type: 'server-ops.task-exit', event: { ...managed.identity, message: message + (managed.output.inFlight || managed.output.pending ? '；尾部输出可能不完整' : '') } })
  }
}
