import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasBatchOperationEnvelope, CanvasMutation, CanvasViewCommand, CanvasViewCommandTarget, CanvasViewSnapshot } from '@proma/shared'
import type { CanvasToolRunContext } from './canvas-tool-provider'
import { createCanvasViewTools, type CanvasViewToolDependencies } from './canvas-view-tools'

/** 独立模拟前台路由及可动态撤销的项目授权。 */
function fixture() {
  /** 每轮宿主固定身份不允许来自模型参数。 */
  const context: CanvasToolRunContext = { projectId: 'project-1', sessionId: 'session-1', runStartedAt: 1, explicitReferences: [], permissionCeiling: 'execute' }
  const calls: Array<{ target: CanvasViewCommandTarget; command: CanvasViewCommand }> = []
  /** 只有宿主批处理可以持久化布局草案。 */
  const commits: CanvasBatchOperationEnvelope[] = []
  const snapshot: CanvasViewSnapshot = { revision: 4, selectedNodeIds: ['node-1'], viewport: { x: 0, y: 0, zoom: 1 }, expandedNodeId: null, activeTool: 'select', workbenchSizesByNodeId: {}, workbenchOffsetsByNodeId: {}, nodeSizesById: {} }
  let authorized = true
  let writable = true
  let onExecute = () => undefined as void
  /** 模拟等待事务队列期间的撤权。 */
  let beforeCommit = () => undefined as void
  const dependencies: CanvasViewToolDependencies = {
    access: {
      authorizeRead: () => { if (!authorized) throw new Error('DENIED') },
      requireLinkedCanvas: (_context, canvasId) => { if (canvasId !== 'canvas-1' || !authorized) throw new Error('DENIED'); return { projectId: 'project-1', sessionId: 'session-1', linkedCanvasIds: ['canvas-1'], defaultCanvasId: 'canvas-1', lastActiveCanvasId: 'canvas-1', updatedAt: 1 } },
      runWrite: (_context, effect) => { if (!writable) throw new Error('READ_ONLY'); return effect() },
    },
    documents: { load: () => ({ document: { ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 4 }, writable: true, nodeIssues: [] }),
      validateBatchOperations: (_target, _revision, mutations) => mutations as CanvasMutation[] },
    batch: { execute: async (envelope, assertAuthorized) => {
      beforeCommit(); assertAuthorized?.(); commits.push(envelope)
      return { document: { ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision: 5 }, operationId: 'layout-commit' }
    } },
    viewCommands: { execute: async (target, command, options) => { options?.assertAuthorized?.(); calls.push({ target, command }); onExecute(); await Promise.resolve(); options?.assertAuthorized?.(); return command.action === 'arrange'
      ? { ...snapshot, arrangement: { expectedRevision: command.expectedRevision, positions: [{ nodeId: 'node-1', position: { x: 20, y: 30 } }] } } : snapshot } },
  }
  /** 直接调用用于同时验证绕过schema的非法入参。 */
  const invoke = (name: string, params: Record<string, unknown>, signal?: AbortSignal) => createCanvasViewTools(dependencies, context).find(tool => tool.name === name)!.execute('call-1', params, signal, undefined, {} as never)
  return { context, calls, commits, snapshot, invoke, revoke: () => { authorized = false }, readOnly: () => { writable = false }, duringExecute: (effect: () => void) => { onExecute = effect }, duringQueue: (effect: () => void) => { beforeCommit = effect } }
}

