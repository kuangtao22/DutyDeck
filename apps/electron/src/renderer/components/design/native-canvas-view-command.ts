import { assertCanvasViewSnapshotBudget } from '@proma/shared'
import type { CanvasNode, CanvasViewCommand, CanvasViewCommandRequest, CanvasViewCommandResponse, CanvasViewSnapshot, CanvasViewSize } from '@proma/shared'
import { createAgentCanvasWorkbenchChangeUpdate, createAgentCanvasWorkbenchGeometryUpdate, createClosedAgentCanvasWorkbenchUpdate } from '../../atoms/agent-canvas-atoms'
import type { AgentCanvasViewState } from '../../atoms/agent-canvas-atoms'
import { createNativeCanvasChangedNodesFocusUpdate } from './native-canvas-navigation'

/** 计算纯会话视图补丁，不写共享图、不发送消息、不丢弃草稿。 */
export function createCanvasViewUpdate(
  command: CanvasViewCommand,
  current: AgentCanvasViewState,
  nodes: readonly CanvasNode[],
  sizes: ReadonlyMap<string, CanvasViewSize>,
  surface: CanvasViewSize,
): Partial<AgentCanvasViewState> {
  const ids = new Set(nodes.map((node) => node.id))
  if (command.action === 'select' || command.action === 'focus') {
    if (command.nodeIds.some((id) => !ids.has(id))) throw new Error('CANVAS_NODE_NOT_FOUND')
    const selectedNodeIds = [...new Set(command.nodeIds)]
    return command.action === 'focus'
      ? createNativeCanvasChangedNodesFocusUpdate(nodes, selectedNodeIds, sizes, current.viewport, surface)
      : { selectedNodeId: selectedNodeIds[0] ?? null, selectedNodeIds }
  }
  if (command.action === 'fit') {
    return { viewport: createNativeCanvasChangedNodesFocusUpdate(nodes, [...ids], sizes, current.viewport, surface).viewport }
  }
  if (command.action === 'viewport') {
    if (![command.viewport.x, command.viewport.y, command.viewport.zoom].every(Number.isFinite)
      || command.viewport.zoom < 0.05 || command.viewport.zoom > 8) throw new Error('CANVAS_VIEW_INVALID_COMMAND')
    return { viewport: { ...command.viewport } }
  }
  if (command.action === 'tool') return { activeTool: command.tool }
  if (command.action === 'workbench') {
    if (command.nodeId !== null && !ids.has(command.nodeId)) throw new Error('CANVAS_NODE_NOT_FOUND')
    if (current.workbenchDraft?.dirty && command.nodeId !== current.expandedNodeId) throw new Error('CANVAS_VIEW_UNSAVED_DRAFT')
    if (command.nodeId === null) return createClosedAgentCanvasWorkbenchUpdate()
    if (command.size && (!Number.isFinite(command.size.width) || !Number.isFinite(command.size.height)
      || command.size.width < 100 || command.size.height < 100 || command.size.width > 10_000 || command.size.height > 10_000)) throw new Error('CANVAS_VIEW_INVALID_COMMAND')
    if (command.offset && (!Number.isFinite(command.offset.x) || !Number.isFinite(command.offset.y))) throw new Error('CANVAS_VIEW_INVALID_COMMAND')
    const update = command.nodeId === current.expandedNodeId ? {} : createAgentCanvasWorkbenchChangeUpdate(current, command.nodeId)
    if (command.reset) {
      const workbenchSizesByNodeId = { ...current.workbenchSizesByNodeId }
      const workbenchOffsetsByNodeId = { ...current.workbenchOffsetsByNodeId }
      delete workbenchSizesByNodeId[command.nodeId]
      delete workbenchOffsetsByNodeId[command.nodeId]
      return { ...update, workbenchSizesByNodeId, workbenchOffsetsByNodeId }
    }
    return { ...update, ...createAgentCanvasWorkbenchGeometryUpdate(current, command.nodeId, command) }
  }
  return {}
}

/** Renderer 命令处理器依赖由当前 React 工作区提供，便于真实生命周期测试。 */
export interface CanvasViewRequestHandlerDependencies {
  isAvailable: (request: CanvasViewCommandRequest) => boolean
  execute: (request: CanvasViewCommandRequest, signal: AbortSignal) => Promise<CanvasViewSnapshot>
}
/** 建立可取消且至多一个活跃命令的执行器；卸载后永久失效。 */
export function createCanvasViewRequestHandler(dependencies: CanvasViewRequestHandlerDependencies) {
  let disposed = false
  let active: { requestId: string; controller: AbortController } | null = null
  return {
    async handle(request: CanvasViewCommandRequest): Promise<CanvasViewCommandResponse> {
      const identity = { projectId: request.projectId, sessionId: request.sessionId, canvasId: request.canvasId, requestId: request.requestId }
      if (disposed || Date.now() >= request.expiresAt || !dependencies.isAvailable(request)) return { ...identity, ok: false, code: 'CANVAS_VIEW_NOT_AVAILABLE' }
      if (active) return { ...identity, ok: false, code: 'CANVAS_VIEW_BUSY' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.min(15_000, request.expiresAt - Date.now()))
      active = { requestId: request.requestId, controller }
      try {
        const snapshot = await dependencies.execute(request, controller.signal)
        assertCanvasViewSnapshotBudget(request, snapshot)
        if (controller.signal.aborted || disposed) throw new Error('CANVAS_VIEW_CANCELLED')
        if (!dependencies.isAvailable(request)) throw new Error('CANVAS_VIEW_NOT_AVAILABLE')
        return { ...identity, ok: true, snapshot }
      } catch (error) {
        const code = error instanceof Error && /^CANVAS_[A-Z_]+$/.test(error.message) ? error.message : 'CANVAS_VIEW_FAILED'
        return { ...identity, ok: false, code }
      } finally {
        clearTimeout(timer)
        if (active?.controller === controller) active = null
      }
    },
    cancel(requestId: string): void { if (active?.requestId === requestId) active.controller.abort() },
    cancelActive(): void { active?.controller.abort() },
    dispose(): void { disposed = true; active?.controller.abort() },
  }
}

/** 在启动任何 Worker 前校验 Agent 请求的 revision，并收敛范围为现存节点。 */
export function resolveCanvasViewArrangeScope(
  command: Extract<CanvasViewCommand, { action: 'arrange' }>,
  document: { revision: number; nodes: readonly Pick<CanvasNode, 'id'>[] },
  context: { validSelectedNodeIds: readonly string[]; relatedArrangeNodeIds: readonly string[]; visibleNodeIds: readonly string[] },
): readonly string[] {
  if (document.revision !== command.expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
  /** 一次建索引，避免大选区进行逐节点二次扫描。 */
  const nodeIds = new Set(document.nodes.map((node) => node.id))
  const scope = command.scope === 'selected' ? context.validSelectedNodeIds
    : command.scope === 'related' ? context.relatedArrangeNodeIds
    : command.scope === 'visible' ? context.visibleNodeIds
    : command.scope === 'all' ? [...nodeIds] : command.nodeIds ?? []
  if (scope.some((id) => !nodeIds.has(id))) throw new Error('CANVAS_NODE_NOT_FOUND')
  return [...new Set(scope)]
}
