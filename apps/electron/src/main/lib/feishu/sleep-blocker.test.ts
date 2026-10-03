import { describe, expect, test } from 'bun:test'
import {
  SystemSleepBlocker,
  shouldPreventSystemSleep,
  type SleepBlockerAdapter,
  type SleepBlockerType,
} from './sleep-blocker'

class FakeSleepBlocker implements SleepBlockerAdapter {
  readonly startedTypes: SleepBlockerType[] = []
  readonly stoppedIds: number[] = []
  private nextId = 1
  private activeIds = new Set<number>()

  start(type: SleepBlockerType): number {
    const id = this.nextId
    this.nextId += 1
    this.startedTypes.push(type)
    this.activeIds.add(id)
    return id
  }

  stop(id: number): void {
    this.stoppedIds.push(id)
    this.activeIds.delete(id)
  }

  isStarted(id: number): boolean {
    return this.activeIds.has(id)
  }

  markStopped(id: number): void {
    this.activeIds.delete(id)
  }
}

describe('系统防睡眠', () => {
  test('Given 通用防睡眠已开启 When 同步电源策略 Then 启用系统级防休眠', () => {
    const adapter = new FakeSleepBlocker()
    const blocker = new SystemSleepBlocker(adapter)

    blocker.sync({ preventSystemSleep: true, feishuSessionMirror: { mode: 'off' } })

    expect(adapter.startedTypes).toEqual(['prevent-app-suspension'])
    expect(adapter.isStarted(1)).toBe(true)
  })

  test('Given 防睡眠已启用 When 重复同步开启状态 Then 不重复创建 blocker', () => {
    const adapter = new FakeSleepBlocker()
    const blocker = new SystemSleepBlocker(adapter)

    blocker.sync({ preventSystemSleep: true, feishuSessionMirror: { mode: 'off' } })
    blocker.sync({ preventSystemSleep: true, feishuSessionMirror: { mode: 'off' } })

    expect(adapter.startedTypes).toHaveLength(1)
    expect(adapter.isStarted(1)).toBe(true)
  })

  test('Given 通用开关和飞书同步都关闭 When 同步电源策略 Then 释放系统防休眠', () => {
    const adapter = new FakeSleepBlocker()
    const blocker = new SystemSleepBlocker(adapter)

    blocker.sync({ preventSystemSleep: true, feishuSessionMirror: { mode: 'off' } })
    blocker.sync({ preventSystemSleep: false, feishuSessionMirror: { mode: 'off' } })

    expect(adapter.stoppedIds).toEqual([1])
    expect(adapter.isStarted(1)).toBe(false)
  })

  test('Given 系统 blocker 已失效 When 通用防睡眠仍开启 Then 重新启用防休眠', () => {
    const adapter = new FakeSleepBlocker()
    const blocker = new SystemSleepBlocker(adapter)

    blocker.sync({ preventSystemSleep: true, feishuSessionMirror: { mode: 'off' } })
    adapter.markStopped(1)
    blocker.sync({ preventSystemSleep: true, feishuSessionMirror: { mode: 'off' } })

    expect(adapter.startedTypes).toEqual(['prevent-app-suspension', 'prevent-app-suspension'])
    expect(adapter.isStarted(2)).toBe(true)
  })

  test('Given 通用开关关闭但飞书实时同步开启 When 同步策略 Then 保留飞书防休眠行为', () => {
    const adapter = new FakeSleepBlocker()
    const blocker = new SystemSleepBlocker(adapter)

    blocker.sync({ preventSystemSleep: false, feishuSessionMirror: { mode: 'stream', botId: 'bot-1' } })

    expect(adapter.startedTypes).toEqual(['prevent-app-suspension'])
    expect(shouldPreventSystemSleep({ preventSystemSleep: false, feishuSessionMirror: { mode: 'stream', botId: 'bot-1' } })).toBe(true)
  })

  test('Given 两种防睡眠来源都关闭 When 判断策略 Then 不阻止系统休眠', () => {
    expect(shouldPreventSystemSleep({ preventSystemSleep: false, feishuSessionMirror: { mode: 'off' } })).toBe(false)
    expect(shouldPreventSystemSleep({ preventSystemSleep: undefined, feishuSessionMirror: undefined })).toBe(false)
  })
})