describe('画布前台视图工具', () => {
  test('Given plan When query Then 返回前台真实快照且绑定宿主会话', async () => {
    const f = fixture()
    f.context.permissionCeiling = 'plan'
    const result = await f.invoke('canvas_view', { canvasId: 'canvas-1', action: 'query' })
    expect(result.details).toEqual(f.snapshot)
    expect(f.calls[0]).toEqual({ target: { projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1' }, command: { action: 'query' } })
  })
  test('Given 显式整理 When 执行 Then 精确baseRevision传入existing CAS命令', async () => {
    const f = fixture()
    const result = await f.invoke('canvas_arrange', { canvasId: 'canvas-1', scope: 'nodes', nodeIds: ['node-1'], baseRevision: 4, intent: 'explicit' })
    expect(f.calls[0]!.command).toEqual({ action: 'arrange', scope: 'nodes', nodeIds: ['node-1'], expectedRevision: 4 })
    expect(f.commits[0]).toMatchObject({ projectId: 'project-1', canvasId: 'canvas-1', baseRevision: 4,
      sourceSessionId: 'session-1', sourceRunStartedAt: 1, sourceToolCallId: 'call-1',
      operations: [{ type: 'move-nodes', positions: [{ nodeId: 'node-1', position: { x: 20, y: 30 } }] }] })
    expect(result.details).toMatchObject({ revision: 5, operationId: 'layout-commit' })
    expect(result.details).not.toHaveProperty('arrangement')
  })
  test('Given 布局已算好但提交排队 When 用户撤权 Then 锁内复查阻止图提交', async () => {
    const f = fixture()
    f.duringQueue(f.revoke)
    await expect(f.invoke('canvas_arrange', { canvasId: 'canvas-1', scope: 'all', baseRevision: 4, intent: 'explicit' })).rejects.toThrow('DENIED')
    expect(f.commits).toHaveLength(0)
  })
  test('Given 视图各动作 When 调用 Then 仅转发对应命令且不携带来源身份字段', async () => {
    const f = fixture()
    for (const command of [{ action: 'select', nodeIds: [] }, { action: 'focus', nodeIds: ['node-1'] }, { action: 'fit' }, { action: 'viewport', viewport: { x: 12, y: 23, zoom: 2 } }, { action: 'tool', tool: 'pan' }, { action: 'workbench', nodeId: 'node-1', size: { width: 300, height: 200 }, offset: { x: 1, y: 2 } }, { action: 'workbench', nodeId: null }]) {
      await f.invoke('canvas_view', { canvasId: 'canvas-1', ...command })
      expect(f.calls.at(-1)!.command).toEqual(command as CanvasViewCommand)
    }
  })
  test('Given 非法身份或参数 When 调用 Then 在前台请求前拒绝', async () => {
    const f = fixture()
    for (const params of [{ canvasId: 'canvas-1', action: 'query', projectId: 'other' }, { canvasId: 'canvas-1', action: 'fit', sessionId: 'other' }, { canvasId: 'canvas-1', action: 'viewport', viewport: { x: 0, y: 0, zoom: 99 } }]) {
      await expect(f.invoke('canvas_view', params)).rejects.toThrow('CANVAS_VIEW_INVALID_COMMAND')
    }
    await expect(f.invoke('canvas_arrange', { canvasId: 'canvas-1', baseRevision: 4, intent: 'explicit', scope: 'nodes' })).rejects.toThrow()
    await expect(f.invoke('canvas_arrange', { canvasId: 'canvas-1', baseRevision: 4, scope: 'all' })).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  })
  test('Given plan或固定子Agent When 操作前台或整理 Then 拒绝', async () => {
    const f = fixture()
    f.context.permissionCeiling = 'plan'
    await expect(f.invoke('canvas_view', { canvasId: 'canvas-1', action: 'fit' })).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    f.context.permissionCeiling = 'execute'
    f.context.canvasAgentMode = 'canvas-orchestrator'
    await expect(f.invoke('canvas_arrange', { canvasId: 'canvas-1', scope: 'all', baseRevision: 4, intent: 'explicit' })).rejects.toThrow('CANVAS_VIEW_MANAGEMENT_DENIED')
    expect(f.calls).toHaveLength(0)
  })
  for (const reason of ['abort', 'revoke', 'readonly'] as const) {
    test(`Given 请求过程中${reason} When 结果到达 Then 不声称成功`, async () => {
      const f = fixture()
      const controller = new AbortController()
      f.duringExecute(() => { if (reason === 'abort') controller.abort(); if (reason === 'revoke') f.revoke(); if (reason === 'readonly') f.readOnly() })
      await expect(f.invoke('canvas_view', { canvasId: 'canvas-1', action: 'fit' }, controller.signal)).rejects.toThrow()
    })
  }
})
