import type { CanvasNodePosition } from './canvas'
/** 仅用于前台会话视图的 IPC，不能作为共享图写入入口。 */
export const CANVAS_VIEW_IPC_CHANNELS = {
  REGISTER: 'canvas:view:register',
  REQUEST: 'canvas:view:request',
  RESPONSE: 'canvas:view:response',
  CANCEL: 'canvas:view:cancel',
} as const

/** 宿主固定的完整会话身份，禁止模型指定别的会话。 */
export interface CanvasViewCommandTarget {
  projectId: string
  sessionId: string
  canvasId: string
}
/** 会话视图几何；尺寸使用画布坐标，偏移使用屏幕像素。 */
export interface CanvasViewPoint { x: number; y: number }
export interface CanvasViewSize { width: number; height: number }
export interface CanvasViewViewport extends CanvasViewPoint { zoom: number }
/** Agent 可请求的会话视图操作；布局结果通过既有 CAS 保存。 */
export type CanvasViewCommand =
  | { action: 'query' }
  | { action: 'select' | 'focus'; nodeIds: string[] }
  | { action: 'fit' }
  | { action: 'viewport'; viewport: CanvasViewViewport }
  | { action: 'tool'; tool: 'select' | 'pan' }
  | { action: 'workbench'; nodeId: string | null; size?: CanvasViewSize; offset?: CanvasViewPoint; reset?: boolean }
  | { action: 'arrange'; expectedRevision: number; scope: 'selected' | 'related' | 'visible' | 'all' | 'nodes'; nodeIds?: string[] }
/** Renderer 实际完成后返回的轻量事实，不包含正文或私有路径。 */
export interface CanvasViewSnapshot {
  /** 仅为Renderer计算草案；宿主需再经权限、运行态与CAS验证提交，绝非持久化回执。 */
  arrangement?: { expectedRevision: number; positions: CanvasNodePosition[] }
  revision: number
  selectedNodeIds: string[]
  viewport: CanvasViewViewport
  expandedNodeId: string | null
  activeTool: 'select' | 'pan'
  workbenchSizesByNodeId: Record<string, CanvasViewSize>
  workbenchOffsetsByNodeId: Record<string, CanvasViewPoint>
  nodeSizesById: Record<string, CanvasViewSize>
}
/** 单次有界请求；到期请求不得开始执行。 */
export interface CanvasViewCommandRequest extends CanvasViewCommandTarget {
  requestId: string
  expiresAt: number
  command: CanvasViewCommand
}
/** 回执必须同时匹配 sender、身份与 requestId。 */
export type CanvasViewCommandResponse = CanvasViewCommandTarget & { requestId: string } & (
  | { ok: true; snapshot: CanvasViewSnapshot }
  | { ok: false; code: string }
)
/** 解析 IPC 身份，仅允许短的非空字符串。 */
export function isCanvasViewCommandTarget(value: unknown): value is CanvasViewCommandTarget {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return ['projectId', 'sessionId', 'canvasId'].every((key) => typeof record[key] === 'string'
    && (record[key] as string).length > 0 && (record[key] as string).length <= 512)
}
/** 严格比较完整会话身份。 */
export function sameCanvasViewTarget(a: CanvasViewCommandTarget, b: CanvasViewCommandTarget): boolean {
  return a.projectId === b.projectId && a.sessionId === b.sessionId && a.canvasId === b.canvasId
}

