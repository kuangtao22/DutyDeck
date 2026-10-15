import { describe, expect, it } from 'bun:test'
import { createServerOpsTaskPreload } from './server-ops-task-preload'
import type { ServerOpsTaskSummary } from '@proma/shared'

/** 有效任务夹具，不含真实主机或凭据。 */
const task: ServerOpsTaskSummary = { taskId: 't', sessionId: 's', hostId: 'h', connectionId: 'c', command: 'echo ok', state: 'running', createdAt: 1 }

describe('Given 远程任务 preload 边界', () => {
  it('When 主进程返回其他会话任务 Then 拒绝展示', async () => {
    const api = createServerOpsTaskPreload({ invoke: async () => [task], on: () => {}, removeListener: () => {} })
    await expect(api.listServerOpsTasks('other')).rejects.toThrow()
  })
  it('When READ 返回错位游标 Then 拒绝输出', async () => {
    const api = createServerOpsTaskPreload({ invoke: async () => ({ task, output: 'ok', offset: 0, nextOffset: 1, availableStartOffset: 0, availableEndOffset: 2, truncatedBefore: false, truncatedAfter: false }), on: () => {}, removeListener: () => {} })
    await expect(api.readServerOpsTask({ sessionId: 's', taskId: 't' })).rejects.toThrow()
  })
  it('When 返回正确任务和空写入结果 Then 保留身份且直接写入', async () => {
    const calls: unknown[] = []
    const api = createServerOpsTaskPreload({ invoke: async (channel, input) => { calls.push(input); return channel.endsWith(':list') ? [task] : undefined }, on: () => {}, removeListener: () => {} })
    expect(await api.listServerOpsTasks('s')).toEqual([task])
    await api.writeServerOpsTask({ sessionId: 's', taskId: 't', data: 'secret\r' })
    expect(calls[1]).toEqual({ sessionId: 's', taskId: 't', data: 'secret\r' })
  })
})

import { parseServerOpsTaskReadInput, parseServerOpsTaskSummary, parseServerOpsTaskUserInput, parseServerOpsTaskTarget } from '../../../../packages/shared/src/types/server-ops-task-session'
describe('Given 任务 DTO 防御边界', () => {
  it('When 输入携带额外字段、越界等待或非法 ID Then 拒绝', () => {
    expect(() => parseServerOpsTaskUserInput({ sessionId: 's', taskId: 't', data: 'ok', password: 'hidden' })).toThrow()
    expect(() => parseServerOpsTaskReadInput({ sessionId: 's', taskId: 't', waitMs: 30001 })).toThrow()
    expect(() => parseServerOpsTaskTarget({ sessionId: '../s', taskId: 't' })).toThrow()
  })
  it('When 元数据含伪终态或超长负载 Then 拒绝', () => {
    expect(() => parseServerOpsTaskSummary({ ...task, state: 'exited' })).toThrow()
    expect(() => parseServerOpsTaskSummary({ ...task, state: 'unknown', exitCode: 0 })).toThrow()
    expect(() => parseServerOpsTaskSummary({ ...task, command: 'x'.repeat(8193) })).toThrow()
    expect(() => parseServerOpsTaskSummary({ ...task, state: 'exited', exitCode: 0 })).not.toThrow()
  })
})
