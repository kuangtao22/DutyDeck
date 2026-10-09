import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionRequest, PromaPermissionMode, CapabilitySceneDefinition } from '@proma/shared'
import {
  AgentPermissionService,
  revalidateSingleApprovalResult,
  type CanUseToolOptions,
  type PermissionResult,
} from '../agent-permission-service'
import { createCapabilityFactoryAgentFacade } from './capability-factory-agent-facade'
import { getCapabilityFactoryMutationPolicy } from './capability-factory-permission-policy'
import { CapabilityFactoryService } from './capability-factory-service'
import { CapabilityFactoryStore } from './capability-factory-store'

/** 为当前定义生成一份可辨认的候选提示词，便于断言草案是否被保留。 */
function withPrompt(definition: CapabilitySceneDefinition, prompt: string): CapabilitySceneDefinition {
  return {
    ...definition,
    steps: [{ type: 'llm', id: 'answer', title: '生成回答', modelSlot: 'main', prompt }],
    outputs: [{ name: 'answer', from: { stepId: 'answer' }, shape: 'text' }],
  }
}

/** 创建隔离的真实持久层、服务与 facade，并允许测试动态切换权限模式。 */
function fixture() {
  let mode: PromaPermissionMode = 'bypassPermissions'
  const service = new CapabilityFactoryService({
    store: new CapabilityFactoryStore(mkdtempSync(join(tmpdir(), 'factory-permission-'))),
  })
  const scene = service.createScene('客服回复')
  service.saveDraft(scene.id, withPrompt(scene.definition, '候选提示词一'), 'agent', '自动优化候选')
  const facade = createCapabilityFactoryAgentFacade({
    service,
    canMutate: () => mode !== 'plan',
  })
  return {
    service,
    sceneId: scene.id,
    facade,
    getMode: () => mode,
    setMode: (nextMode: PromaPermissionMode) => { mode = nextMode },
  }
}

/** 构造 SDK 权限回调需要的调用身份与中止信号。 */
function permissionOptions(signal: AbortSignal, toolUseID: string): CanUseToolOptions {
  return { signal, toolUseID, displayName: '采纳提示词优化', description: '将候选提示词设为当前版本' }
}

/** 准备一次真实采纳操作，并确认宿主策略要求逐次审核。 */
function prepareAdoption(factory: ReturnType<typeof fixture>) {
  const prepared = factory.facade.prepareOperation({ kind: 'adoptDraft', sceneId: factory.sceneId })
  if ('reason' in prepared) throw new Error(prepared.reason)
  const approval = factory.facade.approval('factory_apply_operation', { preparedId: prepared.preparedId })
  if (!approval) throw new Error('应取得宿主签发的采纳快照')
  expect(getCapabilityFactoryMutationPolicy(factory.getMode(), approval)).toBe('ask')
  return { preparedId: prepared.preparedId, approval }
}

/** 发起不可白名单化的真实单次审批，并暴露请求与 Promise 供竞态测试控制。 */
function requestAdoption(
  permissions: AgentPermissionService,
  prepared: ReturnType<typeof prepareAdoption>,
  controller: AbortController,
  requestNumber: number,
) {
  let request: PermissionRequest | undefined
  const input = { preparedId: prepared.preparedId, approval: prepared.approval }
  const pending = permissions.requestSingleApproval(
    'factory-session',
    'factory_apply_operation',
    input,
    permissionOptions(controller.signal, `adopt-${requestNumber}`),
    (nextRequest) => { request = nextRequest },
  )
  if (!request) throw new Error('应同步产生采纳审核请求')
  return { pending, request }
}

/** 按 orchestrator 的顺序复核审批结果；只有最终允许时才执行 facade 操作。 */
async function applyAfterReview(
  factory: ReturnType<typeof fixture>,
  preparedId: string,
  permission: Promise<PermissionResult>,
  staleDenial: PermissionResult | undefined = undefined,
) {
  const checked = revalidateSingleApprovalResult(
    await permission,
    () => staleDenial,
    factory.getMode,
  )
  if (checked.behavior !== 'allow') return { permission: checked, operation: null }
  return { permission: checked, operation: await factory.facade.applyOperation(preparedId) }
}

