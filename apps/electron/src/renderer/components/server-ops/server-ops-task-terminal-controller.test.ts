import { describe, expect, it } from 'bun:test'
import type { ServerOpsTaskReadResult, ServerOpsTaskSummary } from '@proma/shared'
import { attachServerOpsTaskTerminal } from './server-ops-task-terminal-controller'

/** 仅用于隔离控制器测试的任务。 */
const task: ServerOpsTaskSummary = { taskId: 't', sessionId: 's', hostId: 'h', connectionId: 'c', command: 'deploy', state: 'running', createdAt: 1 }
/** 等待当前 Promise 链完成。 */
const flush = async (): Promise<void> => { for (let turn = 0; turn < 20; turn++) await Promise.resolve() }

describe('Given 远程任务终端输出控制器', () => {
  it('When 分页期间收到重复通知 Then 串行排空且卸载不停止远端任务', async () => {
    let changed: (value: ServerOpsTaskSummary) => void = () => {}
    let reads = 0; let activeReads = 0; let maxReads = 0; let interrupted = 0; let disposed = 0
    const output: string[] = []; const offsets: number[] = []
    const detach = attachServerOpsTaskTerminal({ task, terminal: { cols: 80, rows: 24, write: (data, callback) => { output.push(data); callback?.() }, onData: () => ({ dispose: () => {} }), dispose: () => { disposed++ } }, onTask: () => {}, onError: () => {}, fit: () => {}, observeResize: () => () => {}, api: {
      listServerOpsTasks: async () => [task],
      readServerOpsTask: async (input) => { activeReads++; maxReads = Math.max(maxReads, activeReads); reads++; offsets.push(input.offset ?? 0); await Promise.resolve(); activeReads--; const start = input.offset ?? 0; return { task, output: start === 0 ? 'ab' : start === 2 ? 'cd' : '', offset: start, nextOffset: start === 0 ? 2 : 4, availableStartOffset: 0, availableEndOffset: 4, truncatedBefore: false, truncatedAfter: start === 0 } },
      onServerOpsTaskChanged: (listener) => { changed = listener; return () => {} }, writeServerOpsTask: async () => {}, resizeServerOpsTask: async () => {}, interruptServerOpsTask: async () => { interrupted++; return task },
    } })
    changed(task); changed(task); changed({ ...task, taskId: 'other' })
    await flush()
    expect(output.join('')).toBe('abcd'); expect(maxReads).toBe(1); expect(reads).toBeLessThanOrEqual(3); expect(offsets.slice(0, 2)).toEqual([0, 2])
    detach(); expect(disposed).toBe(1); expect(interrupted).toBe(0)
  })
  it('When 历史已被裁剪 Then 显示缺口并从可用起点继续', async () => {
    const output: string[] = []
    const result: ServerOpsTaskReadResult = { task, output: 'tail', offset: 10, nextOffset: 14, availableStartOffset: 10, availableEndOffset: 14, truncatedBefore: true, truncatedAfter: false }
    const detach = attachServerOpsTaskTerminal({ task, terminal: { cols: 80, rows: 24, write: (data, callback) => { output.push(data); callback?.() }, onData: () => ({ dispose: () => {} }), dispose: () => {} }, onTask: () => {}, onError: () => {}, fit: () => {}, observeResize: () => () => {}, api: { listServerOpsTasks: async () => [task], readServerOpsTask: async () => result, onServerOpsTaskChanged: () => () => {}, writeServerOpsTask: async () => {}, resizeServerOpsTask: async () => {}, interruptServerOpsTask: async () => task } })
    await flush(); expect(output.join('')).toContain('较早输出已被裁剪'); expect(output.join('')).toContain('tail'); detach()
  })
})

import { createServerOpsTaskFocusGate } from './server-ops-task-terminal-controller'
describe('Given 前台任务自动定位', () => {
  it('When 新任务快速退出 Then 仍可定位一次，历史与后台事件不会抢焦点', () => {
    const accept = createServerOpsTaskFocusGate('s', 100)
    expect(accept({ ...task, createdAt: 1 }, 's')).toBe(false)
    expect(accept({ ...task, taskId: 'fast', createdAt: 101, state: 'exited', exitCode: 0 }, 's')).toBe(true)
    expect(accept({ ...task, taskId: 'fast', createdAt: 101 }, 's')).toBe(false)
    expect(accept({ ...task, taskId: 'background', createdAt: 102 }, 'other')).toBe(false)
    expect(accept({ ...task, taskId: 'background', createdAt: 102 }, 's')).toBe(false)
  })
})

describe('Given 终端输入与异步卸载边界', () => {
  it('When 键盘连续输入 Then 只写精确任务且保持顺序；读取返回错主机时显式失败', async () => {
    let input: (data: string) => void = () => {}
    const writes: string[] = []; const errors: string[] = []; const output: string[] = []
    const detach = attachServerOpsTaskTerminal({ task, terminal: { cols: 80, rows: 24, write: (data, callback) => { output.push(data); callback?.() }, onData: (listener) => { input = listener; return { dispose: () => {} } }, dispose: () => {} }, onTask: () => {}, onError: (message) => errors.push(message), fit: () => {}, observeResize: () => () => {}, api: {
      listServerOpsTasks: async () => [task], readServerOpsTask: async () => ({ task: { ...task, hostId: 'foreign' }, output: 'forbidden', offset: 0, nextOffset: 9, availableStartOffset: 0, availableEndOffset: 9, truncatedBefore: false, truncatedAfter: false }), onServerOpsTaskChanged: () => () => {}, resizeServerOpsTask: async () => {}, interruptServerOpsTask: async () => task,
      writeServerOpsTask: async (value) => { expect(value.sessionId).toBe('s'); expect(value.taskId).toBe('t'); await Promise.resolve(); writes.push(value.data) },
    } })
    input('p'); input('w'); input('\r'); await flush()
    expect(writes).toEqual(['p', 'w', '\r']); expect(output).toEqual([]); expect(errors).toHaveLength(1)
    detach(); input('late'); await flush(); expect(writes).toHaveLength(3)
  })
})
