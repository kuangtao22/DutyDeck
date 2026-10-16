import { expect, test } from 'bun:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { CanvasViewCommandRequest, CanvasViewCommandResponse, CanvasViewCommandTarget, CanvasViewSnapshot } from '@proma/shared'
import { useCanvasViewCommandBridge } from './use-canvas-view-command-bridge'
import type { CanvasViewCommandBridge, CanvasViewCommandBridgeOptions } from './use-canvas-view-command-bridge'

interface MinimalEventTarget {
  addEventListener: () => void
  removeEventListener: () => void
}

/** 创建只承载返回 null 的 Hook Probe 的最小 DOM 宿主。 */
function createHookRoot(): {
  render: (node: React.ReactElement) => void
  unmount: () => void
  restore: () => void
} {
  const eventTarget: MinimalEventTarget = { addEventListener: () => undefined, removeEventListener: () => undefined }
  class FakeHtmlIFrameElement {}
  const fakeWindow = { ...eventTarget, event: undefined, HTMLIFrameElement: FakeHtmlIFrameElement }
  const fakeDocument = {
    ...eventTarget,
    nodeType: 9,
    defaultView: fakeWindow,
    activeElement: null,
    body: null,
    documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' },
  }
  const container = {
    ...eventTarget,
    nodeType: 1,
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: fakeDocument,
  }
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(container as unknown as Element)
  return {
    render: (node) => { root.render(node) },
    unmount: () => { root.unmount() },
    restore: () => {
      globals.window = previousWindow
      globals.document = previousDocument
      globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    },
  }
}


/** 与 Workspace 使用同一个 Hook，真实挂载和卸载 Effect。 */
function Probe(props: CanvasViewCommandBridgeOptions): null { useCanvasViewCommandBridge(props); return null }
/** 最小会话视图事实。 */
const snapshot: CanvasViewSnapshot = { revision: 0, selectedNodeIds: [], viewport: { x: 0, y: 0, zoom: 1 }, expandedNodeId: null, activeTool: 'select', workbenchSizesByNodeId: {}, workbenchOffsetsByNodeId: {}, nodeSizesById: {} }
/** 精简 Preload 保留实际订阅及身份。 */
function fixture() {
  let requestListener: ((request: CanvasViewCommandRequest) => void) | null = null
  let visibilityChanged = (): void => undefined
  let available = true
  const registrations: Array<CanvasViewCommandTarget | null> = []
  const responses: CanvasViewCommandResponse[] = []
  const bridge: CanvasViewCommandBridge = {
    registerCanvasViewTarget: async (target) => { registrations.push(target) },
    onCanvasViewCommand: (listener) => { requestListener = listener; return () => { if (requestListener === listener) requestListener = null } },
    onCanvasViewCommandCancelled: () => () => undefined,
    respondCanvasViewCommand: async (response) => { responses.push(response) },
  }
  const target = { projectId: 'p', sessionId: 's', canvasId: 'c' }
  const props: CanvasViewCommandBridgeOptions = { target, enabled: true, bridge, isAvailable: () => available,
    execute: async () => snapshot, observeAvailability: (changed) => { visibilityChanged = changed; return () => undefined } }
  return { props, registrations, responses,
    send: (requestId = 'r') => requestListener?.({ ...target, requestId, expiresAt: Date.now() + 1000, command: { action: 'query' } }),
    hide: () => { available = false; visibilityChanged() },
  }
}

test('Given 真实React订阅 When query完成 Then 返回ack且卸载解除前台登记', async () => {
  const root = createHookRoot()
  const state = fixture()
  try {
    await act(async () => root.render(<Probe {...state.props} />))
    await act(async () => state.send())
    expect(state.responses).toEqual([{ ...state.props.target, requestId: 'r', ok: true, snapshot }])
    await act(async () => root.unmount())
    expect(state.registrations.at(-1)).toBeNull()
  } finally { root.restore() }
})

test('Given Worker尚未完成 When 隐藏Then取消且迟到完成不报告成功', async () => {
  const root = createHookRoot()
  const state = fixture()
  let resolve!: (value: CanvasViewSnapshot) => void
  let executionSignal: AbortSignal | undefined
  state.props.execute = (_request, signal) => { executionSignal = signal; return new Promise((done) => { resolve = done }) }
  try {
    await act(async () => root.render(<Probe {...state.props} />))
    await act(async () => state.send())
    expect(state.responses).toHaveLength(0)
    await act(async () => state.hide())
    expect(executionSignal?.aborted).toBe(true)
    await act(async () => resolve(snapshot))
    expect(state.responses[0]).toMatchObject({ ok: false, code: 'CANVAS_VIEW_CANCELLED' })
    await act(async () => root.unmount())
  } finally { root.restore() }
})

test('Given 活跃旧会话请求 When React切换宿主Then旧请求中止新会话独立注册', async () => {
  const root = createHookRoot()
  const state = fixture()
  let resolve!: (value: CanvasViewSnapshot) => void
  let executionSignal: AbortSignal | undefined
  state.props.execute = (_request, signal) => { executionSignal = signal; return new Promise((done) => { resolve = done }) }
  try {
    await act(async () => root.render(<Probe {...state.props} />))
    await act(async () => state.send())
    await act(async () => root.render(<Probe {...state.props} target={{ ...state.props.target, sessionId: 'new' }} />))
    expect(executionSignal?.aborted).toBe(true)
    expect(state.registrations.map((target) => target?.sessionId ?? null)).toEqual(['s', null, 'new'])
    await act(async () => resolve(snapshot))
    expect(state.responses[0]).toMatchObject({ ok: false, code: 'CANVAS_VIEW_CANCELLED' })
    await act(async () => root.unmount())
  } finally { root.restore() }
})

test('Given IPC登记被拒绝 When React挂载及卸载 Then 已处理Promise拒绝且不会留下监听器', async () => {
  const root = createHookRoot()
  const state = fixture()
  let attempts = 0
  state.props.bridge!.registerCanvasViewTarget = async () => { attempts += 1; throw new Error('registration denied') }
  try {
    await act(async () => root.render(<Probe {...state.props} />))
    await act(async () => root.unmount())
    state.send()
    expect(attempts).toBe(2)
    expect(state.responses).toHaveLength(0)
  } finally { root.restore() }
})
