import { expect, test } from 'bun:test'
import { CANVAS_VIEW_RESPONSE_MAX_BYTES, assertCanvasViewSnapshotBudget, isCanvasViewResponseWithinBudget } from './canvas-view-command'
import type { CanvasViewSnapshot } from './canvas-view-command'

/** 预算测试使用完整但为空的会话视图。 */
const snapshot: CanvasViewSnapshot = { revision: 0, selectedNodeIds: [], viewport: { x: 0, y: 0, zoom: 1 }, expandedNodeId: null, activeTool: 'select', workbenchSizesByNodeId: {}, workbenchOffsetsByNodeId: {}, nodeSizesById: {} }

test('Given UTF8多字节身份 When 计算响应预算 Then 按实际字节而不是字符数', () => {
  expect(isCanvasViewResponseWithinBudget({ value: '中'.repeat(CANVAS_VIEW_RESPONSE_MAX_BYTES / 2) })).toBe(false)
  expect(isCanvasViewResponseWithinBudget({ value: 'a'.repeat(CANVAS_VIEW_RESPONSE_MAX_BYTES / 2) })).toBe(true)
})

test('Given 将选择很多长ID When 预检完整成功回执 Then 副作用前拒绝超预算', () => {
  const target = { projectId: 'p', sessionId: 's', canvasId: 'c', requestId: 'r' }
  const selectedNodeIds = Array.from({ length: 150 }, (_, index) => `${index}-${'节'.repeat(100)}`)
  expect(() => assertCanvasViewSnapshotBudget(target, { ...snapshot, selectedNodeIds })).toThrow('CANVAS_VIEW_RESPONSE_TOO_LARGE')
  expect(() => assertCanvasViewSnapshotBudget(target, snapshot)).not.toThrow()
})

test('Given 布局草案 When 含重复ID或非有限位置 Then 拒绝异常草案', async () => {
  const { isCanvasViewArrangement } = await import('./canvas-view-command')
  expect(isCanvasViewArrangement({ expectedRevision: 1, positions: [{ nodeId: 'a', position: { x: 2, y: 3 } }] })).toBe(true)
  expect(isCanvasViewArrangement({ expectedRevision: 1, positions: [{ nodeId: 'a', position: { x: Infinity, y: 3 } }] })).toBe(false)
  expect(isCanvasViewArrangement({ expectedRevision: 1, positions: [{ nodeId: 'a', position: { x: 2, y: 3 } }, { nodeId: 'a', position: { x: 4, y: 5 } }] })).toBe(false)
})
