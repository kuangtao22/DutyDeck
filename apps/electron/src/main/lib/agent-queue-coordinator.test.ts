import { describe, expect, test } from 'bun:test'
import type { AgentDeferredQueueMessageInput } from '@proma/shared'
import type { WebContents } from 'electron'
import { AgentQueueCoordinator } from './agent-queue-coordinator'

/** 创建固定归属的知识调度消息；不启动真实 Agent。 */
function input(id: string): AgentDeferredQueueMessageInput {
  return { sessionId: 'session', queueMessageId: id, workspaceId: 'workspace', channelId: 'channel', userMessage: '继续知识整理' }
}

/** 用微任务等待队列的 Promise 拒绝及清理回执。 */
async function flush(): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, 0)) }

/** 真实队列配以受控的运行端口，保留同步 enqueue 语义。 */
function fixture() {
  const state = { active: true, prepareFails: false, startFails: false, discarded: [] as string[], started: [] as string[], statuses: [] as string[] }
  const coordinator = new AgentQueueCoordinator({
    isActive: () => state.active,
    getWebContents: () => ({ isDestroyed: () => false }) as unknown as WebContents,
    prepareRun: (value) => { if (state.prepareFails) throw new Error('准备失败'); return { input: value, extensions: {}, references: undefined } },
    startRun: async (value) => { state.started.push(value.input.queueMessageId); if (state.startFails) throw new Error('启动失败') },
    sendStatus: (_webContents, status) => { state.statuses.push(status.status) },
    onPrepareError: () => ({ code: 'CANVAS_REFERENCE_INVALID', message: '引用失效' }),
    onDiscard: (value, reason) => { state.discarded.push(`${value.queueMessageId}:${reason}`) },
  })
  return { state, coordinator }
}

describe('Agent 队列调度生命周期回传', () => {
  test('Given 消息尚未领取 When cancel Then 只回传一次queue_cancelled且消息不能执行', () => {
    const { state, coordinator } = fixture()
    coordinator.enqueue(input('dispatch'))
    expect(coordinator.cancel({ sessionId: 'session', messageId: 'dispatch' })).toBe(true)
    expect(coordinator.cancel({ sessionId: 'session', messageId: 'dispatch' })).toBe(false)
    expect(state.discarded).toEqual(['dispatch:queue_cancelled'])
    expect(state.started).toEqual([])
  })
  test('Given 多条未领取消息 When clear Then 每条回传取消且重复clear不重复通知', () => {
    const { state, coordinator } = fixture()
    coordinator.enqueue(input('first')); coordinator.enqueue(input('second'))
    coordinator.clear('session'); coordinator.clear('session')
    expect(state.discarded).toEqual(['first:queue_cancelled', 'second:queue_cancelled'])
    expect(coordinator.hasPending('session')).toBe(false)
  })
  test('Given 入队后准备阶段失败 When 后台调度 Then 回传dispatch_failed并发布失败状态', () => {
    const { state, coordinator } = fixture()
    coordinator.enqueue(input('dispatch'))
    state.active = false; state.prepareFails = true
    coordinator.onTargetAvailable('session')
    expect(state.discarded).toEqual(['dispatch:dispatch_failed'])
    expect(state.statuses).toEqual(['failed'])
    expect(coordinator.hasPending('session')).toBe(false)
  })
  test('Given startRun Promise拒绝 When 调度 Then 捕获拒绝并释放运行槽位及回传失败', async () => {
    const { state, coordinator } = fixture()
    state.active = false; state.startFails = true
    coordinator.enqueue(input('dispatch'))
    await flush()
    expect(state.discarded).toEqual(['dispatch:dispatch_failed'])
    expect(state.statuses).toEqual(['started', 'failed'])
    expect(coordinator.isDispatching('session')).toBe(false)
  })
})


test('Given 运行在claim前正常返回 When 启动结束 Then 宿主获得精确dispatch清理通知但不伪造UI失败', async () => {
  const { state, coordinator } = fixture()
  state.active = false
  coordinator.enqueue(input('unclaimed'))
  await flush()
  expect(state.discarded).toEqual(['unclaimed:dispatch_failed'])
  expect(state.statuses).toEqual(['started'])
  expect(coordinator.isDispatching('session')).toBe(false)
})
