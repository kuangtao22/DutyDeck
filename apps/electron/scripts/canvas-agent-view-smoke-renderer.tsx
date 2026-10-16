import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasViewCommand, CanvasViewCommandRequest, CanvasViewCommandResponse, CanvasViewCommandTarget } from '@proma/shared'
import type { NativeCanvasAdapter } from '../src/renderer/components/design/NativeCanvasWorkspace'
import { agentCanvasViewStatesAtom, createAgentCanvasViewKey, updateAgentCanvasViewStateAtom } from '../src/renderer/atoms/agent-canvas-atoms'
import { tabsAtom, activeTabIdAtom } from '../src/renderer/atoms/tab-atoms'
import '../src/renderer/styles/globals.css'

/** 所有会话与图身份均为fixture，不读取用户业务数据。 */
const target = { projectId: 'view-smoke-project', canvasId: 'view-smoke-canvas' }
/** 普通Agent宿主与独立内存存储。 */
const sessionId = 'view-smoke-session'
const store = createStore()
const viewKey = createAgentCanvasViewKey(sessionId, target.projectId, target.canvasId)
/** 位置故意远离，验证真实聚焦和ELK布局。 */
const graph = createEmptyCanvasDocument(target.projectId, target.canvasId, 1)
graph.nodes = [
  { id: 'a', kind: 'agent', agentSessionId: 'child-a', title: '导演', position: { x: 30, y: 40 } },
  { id: 'b', kind: 'agent', agentSessionId: 'child-b', title: '摄影', position: { x: 5000, y: 3000 } },
  { id: 'c', kind: 'agent', agentSessionId: 'child-c', title: '剪辑', position: { x: -3000, y: 4000 } },
]
/** 定向宿主消息订阅与前台登记。 */
let listener: ((request: CanvasViewCommandRequest) => void) | null = null
let registered: CanvasViewCommandTarget | null = null
/** 捕获任何错误使用普通SAVE的行为。 */
let saves = 0
/** 仅真实组件回执可结束请求。 */
const pending = new Map<string, (response: CanvasViewCommandResponse) => void>()
/** 桥只模拟传输，业务行为由生产Workspace处理。 */
const bridge = {
  registerCanvasViewTarget: async (value: CanvasViewCommandTarget | null) => { registered = value },
  onCanvasViewCommand: (callback: (request: CanvasViewCommandRequest) => void) => { listener = callback; return () => { if (listener === callback) listener = null } },
  onCanvasViewCommandCancelled: () => () => undefined,
  respondCanvasViewCommand: async (response: CanvasViewCommandResponse) => { pending.get(response.requestId)?.(response); pending.delete(response.requestId) },
}
Object.defineProperty(window, 'electronAPI', { value: new Proxy(bridge, {
  get: (value, property) => property in value ? value[property as keyof typeof value]
    : property === 'platform' ? 'darwin' : property === 'onMediaRunChanged' ? () => () => undefined
    : () => { throw new Error(`隔离测试意外调用IPC：${String(property)}`) },
}) })
/** 即便布局也只应准备草案；此fixture没有合法持久化入口。 */
const adapter: NativeCanvasAdapter = {
  loadCanvas: async () => ({ document: graph, writable: true, nodeIssues: [] }),
  saveCanvas: async () => { saves += 1; throw new Error('Agent视图桥不能调用普通SAVE') },
  onCanvasChanged: () => () => undefined,
  getCanvasAgentMessages: async () => { throw new Error('不应加载真实会话') },
  sendCanvasAgentMessage: async () => { throw new Error('不应发送真实消息') },
  stopCanvasAgent: async () => { throw new Error('不应停止真实会话') },
}
store.set(tabsAtom, [
  { id: sessionId, sessionId, type: 'agent', title: '视图验证' },
  { id: 'other', sessionId: 'other', type: 'agent', title: '其他会话' },
])
store.set(activeTabIdAtom, sessionId)
/** 外部测试只发命令与设置环境，不直接实现视图操作。 */
Object.assign(window, { __canvasAgentViewSmoke: {
  ready: () => Boolean(registered && listener),
  saves: () => saves,
  view: () => store.get(agentCanvasViewStatesAtom).get(viewKey),
  active: (active: boolean) => store.set(activeTabIdAtom, active ? sessionId : 'other'),
  dirty: (dirty: boolean) => store.set(updateAgentCanvasViewStateAtom, { key: viewKey,
    update: { workbenchDraft: dirty ? { nodeId: 'a', dirty: true } : null } }),
  command: (command: CanvasViewCommand): Promise<CanvasViewCommandResponse> => {
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      if (!listener || !registered) { reject(new Error('CANVAS_VIEW_NOT_AVAILABLE')); return }
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('fixture response timeout')) }, 15_000)
      pending.set(requestId, (response) => { clearTimeout(timer); resolve(response) })
      listener!({ ...target, sessionId, requestId, expiresAt: Date.now() + 12_000, command })
    })
  },
} })
/** 预置桥后才加载真实生产组件。 */
const { NativeCanvasWorkspace } = await import('../src/renderer/components/design/NativeCanvasWorkspace')
createRoot(document.getElementById('root')!).render(<Provider store={store}>
  <main className="h-screen bg-background text-foreground">
    <NativeCanvasWorkspace sessionId={sessionId} target={target} title="Agent视图隔离验证" adapter={adapter}
      conversationRenderer={() => <div data-smoke-workbench>隔离节点工作台</div>} />
  </main>
</Provider>)
