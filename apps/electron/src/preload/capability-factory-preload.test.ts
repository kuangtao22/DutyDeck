import { describe, expect, test } from 'bun:test'
import { CAPABILITY_FACTORY_CHANNELS } from '@proma/shared'
import { createCapabilityFactoryPreload } from './capability-factory-preload'

describe('编排工厂 preload', () => {
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
