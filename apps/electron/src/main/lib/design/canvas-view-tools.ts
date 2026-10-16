import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { CanvasViewCommand } from '@proma/shared'
import { parseCanvasBatchOperationEnvelope } from '@proma/shared'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import type { CanvasToolAccessFacade } from './canvas-tool-access-facade'
import type { CanvasToolRunContext, CanvasToolProviderDependencies } from './canvas-tool-provider'
import type { CanvasViewCommandService } from './canvas-view-command-service'

/** 前台工具只借用已有会话授权和唯一视图路由服务。 */
export interface CanvasViewToolDependencies {
  access: Pick<CanvasToolAccessFacade, 'authorizeRead' | 'requireLinkedCanvas' | 'runWrite'>
  viewCommands: Pick<CanvasViewCommandService, 'execute'> & Partial<Pick<CanvasViewCommandService, 'assertAvailable'>>
  /** 布局只借用Renderer计算，持久化由宿主现有批处理完成。 */
  documents: CanvasToolProviderDependencies['documents']
  batch: CanvasToolProviderDependencies['batch']
  /** 等待前台计算或事务队列后重新检查编排写权。 */
  assertLayoutWritable?: (canvasId: string) => void
}

/** 所有身份有界；项目和会话身份只允许宿主注入。 */
const ID_SCHEMA = Type.String({ minLength: 1, maxLength: 512 })
const NODE_IDS_SCHEMA = Type.Array(ID_SCHEMA, { maxItems: 10_000, uniqueItems: true })
const POINT_SCHEMA = Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false })
const SIZE_SCHEMA = Type.Object({ width: Type.Number({ minimum: 100, maximum: 10_000 }), height: Type.Number({ minimum: 100, maximum: 10_000 }) }, { additionalProperties: false })
/** 明确区分每种动作，禁止将未知字段跨前台IPC透传。 */
const VIEW_SCHEMA = Type.Union([
  Type.Object({ canvasId: ID_SCHEMA, action: Type.Literal('query') }, { additionalProperties: false }),
  Type.Object({ canvasId: ID_SCHEMA, action: Type.Union([Type.Literal('select'), Type.Literal('focus')]), nodeIds: NODE_IDS_SCHEMA }, { additionalProperties: false }),
  Type.Object({ canvasId: ID_SCHEMA, action: Type.Literal('fit') }, { additionalProperties: false }),
  Type.Object({ canvasId: ID_SCHEMA, action: Type.Literal('viewport'), viewport: Type.Object({ x: Type.Number(), y: Type.Number(), zoom: Type.Number({ minimum: 0.05, maximum: 8 }) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ canvasId: ID_SCHEMA, action: Type.Literal('tool'), tool: Type.Union([Type.Literal('select'), Type.Literal('pan')]) }, { additionalProperties: false }),
  Type.Object({ canvasId: ID_SCHEMA, action: Type.Literal('workbench'), nodeId: Type.Union([ID_SCHEMA, Type.Null()]), size: Type.Optional(SIZE_SCHEMA), offset: Type.Optional(POINT_SCHEMA), reset: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
])
/** 布局修改必须带明确意图和精确版本，不由工具自动刷新基线。 */
const ARRANGE_SCHEMA = Type.Object({
  canvasId: ID_SCHEMA,
  scope: Type.Union((['selected', 'related', 'visible', 'all', 'nodes'] as const).map(scope => Type.Literal(scope))),
  nodeIds: Type.Optional(NODE_IDS_SCHEMA),
  baseRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  intent: Type.Literal('explicit'),
}, { additionalProperties: false })

/** 保留每个工具的独立参数推断。 */
function defineTool<T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition<T> { return tool }

/** 创建前台视图与布局工具；无可见对应会话时由服务明确返回不可用。 */
export function createCanvasViewTools(dependencies: CanvasViewToolDependencies, context: CanvasToolRunContext): ToolDefinition[] {
  /** 每次执行前后重验目标授权；普通视图变更不占用画布编排写权。 */
  const authorize = (canvasId: string, write: boolean, signal?: AbortSignal): void => {
    signal?.throwIfAborted()
    dependencies.access.authorizeRead(context)
    dependencies.access.requireLinkedCanvas(context, canvasId)
    if (!write) return
    if (context.permissionCeiling !== 'execute') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
    if (context.canvasAgentTarget || context.canvasAgentMode || context.canvasOrchestrationId || context.parentWorkflow) throw new Error('CANVAS_VIEW_MANAGEMENT_DENIED')
    dependencies.access.runWrite(context, () => undefined)
  }
  /** 执行精确宿主目标；传递实时检查回调并复核返回事实。 */
  const execute = async (canvasId: string, command: CanvasViewCommand, signal?: AbortSignal) => {
    const assertAuthorized = (): void => authorize(canvasId, command.action !== 'query', signal)
    assertAuthorized()
    const snapshot = await dependencies.viewCommands.execute({ projectId: context.projectId, sessionId: context.sessionId, canvasId }, command, { signal, assertAuthorized })
    assertAuthorized()
    return { content: [{ type: 'text' as const, text: JSON.stringify(snapshot) }], details: snapshot }
  }
  return [
    defineTool({
      name: 'canvas_view', label: '控制画布视图',
      description: '查询或操作当前会话前台画布：选择、聚焦、适应画布、视口、选择/拖动工具、工作台展开及大小位置。query允许计划模式，其余操作需要执行权限；没有对应前台画布时明确不可用，不改变其他会话。',
      parameters: VIEW_SCHEMA,
      execute: async (_toolCallId, params, signal) => {
        if (!Value.Check(VIEW_SCHEMA, params)) throw new Error('CANVAS_VIEW_INVALID_COMMAND')
        /** schema 已逐动作严格校验；canvasId只用于路由而不进入命令载荷。 */
        const { canvasId, ...command } = params
        return execute(canvasId, command, signal)
      },
    }),
    defineTool({
      name: 'canvas_arrange', label: '整理画布布局',
      description: '复用前台画布自动整理，范围为选中、相关、可见、全部或指定节点。必须传读取到的baseRevision与intent=explicit；nodes范围必须给nodeIds，冲突不自动重试。只有当前普通主Agent可调用。',
      parameters: ARRANGE_SCHEMA,
      execute: async (toolCallId, params, signal) => {
        if (!Value.Check(ARRANGE_SCHEMA, params) || (params.scope === 'nodes' && !params.nodeIds?.length)) throw new Error('CANVAS_VIEW_INVALID_COMMAND')
        /** 模型提供画布ID，项目、会话与幂等来源始终由Host补齐。 */
        const target = { projectId: context.projectId, canvasId: params.canvasId }
        const viewTarget = { ...target, sessionId: context.sessionId }
        const assertAuthorized = (): void => {
          authorize(params.canvasId, true, signal)
          dependencies.assertLayoutWritable?.(params.canvasId)
          dependencies.viewCommands.assertAvailable?.(viewTarget)
        }
        assertAuthorized()
        const prepared = await dependencies.viewCommands.execute(viewTarget, {
          action: 'arrange', expectedRevision: params.baseRevision, scope: params.scope,
          ...(params.nodeIds === undefined ? {} : { nodeIds: params.nodeIds }),
        }, { signal, assertAuthorized })
        assertAuthorized()
        const { arrangement, ...snapshot } = prepared
        if (!arrangement || arrangement.expectedRevision !== params.baseRevision || snapshot.revision !== params.baseRevision) {
          throw new Error('CANVAS_VIEW_INVALID_LAYOUT')
        }
        if (arrangement.positions.length === 0) {
          if (dependencies.documents.load(target).document.revision !== params.baseRevision) throw new Error('CANVAS_REVISION_CONFLICT')
          return { content: [{ type: 'text' as const, text: JSON.stringify(snapshot) }], details: snapshot }
        }
        /** 验证Worker位置草案，版本冲突不自动更换基线。 */
        const operations = dependencies.documents.validateBatchOperations(target, params.baseRevision, [
          { type: 'move-nodes', positions: arrangement.positions },
        ])
        const result = await dependencies.batch.execute(parseCanvasBatchOperationEnvelope({
          ...target, baseRevision: params.baseRevision, operations,
          sourceSessionId: context.sessionId, sourceRunStartedAt: context.runStartedAt, sourceToolCallId: toolCallId,
        }), assertAuthorized)
        /** 事务已提交后按持久事实报告，不因之后取消误报未提交。 */
        const details = { ...snapshot, revision: result.document.revision, operationId: result.operationId }
        return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details }
      },
    }),
  ]
}
