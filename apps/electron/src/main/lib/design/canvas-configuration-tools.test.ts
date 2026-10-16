import { describe, expect, test } from 'bun:test'
import { applyCanvasMutations, createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasMediaModelOption, CanvasMutation } from '@proma/shared'
import type { CanvasToolRunContext } from './canvas-tool-provider'
import { createCanvasConfigurationTools, type CanvasConfigurationToolDependencies } from './canvas-configuration-tools'

/** 每个测试独立保存画布和权限，用真实 mutation 验证只更改目标配置。 */
function fixture() {
  /** 模拟同一画布的权威状态和可撤销授权。 */
  let document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
  let authorized = true
  let writable = true
  let writes = 0
  /** 普通项目 Agent 的宿主身份。 */
  const context: CanvasToolRunContext = { projectId: 'project-1', sessionId: 'agent-1', runStartedAt: 1, explicitReferences: [], permissionCeiling: 'execute' }
  /** 公开目录夹带敏感字段用于验证工具投影不会泄漏额外属性。 */
  const model: CanvasMediaModelOption = { profileId: 'model-1', name: '模型', modelId: 'real-model', available: true, executor: 'api', provider: 'minimax', mediaKind: 'video', capabilities: ['text-to-video'], support: { state: 'supported', adapterId: 'api' } }
  const catalog = { models: [{ ...model, apiKey: 'secret', url: 'https://private' }], connections: [{ id: 'local', name: '本地', enabled: true, apiKey: 'secret', url: 'https://private' }] }
  /** 复用生产依赖形状，并在每次读取时复验授权。 */
  const dependencies: CanvasConfigurationToolDependencies = {
    access: { authorizeRead: () => { if (!authorized) throw new Error('DENIED') }, requireLinkedCanvas: () => { if (!authorized) throw new Error('DENIED'); return { projectId: 'project-1', sessionId: 'agent-1', linkedCanvasIds: ['canvas-1'], defaultCanvasId: 'canvas-1', lastActiveCanvasId: 'canvas-1', updatedAt: 1 } }, runWrite: (_context, effect) => { if (!writable) throw new Error('READ_ONLY'); return effect() } },
    documents: { load: () => ({ document, writable: true, nodeIssues: [] }), validateBatchOperations: (_target, revision, operations) => { if (revision !== document.revision) throw new Error('CANVAS_REVISION_CONFLICT'); return operations as CanvasMutation[] } },
    /** 此fixture仅接收上方validateBatchOperations核验后序列化的mutation。 */
    batch: { execute: async (input, assertAuthorized) => { assertAuthorized?.(); writes++; document = { ...applyCanvasMutations(document, input.operations as unknown as CanvasMutation[]), revision: document.revision + 1 }; return { document, operationId: 'operation-1' } } },
    catalog: () => catalog,
  }
  /** 直接执行工具，包含绕过 JSON schema 的边界输入。 */
  const invoke = (name: string, params: Record<string, unknown>, signal?: AbortSignal) => createCanvasConfigurationTools(dependencies, context).find(tool => tool.name === name)!.execute('call-1', params, signal, undefined, {} as never)
  return { context, dependencies, catalog, invoke, document: () => document, writes: () => writes, revoke: () => { authorized = false }, readOnly: () => { writable = false } }
}

/** 显式配置请求的固定测试基线。 */
const request = { canvasId: 'canvas-1', baseRevision: 0, settingsIntent: 'explicit', mediaModelScope: { mode: 'selected', modelIds: ['model-1'] } }

