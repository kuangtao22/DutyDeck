import { describe, expect, test } from 'bun:test'
import { CAPABILITY_FACTORY_CHANNELS } from '@proma/shared'
import { createCapabilityFactoryPreload } from './capability-factory-preload'

describe('编排工厂 preload', () => {
  test('Given 工厂变化通知 When 订阅 Then 只接收有效身份并移除监听', () => {
    let listener: ((value: unknown) => void) | undefined
    let channel = ''
    const api = createCapabilityFactoryPreload(async () => undefined, (name, next) => {
      channel = name; listener = next; return () => { listener = undefined }
    })
    const sessions: string[] = []
    const stop = api.onChanged?.((event) => sessions.push(event.sessionId))
    listener?.({ sessionId: 's1', sceneId: 'scene' }); listener?.({ sessionId: '', sceneId: 'scene' }); listener?.({ sessionId: 's2', sceneId: 1 })
    expect(channel).toBe(CAPABILITY_FACTORY_CHANNELS.CHANGED)
    expect(sessions).toEqual(['s1'])
    stop?.(); expect(listener).toBeUndefined()
  })
  test('Given 运行进度 When 订阅 Then 转发有界事件并可取消', () => {
    let listener: ((value: unknown) => void) | undefined
    let subscribedChannel = ''
    const api = createCapabilityFactoryPreload(async () => undefined, (channel, next) => {
      subscribedChannel = channel
      listener = next
      return () => { listener = undefined }
    })
    const received: string[] = []
    const unsubscribe = api.onRunProgress?.((event) => { received.push(`${event.requestId}:${event.run.id}`) })

    listener?.({ requestId: 'request-1', run: { id: 'run-1' } })
    listener?.({ requestId: '', run: { id: 'invalid' } })
    listener?.({ requestId: 'request-2', run: null })

    expect(subscribedChannel).toBe(CAPABILITY_FACTORY_CHANNELS.PROGRESS)
    expect(received).toEqual(['request-1:run-1'])
    unsubscribe?.()
    expect(listener).toBeUndefined()
  })
})


test('Given 模型设置 When preload 调用 Then 完整转发选择和乐观锁', async () => {
  const calls: unknown[] = []
  const api = createCapabilityFactoryPreload(async (channel, command) => { calls.push({ channel, command }); return { currentVersion: 2 } })
  const input = { sessionId: 's', sceneId: 'a', selection: { slots: { main: { channelId: 'c', modelId: 'm' } } }, expectedState: { currentVersion: 1, draft: null } }
  expect(await api.invoke('setModelSelection', input)).toMatchObject({ currentVersion: 2 })
  expect(calls).toEqual([{ channel: CAPABILITY_FACTORY_CHANNELS.INVOKE, command: { method: 'setModelSelection', input } }])
})


test('Given 实验命令 When preload 转发 Then 保留会话与冻结版本身份', async () => {
  const messages: unknown[] = []
  const api = createCapabilityFactoryPreload(async (_channel, command) => { messages.push(command); return null })
  await api.invoke('advanceExperiment', { sessionId: 's', sceneId: 'scene', experimentId: 'e', expectedRevision: 2 })
  await api.invoke('getExperiment', { sessionId: 's', sceneId: 'scene', experimentId: 'e', detailsSplit: 'held-out' })
  expect(messages).toEqual([
    { method: 'advanceExperiment', input: { sessionId: 's', sceneId: 'scene', experimentId: 'e', expectedRevision: 2 } },
    { method: 'getExperiment', input: { sessionId: 's', sceneId: 'scene', experimentId: 'e', detailsSplit: 'held-out' } },
  ])
})