/** IPC 输入先收敛为普通对象，拒绝数组与空值。 */
function viewRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
/** 几何数字必须有限，避免异常缩放污染界面。 */
function viewPoint(value: unknown): boolean {
  return viewRecord(value) && Object.keys(value).every((key) => ['x', 'y', 'zoom'].includes(key)) && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
}
/** 身份数组采用有界短字符串集合。 */
function viewIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 10_000
    && value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 512)
}
/** 校验命令参数，防止未经工具 schema 的 IPC 进入 Renderer。 */
export function isCanvasViewCommand(value: unknown): value is CanvasViewCommand {
  if (!viewRecord(value)) return false
  if (value.action === 'query' || value.action === 'fit') return true
  if (value.action === 'select' || value.action === 'focus') return viewIds(value.nodeIds)
  if (value.action === 'viewport') return viewPoint(value.viewport) && viewRecord(value.viewport)
    && typeof value.viewport.zoom === 'number' && value.viewport.zoom >= 0.05 && value.viewport.zoom <= 8
  if (value.action === 'tool') return value.tool === 'select' || value.tool === 'pan'
  if (value.action === 'arrange') return Number.isSafeInteger(value.expectedRevision) && (value.expectedRevision as number) >= 0 && ['selected', 'related', 'visible', 'all', 'nodes'].includes(String(value.scope))
    && (value.scope !== 'nodes' || viewIds(value.nodeIds)) && (value.nodeIds === undefined || viewIds(value.nodeIds))
  if (value.action !== 'workbench') return false
  return (value.nodeId === null || (typeof value.nodeId === 'string' && value.nodeId.length > 0 && value.nodeId.length <= 512))
    && (value.reset === undefined || typeof value.reset === 'boolean')
    && (value.offset === undefined || viewPoint(value.offset))
    && (value.size === undefined || (viewRecord(value.size)
      && typeof value.size.width === 'number' && value.size.width >= 100 && value.size.width <= 10_000
      && typeof value.size.height === 'number' && value.size.height >= 100 && value.size.height <= 10_000))
}
/** 校验宿主请求身份、时限与业务命令。 */
export function isCanvasViewCommandRequest(value: unknown): value is CanvasViewCommandRequest {
  return viewRecord(value) && isCanvasViewCommandTarget(value)
    && typeof value.requestId === 'string' && value.requestId.length > 0 && value.requestId.length <= 512
    && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) && isCanvasViewCommand(value.command)
}
/** 校验有界几何索引，拒绝私有内容及超大返回值。 */
function viewGeometryMap(value: unknown, kind: 'size' | 'point'): boolean {
  if (!viewRecord(value) || Object.keys(value).length > 10_000) return false
  return Object.entries(value).every(([key, entry]) => key.length > 0 && key.length <= 512
    && (kind === 'point' ? viewPoint(entry) && viewRecord(entry) && Object.keys(entry).every((field) => ['x', 'y'].includes(field)) : viewRecord(entry)
      && Object.keys(entry).every((field) => ['width', 'height'].includes(field))
      && typeof entry.width === 'number' && Number.isFinite(entry.width) && entry.width > 0
      && typeof entry.height === 'number' && Number.isFinite(entry.height) && entry.height > 0))
}
/** 严格校验结果字段，避免 Renderer 将任意对象经工具回传模型。 */
export function isCanvasViewCommandResponse(value: unknown): value is CanvasViewCommandResponse {
  if (!viewRecord(value) || !isCanvasViewCommandTarget(value)
    || typeof value.requestId !== 'string' || value.requestId.length > 512) return false
  if (value.ok === false) return typeof value.code === 'string' && /^CANVAS_[A-Z_]{1,100}$/.test(value.code)
  if (value.ok !== true || !viewRecord(value.snapshot)) return false
  const snapshot = value.snapshot
  return Object.keys(snapshot).every((key) => ['revision', 'selectedNodeIds', 'viewport', 'expandedNodeId', 'activeTool', 'workbenchSizesByNodeId', 'workbenchOffsetsByNodeId', 'nodeSizesById', 'arrangement'].includes(key))
    && (snapshot.arrangement === undefined || isCanvasViewArrangement(snapshot.arrangement))
    && Number.isSafeInteger(snapshot.revision) && (snapshot.revision as number) >= 0
    && viewIds(snapshot.selectedNodeIds) && viewPoint(snapshot.viewport) && viewRecord(snapshot.viewport)
    && typeof snapshot.viewport.zoom === 'number' && Number.isFinite(snapshot.viewport.zoom) && snapshot.viewport.zoom > 0
    && (snapshot.expandedNodeId === null || typeof snapshot.expandedNodeId === 'string' && snapshot.expandedNodeId.length <= 512)
    && (snapshot.activeTool === 'select' || snapshot.activeTool === 'pan')
    && viewGeometryMap(snapshot.workbenchSizesByNodeId, 'size')
    && viewGeometryMap(snapshot.workbenchOffsetsByNodeId, 'point') && viewGeometryMap(snapshot.nodeSizesById, 'size')
}

/** 完整视图响应（含宿主身份）最多占用32KiB UTF-8 JSON。 */
export const CANVAS_VIEW_RESPONSE_MAX_BYTES = 32 * 1024

/** 校验实际序列化字节预算；循环引用或不可序列化值按无效响应拒绝。 */
export function isCanvasViewResponseWithinBudget(value: unknown): boolean {
  try {
    /** 先按UTF-16长度短路大对象，避免为明显超限响应再分配字节数组。 */
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' && serialized.length <= CANVAS_VIEW_RESPONSE_MAX_BYTES
      && new TextEncoder().encode(serialized).byteLength <= CANVAS_VIEW_RESPONSE_MAX_BYTES
  } catch {
    return false
  }
}

/** 在任何视图/布局副作用之前检验本次完整成功回执的预算。 */
export function assertCanvasViewSnapshotBudget(
  target: CanvasViewCommandTarget & { requestId: string },
  snapshot: CanvasViewSnapshot,
): void {
  if (!isCanvasViewResponseWithinBudget({ projectId: target.projectId, sessionId: target.sessionId,
    canvasId: target.canvasId, requestId: target.requestId, ok: true, snapshot })) {
    throw new Error('CANVAS_VIEW_RESPONSE_TOO_LARGE')
  }
}

/** 布局草案只允许有界节点位置，不携带任意mutation或Renderer私有数据。 */
export function isCanvasViewArrangement(value: unknown): value is NonNullable<CanvasViewSnapshot['arrangement']> {
  if (!viewRecord(value) || !Object.keys(value).every((key) => ['expectedRevision', 'positions'].includes(key))
    || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0
    || !Array.isArray(value.positions) || value.positions.length > 10_000) return false
  /** 拒绝同节点重复目标，避免提交语义依赖数组覆盖顺序。 */
  const seen = new Set<string>()
  return value.positions.every((entry: unknown) => {
    if (!viewRecord(entry) || !Object.keys(entry).every((key) => ['nodeId', 'position'].includes(key))
      || typeof entry.nodeId !== 'string' || entry.nodeId.length === 0 || entry.nodeId.length > 512
      || seen.has(entry.nodeId) || !viewPoint(entry.position) || !viewRecord(entry.position)
      || !Object.keys(entry.position).every((key) => ['x', 'y'].includes(key))) return false
    seen.add(entry.nodeId)
    return true
  })
}