describe('画布设置 Agent 工具', () => {
  test('Given 公开目录 When 读取设置 Then 返回版本与有界分页且不泄漏凭据或 URL', async () => {
    const f = fixture()
    const result = await f.invoke('canvas_get_settings', { canvasId: 'canvas-1', limit: 1 })
    expect(result.details).toMatchObject({ revision: 0, mediaModelScope: { mode: 'all-enabled' }, comfyuiConnectionId: null, models: { total: 1, nextOffset: null }, connections: { total: 1 } })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('https://private')
  })
  test('Given 明确授权 When 同时更新范围和连接 Then 单次事务提交且保留视口', async () => {
    const f = fixture()
    const viewport = f.document().viewport
    await f.invoke('canvas_update_settings', { ...request, comfyuiConnectionId: 'local' })
    expect(f.document()).toMatchObject({ mediaModelScope: request.mediaModelScope, comfyuiConnectionId: 'local', viewport })
    expect(f.writes()).toBe(1)
    await f.invoke('canvas_update_settings', { canvasId: 'canvas-1', baseRevision: f.document().revision, settingsIntent: 'explicit', comfyuiConnectionId: null })
    expect(f.document().comfyuiConnectionId).toBeNull()
  })
  test('Given 旧基线 When 更新 Then 冲突且不自动重试', async () => {
    const f = fixture()
    await expect(f.invoke('canvas_update_settings', { ...request, baseRevision: 2 })).rejects.toThrow('CANVAS_REVISION_CONFLICT')
    expect(f.writes()).toBe(0)
  })
  test('Given 未明确意图或计划模式或固定 Agent When 更新 Then 拒绝', async () => {
    const f = fixture()
    await expect(f.invoke('canvas_update_settings', { ...request, settingsIntent: undefined })).rejects.toThrow()
    f.context.permissionCeiling = 'plan'
    await expect(f.invoke('canvas_update_settings', request)).rejects.toThrow('CANVAS_EXECUTE_INTENT_REQUIRED')
    f.context.permissionCeiling = 'execute'
    f.context.canvasAgentMode = 'canvas-orchestrator'
    await expect(f.invoke('canvas_update_settings', request)).rejects.toThrow('CANVAS_SETTINGS_MANAGEMENT_DENIED')
    expect(f.writes()).toBe(0)
  })
  test('Given 失效模型或供应商或禁用连接 When 更新 Then 不提交', async () => {
    const f = fixture()
    await expect(f.invoke('canvas_update_settings', { ...request, mediaModelScope: { mode: 'selected', modelIds: ['missing'] } })).rejects.toThrow('CANVAS_SETTINGS_MODEL_UNAVAILABLE')
    await expect(f.invoke('canvas_update_settings', { ...request, mediaModelScope: { mode: 'providers', providers: ['dreamina'] } })).rejects.toThrow('CANVAS_SETTINGS_PROVIDER_UNAVAILABLE')
    f.catalog.connections[0]!.enabled = false
    await expect(f.invoke('canvas_update_settings', { ...request, comfyuiConnectionId: 'local' })).rejects.toThrow('CANVAS_SETTINGS_CONNECTION_UNAVAILABLE')
    expect(f.writes()).toBe(0)
  })
  test('Given 多页目录 When 从下一页读取 Then 无遗漏且有界', async () => {
    const f = fixture()
    f.catalog.models.push(...Array.from({ length: 79 }, (_, index) => ({ ...f.catalog.models[0]!, profileId: `model-${index + 2}`, name: '长名称'.repeat(400) })))
    const first = await f.invoke('canvas_get_settings', { canvasId: 'canvas-1', limit: 50 })
    const details = first.details as { models: { items: unknown[]; nextOffset: number; total: number } }
    expect(details.models.total).toBe(80)
    expect(details.models.nextOffset).toBeGreaterThan(0)
    expect(details.models.nextOffset).toBeLessThan(50)
    expect(JSON.stringify(details.models).length).toBeLessThan(13_000)
    const second = await f.invoke('canvas_get_settings', { canvasId: 'canvas-1', limit: 50, offset: details.models.nextOffset })
    expect((second.details as { models: { items: Array<{ profileId: string }> } }).models.items[0]!.profileId).toBe(`model-${details.models.nextOffset + 1}`)
  })
  test('Given 工具原始参数越界 When 执行 Then schema拒绝空变更和额外敏感字段', async () => {
    const f = fixture()
    await expect(f.invoke('canvas_get_settings', { canvasId: 'canvas-1', limit: 999 })).rejects.toThrow('CANVAS_SETTINGS_INPUT_INVALID')
    await expect(f.invoke('canvas_update_settings', { ...request, apiKey: 'secret' })).rejects.toThrow('CANVAS_SETTINGS_INPUT_INVALID')
    await expect(f.invoke('canvas_update_settings', { canvasId: 'canvas-1', baseRevision: 0, settingsIntent: 'explicit' })).rejects.toThrow('CANVAS_SETTINGS_EMPTY_UPDATE')
    expect(f.writes()).toBe(0)
  })
  test('Given 空selected范围 When 显式更新 Then 保留空集合而非放宽到全部模型', async () => {
    const f = fixture()
    await f.invoke('canvas_update_settings', { ...request, mediaModelScope: { mode: 'selected', modelIds: [] } })
    expect(f.document().mediaModelScope).toEqual({ mode: 'selected', modelIds: [] })
  })
  for (const reason of ['revoke', 'readonly', 'abort'] as const) {
    test(`Given 事务等待期间 ${reason} When 获取写锁 Then 实时回调拒绝提交`, async () => {
      const f = fixture()
      const controller = new AbortController()
      const execute = f.dependencies.batch.execute
      f.dependencies.batch.execute = async (input, assertAuthorized) => {
        await Promise.resolve()
        if (reason === 'revoke') f.revoke()
        if (reason === 'readonly') f.readOnly()
        if (reason === 'abort') controller.abort()
        assertAuthorized!()
        return execute(input)
      }
      await expect(f.invoke('canvas_update_settings', request, controller.signal)).rejects.toThrow()
      expect(f.writes()).toBe(0)
    })
  }
  for (const reason of ['revoke', 'readonly', 'abort'] as const) {
    test(`Given 异步目录期间 ${reason} When 返回 Then 不写入`, async () => {
      const f = fixture()
      const controller = new AbortController()
      f.dependencies.catalog = async () => { if (reason === 'revoke') f.revoke(); if (reason === 'readonly') f.readOnly(); if (reason === 'abort') controller.abort(); return f.catalog }
      await expect(f.invoke('canvas_update_settings', request, controller.signal)).rejects.toThrow()
      expect(f.writes()).toBe(0)
    })
  }
})
