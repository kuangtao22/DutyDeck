import { describe, expect, test } from 'bun:test'
import { ServerOpsTaskRuntimeController } from './server-ops-task-runtime'
import type { ServerOpsTaskRuntimeChannel, ServerOpsTaskRuntimeMessage } from './server-ops-task-runtime'

/** 使用可手动推进的通道和计时器验证异步边界。 */
function fixture() {
  const messages: ServerOpsTaskRuntimeMessage[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  let callback: ((error?: Error, channel?: ServerOpsTaskRuntimeChannel) => void) | undefined
  let data: (value: string) => void = () => {}
  let exit: (code: number | null) => void = () => {}
  let close: () => void = () => {}
  let closed = 0
  const channel: ServerOpsTaskRuntimeChannel = {
    write() {}, setWindow() {}, onData(listener) { data = listener }, onStderrData() {},
    onceExit(listener) { exit = listener }, onceClose(listener) { close = listener }, onceError() {},
    close() { closed++; close() },
  }
  const controller = new ServerOpsTaskRuntimeController<number>({ execute(_command, _options, cb) { callback = cb },
    post(message) { messages.push(message) }, setTimer(cb) { timers.set(++nextTimer, cb); return nextTimer }, clearTimer(id) { timers.delete(id) } })
  return { controller, messages, timers, ready: () => callback?.(undefined, channel), data: (value: string) => data(value), exit: (code: number | null) => { exit(code); close() }, closed: () => closed }
}
const identity = { taskId: 'task-1', hostId: 'host-1', connectionId: 'conn-1' }
const input = { ...identity, command: 'sudo deploy', cols: 80, rows: 24 }
describe('独立 SSH 任务 PTY', () => {
  test('Given 输出未确认 When 正常退出 Then 最后输出先于真实退出码', () => {
    const f = fixture(); f.controller.start(input); f.ready(); f.data('完成'); f.exit(7)
    expect(f.messages.map(x => x.type)).toEqual(['server-ops.task-started', 'server-ops.task-output'])
    f.controller.acknowledge({ ...identity, sequence: 1 })
    expect(f.messages.at(-1)).toEqual({ type: 'server-ops.task-exit', event: { ...identity, exitCode: 7, message: '远程任务已退出' } })
  })
  test('Given 未收到启动回调 When 取消 Then 迟到通道关闭且不启动', () => {
    const f = fixture(); f.controller.start(input); f.controller.stop(identity); f.ready()
    expect(f.closed()).toBe(1); expect(f.messages.some(x => x.type === 'server-ops.task-started')).toBe(false)
  })
  test('Given 输出未 ACK When 断连 Then 不等待 ACK 且退出码未知', () => {
    const f = fixture(); f.controller.start(input); f.ready(); f.data('partial'); f.controller.dispose()
    expect(f.messages.at(-1)?.type).toBe('server-ops.task-exit'); expect(f.timers.size).toBe(0)
    expect(f.messages.at(-1)).not.toHaveProperty('event.exitCode')
  })
  test('Given 启动超时 When 回调迟到 Then 释放通道', () => {
    const f = fixture(); f.controller.start(input); [...f.timers.values()][0]?.(); f.ready()
    expect(f.closed()).toBe(1); expect(f.messages.at(-1)?.type).toBe('server-ops.task-exit')
  })
  test('Given 八条启动中任务 When 第九条请求 Then 限制资源且不影响既有任务', () => {
    const f = fixture()
    for (let index = 0; index < 9; index++) f.controller.start({ ...input, taskId: `task-${index}` })
    expect(f.messages).toHaveLength(1)
    expect(f.messages[0]).toMatchObject({ type: 'server-ops.task-exit', event: { taskId: 'task-8' } })
    f.controller.dispose(); expect(f.timers.size).toBe(0)
  })
  test('Given 输出风暴 When ACK 暂停 Then 每批缓冲有界并显式报告截断', () => {
    const f = fixture(); f.controller.start(input); f.ready(); f.data('x'.repeat(200_000)); f.exit(0)
    const output = f.messages.find(message => message.type === 'server-ops.task-output')
    expect(output?.type).toBe('server-ops.task-output')
    if (output?.type === 'server-ops.task-output') {
      expect(output.event.data.length).toBeLessThan(65_792)
      expect(output.event.data).toContain('已丢弃')
    }
    f.controller.stop(identity); expect(f.messages.at(-1)?.type).toBe('server-ops.task-exit')
  })

})
