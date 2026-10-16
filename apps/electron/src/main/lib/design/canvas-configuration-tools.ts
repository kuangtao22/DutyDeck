import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { CanvasMediaModelOption, CanvasMutation } from '@proma/shared'
import { parseCanvasBatchOperationEnvelope, parseCanvasMediaModelScope } from '@proma/shared'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import type { CanvasToolAccessFacade } from './canvas-tool-access-facade'
import type { CanvasToolProviderDependencies, CanvasToolRunContext } from './canvas-tool-provider'

/** 宿主提供实时公开目录；禁止工具读取凭据或连接地址。 */
export interface CanvasConfigurationCatalog {
  models: CanvasMediaModelOption[]
  connections: Array<{ id: string; name: string; enabled: boolean }>
}

/** 设置工具复用既有权限和原子事务，不另建配置存储或生成入口。 */
export interface CanvasConfigurationToolDependencies {
  access: Pick<CanvasToolAccessFacade, 'authorizeRead' | 'requireLinkedCanvas' | 'runWrite'>
  documents: CanvasToolProviderDependencies['documents']
  batch: { execute: (input: Parameters<CanvasToolProviderDependencies['batch']['execute']>[0], assertAuthorized?: () => void) => ReturnType<CanvasToolProviderDependencies['batch']['execute']> }
  catalog: (projectId: string) => CanvasConfigurationCatalog | Promise<CanvasConfigurationCatalog>
  /** 异步目录与队列等待后仍必须遵守编排所有权。 */
  assertSettingsWritable?: (canvasId: string) => void
}

/** 目录每页最多五十项，每个目录序列化预算为十二 KiB。 */
const CATALOG_PAGE_LIMIT = 50
const CATALOG_PAGE_CHARS = 12_288
/** ID 与共享模型选择解析器保持兼容，不能截断后用于写入。 */
const ID_SCHEMA = Type.String({ minLength: 1, maxLength: 2048 })
/** 明确列出可改配置，拒绝调用方混入凭据、连接 URL 或节点配置。 */
const UPDATE_SCHEMA = Type.Object({
  canvasId: Type.String({ minLength: 1, maxLength: 128 }),
  baseRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  settingsIntent: Type.Literal('explicit'),
  mediaModelScope: Type.Optional(Type.Union([
    Type.Object({ mode: Type.Literal('all-enabled') }, { additionalProperties: false }),
    Type.Object({ mode: Type.Literal('providers'), providers: Type.Array(ID_SCHEMA, { minItems: 1, maxItems: 16 }) }, { additionalProperties: false }),
    Type.Object({ mode: Type.Literal('selected'), modelIds: Type.Array(ID_SCHEMA, { maxItems: 256 }) }, { additionalProperties: false }),
  ])),
  comfyuiConnectionId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()])),
}, { additionalProperties: false })
/** 两类目录使用相同分页起点，但分别返回 nextOffset 供调用者继续读取。 */
const READ_SCHEMA = Type.Object({
  canvasId: Type.String({ minLength: 1, maxLength: 128 }),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: CATALOG_PAGE_LIMIT })),
}, { additionalProperties: false })

/** 保留工具 schema 参数推断，避免开放类型绕过接口校验。 */
function defineTool<T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition<T> { return tool }

/** 输入目录和分页参数，返回预算内的完整条目与可靠的续读位置。 */
function page<T, U>(entries: readonly T[], offset: number, limit: number, project: (entry: T) => U) {
  /** 只投影当前页，避免大目录生成全量公开副本。 */
  const items: U[] = []
  let characters = 0
  let cursor = offset
  while (cursor < entries.length && items.length < limit) {
    const item = project(entries[cursor]!)
    const size = JSON.stringify(item).length
    if (size > CATALOG_PAGE_CHARS) throw new Error('CANVAS_SETTINGS_CATALOG_ENTRY_TOO_LARGE')
    if (characters + size > CATALOG_PAGE_CHARS) break
    items.push(item)
    characters += size
    cursor++
  }
  return { items, total: entries.length, nextOffset: cursor < entries.length ? cursor : null }
}

