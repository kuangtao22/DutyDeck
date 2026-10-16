import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentSessionMeta } from '@proma/shared'
import { activeViewAtom } from '@/atoms/active-view'
import { appModeAtom } from '@/atoms/app-mode'
import {
  agentDiffPanelTabAtom, agentSessionsAtom, agentWorkspacesAtom,
  agentSessionComponentTabsAtomFamily, agentSessionStreamingStateAtomFamily,
  agentSidePanelOpenAtomFamily, agentSidePanelSplitMapAtom, currentAgentSessionIdAtom,
} from '@/atoms/agent-atoms'
import { mobileMirrorDeviceRequestsAtom } from '@/atoms/mobile-mirror-atoms'
import { createMobileMirrorAutoOpenConsumer } from './mobile-mirror-auto-open'

/** 每例创建独立的前台会话与运行；不连接真实设备。 */
function fixture() {
  /** 内存 store 和可切换的窗口可见状态。 */
  const store = createStore()
  const visibility = { visible: true }
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 'chat')
  store.set(agentSessionsAtom, [{ id: 'chat', workspaceId: 'project', title: '手机任务', createdAt: 1, updatedAt: 1 }])
  store.set(agentWorkspacesAtom, [{ id: 'project', name: '项目', slug: 'project', createdAt: 1, updatedAt: 1 }])
  /** 订阅建立后，测试直接修改正式导航 atoms 来模拟用户关闭。 */
  const consumer = createMobileMirrorAutoOpenConsumer(store, () => visibility.visible)
  store.set(agentSidePanelOpenAtomFamily('chat'), false)
  store.set(agentSessionStreamingStateAtomFamily('chat'), { running: true, startedAt: 100, runGeneration: 1 })
  const event = { type: 'mobile_device_activity' as const, deviceId: 'phone-b', toolUseId: 'call', runStartedAt: 100, runGeneration: 1 }
  return { store, consumer, event, visibility }
}

