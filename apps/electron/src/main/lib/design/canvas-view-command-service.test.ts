import { describe, expect, test } from 'bun:test'
import type { CanvasViewSnapshot } from '@proma/shared'
import { createCanvasViewCommandService } from './canvas-view-command-service'

/** 所有测试使用同一完整宿主身份。 */
const target = { projectId: 'p', sessionId: 's', canvasId: 'c' }
describe('Canvas 会话视图请求', () => {
  test('Given 无可见宿主 When 查询 Then 明确不可用', async () => {
    const service = createCanvasViewCommandService({ isAvailable: () => true, send: () => undefined })
    await expect(service.execute(target, { action: 'query' })).rejects.toThrow('CANVAS_VIEW_NOT_AVAILABLE')
  })
  test('Given 精确宿主 When 他窗口伪造应答 Then 等待真实应答', async () => {
    const service = createCanvasViewCommandService({ isAvailable: () => true, send: () => undefined })
    service.register(7, target)
    const result = service.execute(target, { action: 'query' }, { requestId: 'r' })
    expect(service.respond(8, { ...target, requestId: 'r', ok: false, code: 'CANVAS_WRONG' })).toBe(false)
    expect(service.respond(7, { ...target, requestId: 'r', ok: false, code: 'CANVAS_EXPECTED' })).toBe(true)
    await expect(result).rejects.toThrow('EXPECTED')
  })
  test('Given 请求尚未完成 When 取消或切换 Then 不能收到成功回执', async () => {
    const sent: string[] = []
    const service = createCanvasViewCommandService({ isAvailable: () => true, send: (_id, channel) => { sent.push(channel) } })
    service.register(7, target)
    const controller = new AbortController()
    const result = service.execute(target, { action: 'query' }, { signal: controller.signal, requestId: 'r' })
    controller.abort()
    await expect(result).rejects.toThrow('CANVAS_VIEW_CANCELLED')
    expect(sent).toHaveLength(2)
    expect(service.respond(7, { ...target, requestId: 'r', ok: false, code: 'LATE' })).toBe(false)
  })
})

test('Given 发送后窗口目标切换 When 旧回执到达 Then 拒绝并结束等待', async () => {
  const service = createCanvasViewCommandService({ isAvailable: () => true, send: () => undefined })
  service.register(7, target)
  const result = service.execute(target, { action: 'query' }, { requestId: 'switch' })
  service.register(7, { ...target, sessionId: 'new' })
  await expect(result).rejects.toThrow('CANVAS_VIEW_NOT_AVAILABLE')
  expect(service.respond(7, { ...target, requestId: 'switch', ok: false, code: 'CANVAS_LATE' })).toBe(false)
})

test('Given 无回执 When 等待超时 Then 明确失败而不伪造完成', async () => {
  const service = createCanvasViewCommandService({ isAvailable: () => true, send: () => undefined })
  service.register(7, target)
  await expect(service.execute(target, { action: 'query' }, { timeoutMs: 5 })).rejects.toThrow('CANVAS_VIEW_TIMEOUT')
})

test('Given 同sender非法快照 When 应答 Then 不接受且保持原请求', async () => {
  const service = createCanvasViewCommandService({ isAvailable: () => true, send: () => undefined })
  service.register(7, target)
  const result = service.execute(target, { action: 'query' }, { requestId: 'bad' })
  expect(service.respond(7, { ...target, requestId: 'bad', ok: true, snapshot: { privatePath: '/private' } })).toBe(false)
  service.respond(7, { ...target, requestId: 'bad', ok: false, code: 'CANVAS_EXPECTED' })
  await expect(result).rejects.toThrow('CANVAS_EXPECTED')
})

test('Given 长ID几何响应超过预算 When 匹配宿主应答 Then 立即明确失败而不是超时', async () => {
  const service = createCanvasViewCommandService({ isAvailable: () => true, send: () => undefined })
  service.register(7, target)
  const result = service.execute(target, { action: 'query' }, { requestId: 'large' })
  const nodeSizesById = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`${index}-${'节'.repeat(120)}`, { width: 200, height: 100 }]))
  const response = { ...target, requestId: 'large', ok: true, snapshot: { revision: 0, selectedNodeIds: [], viewport: { x: 0, y: 0, zoom: 1 }, expandedNodeId: null, activeTool: 'select', workbenchSizesByNodeId: {}, workbenchOffsetsByNodeId: {}, nodeSizesById } }
  expect(service.respond(8, response)).toBe(false)
  expect(service.respond(7, response)).toBe(true)
  await expect(result).rejects.toThrow('CANVAS_VIEW_RESPONSE_TOO_LARGE')
})

test('Given 布局请求 When Renderer只返回普通视图 Then 拒绝未计算的成功回执', async () => {
  const service = createCanvasViewCommandService({ isAvailable: () => true, send: () => undefined })
  service.register(7, target)
  const result = service.execute(target, { action: 'arrange', expectedRevision: 3, scope: 'all' }, { requestId: 'layout' })
  service.respond(7, { ...target, requestId: 'layout', ok: true, snapshot: { revision: 3, selectedNodeIds: [], viewport: { x: 0, y: 0, zoom: 1 }, expandedNodeId: null, activeTool: 'select', workbenchSizesByNodeId: {}, workbenchOffsetsByNodeId: {}, nodeSizesById: {} } })
  await expect(result).rejects.toThrow('CANVAS_VIEW_INVALID_RESPONSE')
})

test('Given 合法布局草案 When 精确revision匹配 Then 仅交给宿主继续提交', async () => {
  const service = createCanvasViewCommandService({ isAvailable: () => true, send: () => undefined })
  service.register(7, target)
  const result = service.execute(target, { action: 'arrange', expectedRevision: 3, scope: 'all' }, { requestId: 'prepared' })
  const snapshot: CanvasViewSnapshot = { revision: 3, selectedNodeIds: [], viewport: { x: 0, y: 0, zoom: 1 }, expandedNodeId: null, activeTool: 'select', workbenchSizesByNodeId: {}, workbenchOffsetsByNodeId: {}, nodeSizesById: {}, arrangement: { expectedRevision: 3, positions: [{ nodeId: 'a', position: { x: 20, y: 30 } }] } }
  expect(service.respond(7, { ...target, requestId: 'prepared', ok: true, snapshot })).toBe(true)
  expect(await result).toEqual(snapshot)
  const query = service.execute(target, { action: 'query' }, { requestId: 'unexpected' })
  service.respond(7, { ...target, requestId: 'unexpected', ok: true, snapshot })
  await expect(query).rejects.toThrow('CANVAS_VIEW_INVALID_RESPONSE')
})

test('Given Renderer准备后切走 When 主进程提交前复验 Then 拒绝旧前台宿主', () => {
  const service = createCanvasViewCommandService({ isAvailable: () => true, send: () => undefined })
  service.register(7, target)
  expect(() => service.assertAvailable(target)).not.toThrow()
  service.register(7, { ...target, sessionId: 'other' })
  expect(() => service.assertAvailable(target)).toThrow('CANVAS_VIEW_NOT_AVAILABLE')
})