/** 创建画布配置读写工具；更新只改变新任务默认值，不启动生成或覆盖节点设置。 */
export function createCanvasConfigurationTools(
  dependencies: CanvasConfigurationToolDependencies,
  context: CanvasToolRunContext,
): ToolDefinition[] {
  /** 异步目录返回后重新校验停止、会话和关联，避免泄漏撤权画布。 */
  const authorize = (canvasId: string, signal?: AbortSignal): void => {
    signal?.throwIfAborted()
    dependencies.access.authorizeRead(context)
    dependencies.access.requireLinkedCanvas(context, canvasId)
  }
  /** 固定子 Agent 和编排身份不能重写用户画布全局模型范围。 */
  const authorizeUpdate = (canvasId: string, signal?: AbortSignal): void => {
    authorize(canvasId, signal)
    if (context.permissionCeiling !== 'execute') throw new Error('CANVAS_EXECUTE_INTENT_REQUIRED')
    if (context.canvasAgentTarget || context.canvasAgentMode || context.canvasOrchestrationId || context.parentWorkflow) {
      throw new Error('CANVAS_SETTINGS_MANAGEMENT_DENIED')
    }
    dependencies.assertSettingsWritable?.(canvasId)
  }
  return [
    defineTool({
      name: 'canvas_get_settings', label: '读取画布设置',
      description: '读取画布版本、媒体模型范围和 ComfyUI 默认连接，以及分页公开模型和连接目录。目录不含凭据和地址；更新前必须读取版本。',
      parameters: READ_SCHEMA,
      execute: async (_toolCallId, params, signal) => {
        if (!Value.Check(READ_SCHEMA, params)) throw new Error('CANVAS_SETTINGS_INPUT_INVALID')
        authorize(params.canvasId, signal)
        const catalog = await dependencies.catalog(context.projectId)
        authorize(params.canvasId, signal)
        const document = dependencies.documents.load({ projectId: context.projectId, canvasId: params.canvasId }).document
        const offset = params.offset ?? 0
        const limit = params.limit ?? 20
        const details = {
          canvasId: params.canvasId, revision: document.revision,
          mediaModelScope: document.mediaModelScope ?? { mode: 'all-enabled' },
          comfyuiConnectionId: document.comfyuiConnectionId ?? null,
          models: page(catalog.models, offset, limit, model => ({
            profileId: model.profileId, modelId: model.modelId, name: model.name.slice(0, 256),
            mediaKind: model.mediaKind, provider: model.provider, executor: model.executor,
            available: model.available, capabilities: model.capabilities,
          })),
          connections: page(catalog.connections, offset, limit, connection => ({
            id: connection.id, name: connection.name.slice(0, 256), enabled: connection.enabled,
          })),
        }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      },
    }),
    defineTool({
      name: 'canvas_update_settings', label: '更新画布设置',
      description: '仅在用户明确要求修改画布全局设置时使用，声明 settingsIntent=explicit，并传读取到的精确 baseRevision。可改媒体模型范围和新任务默认 ComfyUI 连接（null 清空）。版本冲突需重新读取并复核，不自动重试，不启动生成。',
      parameters: UPDATE_SCHEMA,
      execute: async (toolCallId, params, signal) => {
        if (!Value.Check(UPDATE_SCHEMA, params)) throw new Error('CANVAS_SETTINGS_INPUT_INVALID')
        authorizeUpdate(params.canvasId, signal)
        /** 提前拒绝只读项目，目录等待结束后再次检查。 */
        dependencies.access.runWrite(context, () => undefined)
        if (params.mediaModelScope === undefined && params.comfyuiConnectionId === undefined) throw new Error('CANVAS_SETTINGS_EMPTY_UPDATE')
        const catalog = await dependencies.catalog(context.projectId)
        authorizeUpdate(params.canvasId, signal)
        return dependencies.access.runWrite(context, async () => {
          /** 只提交显式出现的字段，其他画布和节点配置保留原值。 */
          const operations: CanvasMutation[] = []
          if (params.mediaModelScope !== undefined) {
            const scope = parseCanvasMediaModelScope(params.mediaModelScope)
            if (scope.mode === 'selected' && scope.modelIds.some(id => !catalog.models.some(model => model.profileId === id && model.available))) {
              throw new Error('CANVAS_SETTINGS_MODEL_UNAVAILABLE')
            }
            if (scope.mode === 'providers' && scope.providers.some(provider => !catalog.models.some(model => model.provider === provider && model.available))) {
              throw new Error('CANVAS_SETTINGS_PROVIDER_UNAVAILABLE')
            }
            operations.push({ type: 'set-media-model-scope', scope })
          }
          if (params.comfyuiConnectionId !== undefined) {
            if (params.comfyuiConnectionId !== null && !catalog.connections.some(connection => connection.id === params.comfyuiConnectionId && connection.enabled)) {
              throw new Error('CANVAS_SETTINGS_CONNECTION_UNAVAILABLE')
            }
            operations.push({ type: 'set-comfyui-connection', connectionId: params.comfyuiConnectionId })
          }
          const target = { projectId: context.projectId, canvasId: params.canvasId }
          const validated = dependencies.documents.validateBatchOperations(target, params.baseRevision, operations)
          const result = await dependencies.batch.execute(parseCanvasBatchOperationEnvelope({
            ...target, baseRevision: params.baseRevision, operations: validated,
            sourceSessionId: context.sessionId, sourceRunStartedAt: context.runStartedAt, sourceToolCallId: toolCallId,
          }), () => dependencies.access.runWrite(context, () => authorizeUpdate(params.canvasId, signal)))
          const details = { canvasId: params.canvasId, revision: result.document.revision, operationId: result.operationId,
            mediaModelScope: result.document.mediaModelScope ?? { mode: 'all-enabled' },
            comfyuiConnectionId: result.document.comfyuiConnectionId ?? null }
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details }
        })
      },
    }),
  ]
}