describe('编排工厂采纳权限集成', () => {
  test('Given 完全自动模式 When Agent 请求采纳 Then 必须挂起审核且版本不推进', async () => {
    const factory = fixture()
    const prepared = prepareAdoption(factory)
    const permissions = new AgentPermissionService()
    const requested = requestAdoption(permissions, prepared, new AbortController(), 1)
    let settled = false
    void requested.pending.then(() => { settled = true })
    await Promise.resolve()

    expect(requested.request.allowAlways).toBe(false)
    expect(settled).toBe(false)
    expect(factory.service.getScene(factory.sceneId)).toMatchObject({ currentVersion: 1 })
    expect(factory.service.getScene(factory.sceneId)?.draft).not.toBeNull()

    permissions.respondToPermission(requested.request.requestId, 'deny', false)
    await requested.pending
  })

  test('Given 用户拒绝采纳 When 宿主收口结果 Then 保留草案与当前版本', async () => {
    const factory = fixture()
    const prepared = prepareAdoption(factory)
    const permissions = new AgentPermissionService()
    const requested = requestAdoption(permissions, prepared, new AbortController(), 1)

    expect(permissions.respondToPermission(requested.request.requestId, 'deny', false)).toBe('factory-session')
    const outcome = await applyAfterReview(factory, prepared.preparedId, requested.pending)

    expect(outcome.permission).toMatchObject({ behavior: 'deny', message: '用户拒绝了此操作' })
    expect(outcome.operation).toBeNull()
    expect(factory.service.getScene(factory.sceneId)).toMatchObject({ currentVersion: 1 })
    expect(factory.service.getScene(factory.sceneId)?.draft?.definition.steps[0]).toMatchObject({ prompt: '候选提示词一' })
  })

  test('Given 用户单次允许 When 审批后状态仍有效 Then 只采纳一次并推进一个版本', async () => {
    const factory = fixture()
    const prepared = prepareAdoption(factory)
    const permissions = new AgentPermissionService()
    const requested = requestAdoption(permissions, prepared, new AbortController(), 1)

    permissions.respondToPermission(requested.request.requestId, 'allow', false)
    const outcome = await applyAfterReview(factory, prepared.preparedId, requested.pending)

    expect(outcome.permission.behavior).toBe('allow')
    expect(outcome.operation).toMatchObject({ applied: true })
    expect(factory.service.getScene(factory.sceneId)).toMatchObject({ currentVersion: 2, draft: null })
    expect(await factory.facade.applyOperation(prepared.preparedId)).toMatchObject({ applied: false })
  })

  test('Given 客户端伪造总是允许 When 下次再次采纳 Then 仍产生新的单次审核', async () => {
    const factory = fixture()
    const permissions = new AgentPermissionService()
    const firstPrepared = prepareAdoption(factory)
    const first = requestAdoption(permissions, firstPrepared, new AbortController(), 1)
    permissions.respondToPermission(first.request.requestId, 'allow', true)
    expect((await applyAfterReview(factory, firstPrepared.preparedId, first.pending)).operation).toMatchObject({ applied: true })

    const current = factory.service.getScene(factory.sceneId)
    if (!current) throw new Error('场景不应消失')
    factory.service.saveDraft(factory.sceneId, withPrompt(current.definition, '候选提示词二'), 'agent', '第二轮优化')
    const secondPrepared = prepareAdoption(factory)
    const second = requestAdoption(permissions, secondPrepared, new AbortController(), 2)

    expect(second.request.requestId).not.toBe(first.request.requestId)
    expect(second.request.allowAlways).toBe(false)
    expect(permissions.getPendingRequestOwner(second.request.requestId)).toBe('factory-session')
    expect(factory.service.getScene(factory.sceneId)).toMatchObject({ currentVersion: 2 })

    permissions.respondToPermission(second.request.requestId, 'deny', true)
    await second.pending
  })

  test('Given 审核等待中工具被中止 When 权限 Promise 收口 Then 草案不能生效', async () => {
    const factory = fixture()
    const prepared = prepareAdoption(factory)
    const permissions = new AgentPermissionService()
    const controller = new AbortController()
    const requested = requestAdoption(permissions, prepared, controller, 1)

    controller.abort()
    const outcome = await applyAfterReview(factory, prepared.preparedId, requested.pending)

    expect(outcome.permission).toMatchObject({ behavior: 'deny', message: '操作已中止' })
    expect(outcome.operation).toBeNull()
    expect(factory.service.getScene(factory.sceneId)).toMatchObject({ currentVersion: 1 })
    expect(factory.service.getScene(factory.sceneId)?.draft).not.toBeNull()
  })

  test('Given 审核期间切到计划模式 When 用户随后允许 Then 最新模式拒绝采纳', async () => {
    const factory = fixture()
    const prepared = prepareAdoption(factory)
    const permissions = new AgentPermissionService()
    const requested = requestAdoption(permissions, prepared, new AbortController(), 1)

    factory.setMode('plan')
    permissions.respondToPermission(requested.request.requestId, 'allow', false)
    const outcome = await applyAfterReview(factory, prepared.preparedId, requested.pending)

    expect(outcome.permission).toMatchObject({ behavior: 'deny', message: '计划模式下不能执行需要逐次批准的工具，请在计划获批后执行。' })
    expect(outcome.operation).toBeNull()
    expect(factory.service.getScene(factory.sceneId)).toMatchObject({ currentVersion: 1 })
    expect(factory.service.getScene(factory.sceneId)?.draft).not.toBeNull()
  })

  test('Given 用户批准后草案快照被替换 When 执行采纳 Then facade CAS 拒绝旧批准', async () => {
    const factory = fixture()
    const prepared = prepareAdoption(factory)
    const permissions = new AgentPermissionService()
    const requested = requestAdoption(permissions, prepared, new AbortController(), 1)
    permissions.respondToPermission(requested.request.requestId, 'allow', false)
    const permission = await requested.pending

    const current = factory.service.getScene(factory.sceneId)
    if (!current) throw new Error('场景不应消失')
    factory.service.saveDraft(factory.sceneId, withPrompt(current.definition, '人工替换的草案'), 'human', '并发修改')
    const outcome = await applyAfterReview(factory, prepared.preparedId, Promise.resolve(permission))

    expect(outcome.permission.behavior).toBe('allow')
    expect(outcome.operation).toEqual({ applied: false, reason: '目标状态已变化，请重新准备操作' })
    expect(factory.service.getScene(factory.sceneId)).toMatchObject({ currentVersion: 1 })
    expect(factory.service.getScene(factory.sceneId)?.draft?.definition.steps[0]).toMatchObject({ prompt: '人工替换的草案' })
  })
})
