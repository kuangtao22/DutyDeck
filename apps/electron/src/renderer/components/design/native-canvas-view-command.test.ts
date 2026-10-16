import type { CanvasNode } from '@proma/shared'
import { expect, test } from 'bun:test'
import { createCanvasViewRequestHandler, createCanvasViewUpdate, resolveCanvasViewArrangeScope } from './native-canvas-view-command'
import { createInitialAgentCanvasViewState } from '../../atoms/agent-canvas-atoms'

test('Given 草稿未保存 When 关闭工作台 Then 拒绝而不清空草稿', () => {
  const view = createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 1 })
  view.expandedNodeId = 'a'
  view.workbenchDraft = { nodeId: 'a', dirty: true }
  expect(() => createCanvasViewUpdate({ action: 'workbench', nodeId: null }, view, [], new Map(), { width: 100, height: 100 })).toThrow('CANVAS_VIEW_UNSAVED_DRAFT')
  expect(view.workbenchDraft.dirty).toBe(true)
})

test('Given 请求过期或目标不可见 When 接收 Then 不执行', async () => {
  let executions = 0
  const handler = createCanvasViewRequestHandler({ isAvailable: () => false, execute: async () => { executions += 1; throw new Error('unexpected') } })
  const response = await handler.handle({ projectId: 'p', sessionId: 's', canvasId: 'c', requestId: 'r', expiresAt: Date.now() + 1000, command: { action: 'query' } })
  expect(response).toMatchObject({ ok: false, code: 'CANVAS_VIEW_NOT_AVAILABLE' })
  expect(executions).toBe(0)
})

test('Given 执行尚未完成 When 取消 Then 不返回成功', async () => {
  let release!: () => void
  const handler = createCanvasViewRequestHandler({ isAvailable: () => true, execute: async (_request, signal) => {
    await new Promise<void>((resolve) => { release = resolve })
    if (signal.aborted) throw new Error('CANVAS_VIEW_CANCELLED')
    throw new Error('unexpected')
  } })
  const result = handler.handle({ projectId: 'p', sessionId: 's', canvasId: 'c', requestId: 'r', expiresAt: Date.now() + 1000, command: { action: 'query' } })
  handler.cancel('r')
  release()
  expect(await result).toMatchObject({ ok: false, code: 'CANVAS_VIEW_CANCELLED' })
})

/** 只需真实 Agent 节点身份与位置即可覆盖视图命令。 */
const nodes: CanvasNode[] = [{ id: 'a', kind: 'agent', title: 'A', agentSessionId: 'agent-a', position: { x: 20, y: 30 } }]

test('Given 会话视图 When 选择聚焦缩放和工具切换 Then 只返回独立补丁不修改图', () => {
  const view = createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 1 })
  const original = JSON.stringify(nodes)
  const size = new Map([['a', { width: 200, height: 100 }]])
  const surface = { width: 800, height: 600 }
  expect(createCanvasViewUpdate({ action: 'select', nodeIds: ['a', 'a'] }, view, nodes, size, surface)).toEqual({ selectedNodeId: 'a', selectedNodeIds: ['a'] })
  expect(createCanvasViewUpdate({ action: 'focus', nodeIds: ['a'] }, view, nodes, size, surface).viewport).not.toEqual(view.viewport)
  expect(createCanvasViewUpdate({ action: 'tool', tool: 'pan' }, view, nodes, size, surface)).toEqual({ activeTool: 'pan' })
  expect(createCanvasViewUpdate({ action: 'viewport', viewport: { x: 4, y: 5, zoom: 2 } }, view, nodes, size, surface)).toEqual({ viewport: { x: 4, y: 5, zoom: 2 } })
  expect(JSON.stringify(nodes)).toBe(original)
})

test('Given 工作台已有草稿 When 调尺寸及重置 Then 草稿保留且几何按节点隔离', () => {
  const view = createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 1 })
  view.expandedNodeId = 'a'
  view.workbenchDraft = { nodeId: 'a', dirty: true }
  const update = createCanvasViewUpdate({ action: 'workbench', nodeId: 'a', size: { width: 500, height: 300 }, offset: { x: 4, y: 8 } }, view, nodes, new Map(), { width: 800, height: 600 })
  expect(update.workbenchDraft).toBeUndefined()
  expect(update.workbenchSizesByNodeId).toEqual({ a: { width: 500, height: 300 } })
  const reset = createCanvasViewUpdate({ action: 'workbench', nodeId: 'a', reset: true }, { ...view, ...update }, nodes, new Map(), { width: 800, height: 600 })
  expect(reset.workbenchSizesByNodeId).toEqual({})
  expect(reset.workbenchOffsetsByNodeId).toEqual({})
  expect(view.workbenchDraft.dirty).toBe(true)
})

test('Given 请求旧revision When 解析布局范围 Then Worker启动前拒绝', () => {
  const context = { validSelectedNodeIds: ['a'], relatedArrangeNodeIds: ['a'], visibleNodeIds: ['a'] }
  expect(() => resolveCanvasViewArrangeScope({ action: 'arrange', expectedRevision: 1, scope: 'all' }, { revision: 2, nodes }, context)).toThrow('CANVAS_REVISION_CONFLICT')
  for (const scope of ['selected', 'related', 'visible', 'all', 'nodes'] as const) {
    expect(resolveCanvasViewArrangeScope({ action: 'arrange', expectedRevision: 2, scope, nodeIds: ['a'] }, { revision: 2, nodes }, context)).toEqual(['a'])
  }
})

test('Given 长ID几何大图 When Renderer查询返回 Then 明确超预算错误', async () => {
  const nodeSizesById = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`${index}-${'节'.repeat(120)}`, { width: 200, height: 100 }]))
  const handler = createCanvasViewRequestHandler({ isAvailable: () => true, execute: async () => ({ revision: 0, selectedNodeIds: [], viewport: { x: 0, y: 0, zoom: 1 }, expandedNodeId: null, activeTool: 'select', workbenchSizesByNodeId: {}, workbenchOffsetsByNodeId: {}, nodeSizesById }) })
  const response = await handler.handle({ projectId: 'p', sessionId: 's', canvasId: 'c', requestId: 'large', expiresAt: Date.now() + 1000, command: { action: 'query' } })
  expect(response).toMatchObject({ ok: false, code: 'CANVAS_VIEW_RESPONSE_TOO_LARGE' })
})