describe('Mobile MCP 执行时自动展示', () => {
  test('Given 前台有效运行 When 首次执行设备工具 Then 打开手机并绑定同一设备，每轮只展示一次', () => {
    const f = fixture()
    f.consumer.handle('chat', f.event)
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(true)
    expect(f.store.get(agentSessionComponentTabsAtomFamily('chat'))).toEqual(['mobile-mirror'])
    expect(f.store.get(agentDiffPanelTabAtom).get('chat')).toBe('mobile-mirror')
    expect(f.store.get(mobileMirrorDeviceRequestsAtom).get('chat')?.deviceId).toBe('phone-b')
    f.store.set(agentDiffPanelTabAtom, new Map([['chat', 'files']]))
    f.consumer.handle('chat', { ...f.event, deviceId: 'phone-c', toolUseId: 'second' })
    expect(f.store.get(agentDiffPanelTabAtom).get('chat')).toBe('files')
    expect(f.store.get(mobileMirrorDeviceRequestsAtom).get('chat')?.deviceId).toBe('phone-b')
    f.consumer.dispose()
  })

  test('Given 自动打开后手动关闭 When 同轮重复或新轮调用 Then 同轮不重开，新轮可以打开', () => {
    const f = fixture()
    f.consumer.handle('chat', f.event)
    f.store.set(agentSidePanelOpenAtomFamily('chat'), false)
    f.consumer.handle('chat', f.event)
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
    f.store.set(agentSessionStreamingStateAtomFamily('chat'), { running: true, startedAt: 200, runGeneration: 2 })
    f.consumer.handle('chat', { ...f.event, runStartedAt: 200, runGeneration: 2 })
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(true)
    f.consumer.dispose()
  })

  test('Given 首次工具前手动打开手机 When 关闭面板、关闭标签或切走 Then 本轮不再自动弹出', () => {
    for (const dismiss of ['panel', 'tab', 'navigate', 'page'] as const) {
      const f = fixture()
      f.store.set(agentSessionComponentTabsAtomFamily('chat'), ['mobile-mirror'])
      f.store.set(agentDiffPanelTabAtom, new Map([['chat', 'mobile-mirror']]))
      f.store.set(agentSidePanelOpenAtomFamily('chat'), true)
      if (dismiss === 'panel') f.store.set(agentSidePanelOpenAtomFamily('chat'), false)
      if (dismiss === 'tab') f.store.set(agentSessionComponentTabsAtomFamily('chat'), [])
      if (dismiss === 'navigate') f.store.set(agentDiffPanelTabAtom, new Map([['chat', 'files']]))
      if (dismiss === 'page') { f.store.set(activeViewAtom, 'planning'); f.store.set(activeViewAtom, 'conversations') }
      f.consumer.handle('chat', f.event)
      expect(f.store.get(mobileMirrorDeviceRequestsAtom).size).toBe(0)
      f.consumer.dispose()
    }
  })

  test('Given 过期、缺失身份或已结束运行 When 执行事件迟到 Then 不打开也不消耗新轮机会', () => {
    const f = fixture()
    for (const state of [undefined, { running: false, startedAt: 100, runGeneration: 1 }, { running: true }, { running: true, startedAt: 200, runGeneration: 2 }]) {
      f.store.set(agentSessionStreamingStateAtomFamily('chat'), state)
      f.consumer.handle('chat', f.event)
      expect(f.store.get(mobileMirrorDeviceRequestsAtom).size).toBe(0)
    }
    f.consumer.handle('chat', { ...f.event, runStartedAt: 200, runGeneration: 2 })
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(true)
    f.consumer.dispose()
  })

  test('Given 后台会话、Chat模式、全屏页或隐藏窗口 When 首次执行 Then 不打开，回到前台也不补弹', () => {
    for (const background of ['session', 'chat', 'page', 'window'] as const) {
      const f = fixture()
      if (background === 'session') f.store.set(currentAgentSessionIdAtom, 'another')
      if (background === 'chat') f.store.set(appModeAtom, 'chat')
      if (background === 'page') f.store.set(activeViewAtom, 'agent-skills')
      if (background === 'window') f.visibility.visible = false
      f.consumer.handle('chat', f.event)
      expect(f.store.get(agentSessionComponentTabsAtomFamily('chat'))).toEqual([])
      f.store.set(currentAgentSessionIdAtom, 'chat')
      f.store.set(appModeAtom, 'agent')
      f.store.set(activeViewAtom, 'conversations')
      f.visibility.visible = true
      f.consumer.handle('chat', { ...f.event, toolUseId: 'later' })
      expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
      f.consumer.dispose()
    }
  })

  test('Given 内部、归档、自动化或委派会话及失效项目 Then 不自动展示', () => {
    /** 覆盖隐藏身份以及普通会话判定之外的生命周期字段。 */
    const excluded: Partial<AgentSessionMeta>[] = [
      { archived: true }, { explorationParentSessionId: 'parent' }, { sourceAutomationId: 'auto' },
      { parentSessionId: 'parent' }, { sourceCanvasId: 'canvas' }, { sourceDesignJobId: 'job' }, { workspaceId: 'missing' },
    ]
    for (const patch of excluded) {
      const f = fixture()
      f.store.set(agentSessionsAtom, f.store.get(agentSessionsAtom).map(session => ({ ...session, ...patch })))
      f.consumer.handle('chat', f.event)
      expect(f.store.get(mobileMirrorDeviceRequestsAtom).size).toBe(0)
      f.consumer.dispose()
    }
  })

  test('Given 分屏 When 手机已有Pane或需要占用焦点Pane Then 保留另一侧内容及分屏比例', () => {
    for (const existing of [false, true]) {
      const f = fixture()
      f.store.set(agentSidePanelSplitMapAtom, new Map([['chat', {
        leftTab: 'files', rightTab: existing ? 'mobile-mirror' : 'mcp', focusedPane: existing ? 'left' : 'right', ratio: 0.6,
      }]]))
      f.consumer.handle('chat', f.event)
      expect(f.store.get(agentSidePanelSplitMapAtom).get('chat')).toEqual({
        leftTab: 'files', rightTab: 'mobile-mirror', focusedPane: 'right', ratio: 0.6,
      })
      f.consumer.dispose()
    }
  })

  test('Given 本轮首次工具前用户从手机切到另一Pane When 分屏窄至仅显示焦点Pane Then 不抢回手机', () => {
    const f = fixture()
    f.store.set(agentSessionComponentTabsAtomFamily('chat'), ['mobile-mirror'])
    f.store.set(agentSidePanelOpenAtomFamily('chat'), true)
    f.store.set(agentSidePanelSplitMapAtom, new Map([['chat', { leftTab: 'files', rightTab: 'mobile-mirror', focusedPane: 'right', ratio: 0.5 }]]))
    f.store.set(agentSidePanelSplitMapAtom, new Map([['chat', { leftTab: 'files', rightTab: 'mobile-mirror', focusedPane: 'left', ratio: 0.5 }]]))
    f.consumer.handle('chat', f.event)
    expect(f.store.get(agentSidePanelSplitMapAtom).get('chat')?.focusedPane).toBe('left')
    expect(f.store.get(mobileMirrorDeviceRequestsAtom).size).toBe(0)
    f.consumer.dispose()
  })

  test('Given 消费器已释放 When 迟到事件到达 Then 不再修改界面', () => {
    const f = fixture(); f.consumer.dispose(); f.consumer.handle('chat', f.event)
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
  })
})
