import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { currentAgentSessionIdAtom, currentSessionSidePanelOpenAtom } from '@/atoms/agent-atoms'
import { clearWorkspaceToolRequestAtom, openWorkspaceToolAtom, pendingWorkspaceToolRequestAtom, requestWorkspaceToolAtom, subscribeWorkspaceToolRequestContext } from '@/atoms/workspace-tools'
import { createWorkspaceToolNavigationGuard, runPendingWorkspaceToolRequest } from './workspace-tool-request'

describe('工具菜单资源请求交付', () => {
  test('Given 画布关联仍加载 When 消费并重试 Then 就绪后只打开一次', async () => {
    /** 真实 store 模拟从菜单到 SidePanel 的跨挂载传递。 */
    const store = createStore()
    const opened: string[] = []
    const actions = {
      canvasReady: false, canvasError: null,
      openBrowser: () => { opened.push('browser') },
      openTerminal: () => { opened.push('terminal') },
      openCanvas: () => { opened.push('canvas') },
      reportError: (message: string) => { opened.push(message) },
    }
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'canvas' })
    await runPendingWorkspaceToolRequest(store, 'session-a', actions)
    expect(opened).toEqual([])
    await runPendingWorkspaceToolRequest(store, 'session-a', { ...actions, canvasReady: true })
    await runPendingWorkspaceToolRequest(store, 'session-a', { ...actions, canvasReady: true })
    expect(opened).toEqual(['canvas'])
  })

  test('Given 浏览器和终端点击 When 重复Effect或错误重试 Then 不重复创建并报告失败', async () => {
    const store = createStore()
    const opened: string[] = []
    const actions = {
      canvasReady: false, canvasError: null,
      openBrowser: async () => { throw new Error('测试 IPC 失败') },
      openTerminal: () => { opened.push('terminal') },
      openCanvas: () => { opened.push('canvas') },
      reportError: (message: string) => { opened.push(message) },
    }
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'terminal' })
    await runPendingWorkspaceToolRequest(store, 'session-a', actions)
    await runPendingWorkspaceToolRequest(store, 'session-a', actions)
    expect(opened).toEqual(['terminal'])
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'browser' })
    await runPendingWorkspaceToolRequest(store, 'session-a', actions)
    expect(opened).toEqual(['terminal', '打开浏览器失败，请重试'])
  })

  test('Given 画布关联失败 When 消费 Then 提示失败且不会等待到未来突然打开', async () => {
    const store = createStore()
    const opened: string[] = []
    const actions = {
      canvasReady: false, canvasError: '画布关联加载失败',
      openBrowser: () => undefined, openTerminal: () => undefined,
      openCanvas: () => { opened.push('canvas') },
      reportError: (message: string) => { opened.push(message) },
    }
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'canvas' })
    await runPendingWorkspaceToolRequest(store, 'session-a', actions)
    await runPendingWorkspaceToolRequest(store, 'session-a', { ...actions, canvasReady: true, canvasError: null })
    expect(opened).toEqual(['画布关联加载失败'])
  })
  test('Given 浏览器或Canvas异步在途 When 用户后续导航或关闭 Then 旧完成不得抢回焦点', async () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(currentSessionSidePanelOpenAtom, true)
    const release = subscribeWorkspaceToolRequestContext(store)
    const canNavigate = createWorkspaceToolNavigationGuard(store, 'session-a')
    expect(canNavigate()).toBe(true)
    store.set(openWorkspaceToolAtom, 'files')
    expect(canNavigate()).toBe(false)
    const afterFiles = createWorkspaceToolNavigationGuard(store, 'session-a')
    store.set(currentSessionSidePanelOpenAtom, false)
    expect(afterFiles()).toBe(false)
    release()
  })

  test('Given 当前会话有待处理请求 When 另一会话关闭Tab Then 不撤销当前请求或焦点授权', () => {
    /** 模拟后台会话的延迟关闭回调，当前会话必须继续收到自己的资源。 */
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-b')
    store.set(currentSessionSidePanelOpenAtom, true)
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-b', tool: 'browser' })
    const canNavigate = createWorkspaceToolNavigationGuard(store, 'session-b')
    store.set(clearWorkspaceToolRequestAtom, 'session-a')
    expect(store.get(pendingWorkspaceToolRequestAtom('session-b'))).toEqual({ tool: 'browser' })
    expect(canNavigate()).toBe(true)
  })

  test('Given 请求在途且活动Tab未变化 When 当前会话关闭其他Tab Then 旧请求失去焦点授权', () => {
    /** 关闭非活动 Tab 同样表达新导航意图，不能只依赖活动 Tab 值变化。 */
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(currentSessionSidePanelOpenAtom, true)
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'canvas' })
    const canNavigate = createWorkspaceToolNavigationGuard(store, 'session-a')
    store.set(clearWorkspaceToolRequestAtom, 'session-a')
    expect(store.get(pendingWorkspaceToolRequestAtom('session-a'))).toBeNull()
    expect(canNavigate()).toBe(false)
  })

})
