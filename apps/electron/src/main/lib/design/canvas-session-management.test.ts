import { describe, expect, test } from 'bun:test'
import type { CanvasSessionMeta } from '@proma/shared'
import { createCanvasOperationSerializer } from './canvas-document-ipc'
import { createCanvasSessionManagement, type CanvasSessionManagementDependencies } from './canvas-session-management'

/** 创建共享生命周期服务，并记录副作用顺序；guardHook 模拟准入后权限变化。 */
function fixture(guardHook: () => void = () => undefined, overrides: Partial<CanvasSessionManagementDependencies> = {}) {
  /** 可公开返回的画布元数据。 */
  const session: CanvasSessionMeta = { id: 'canvas-1', projectId: 'project-1', title: '画布', archived: false, createdAt: 1, updatedAt: 1 }
  /** 记录持久化、清理与广播执行顺序。 */
  const calls: string[] = []
  /** 可在 guard 内动态变化的只读原因。 */
  let reason: string | undefined
  /** 可模拟运行中任务的拒绝开关。 */
  let busy = false
  /** UI 和 Agent 复用同一个服务实例。 */
  const service = createCanvasSessionManagement({
    guard: { runWorkspaceWrite: (_projectId, effect) => { guardHook(); return effect() } },
    getProjectReadOnlyReason: () => reason,
    sessions: {
      update: (input) => { calls.push('update'); return { ...session, ...input } },
      delete: () => { calls.push('delete'); return session },
    },
    assertCanvasIdle: () => { if (busy) throw new Error('BUSY'); calls.push('idle') },
    cleanupBindings: () => { calls.push('bindings') },
    cleanupInternalSessions: async () => { calls.push('sessions') },
    broadcast: (event) => { calls.push(event.cause) },
    ...overrides,
  })
  return { service, calls, setReason: (value: string) => { reason = value }, setBusy: () => { busy = true } }
}

describe('共享 Canvas 生命周期', () => {
  test('Given 已归档画布 When 恢复 Then 只更新元数据且不清理关联', () => {
    /** 当前测试服务。 */
    const state = fixture()
    expect(state.service.update({ projectId: 'project-1', canvasId: 'canvas-1', archived: false }).archived).toBe(false)
    expect(state.calls).toEqual(['update', 'updated'])
  })
  test('Given 空闲画布 When 删除 Then 按权威顺序清理并广播', async () => {
    /** 当前测试服务。 */
    const state = fixture()
    await state.service.delete({ projectId: 'project-1', canvasId: 'canvas-1' })
    expect(state.calls).toEqual(['idle', 'delete', 'bindings', 'sessions', 'deleted'])
  })
  test('Given 获锁前撤销授权 When 更新或删除 Then 零副作用', async () => {
    /** 模拟准入后失效的调用权限。 */
    let authorized = true
    /** 写守卫触发撤权。 */
    const state = fixture(() => { authorized = false })
    /** 真正副作用前必须再次读取授权。 */
    const assertAuthorized = () => { if (!authorized) throw new Error('REVOKED') }
    expect(() => state.service.update({ projectId: 'project-1', canvasId: 'canvas-1', title: '新标题' }, assertAuthorized)).toThrow('REVOKED')
    authorized = true
    await expect(state.service.delete({ projectId: 'project-1', canvasId: 'canvas-1' }, assertAuthorized)).rejects.toThrow('REVOKED')
    expect(state.calls).toEqual([])
  })
  test('Given 写守卫内项目转为只读 When 更新或删除 Then 零副作用', async () => {
    /** guard 延迟到服务创建后读取测试状态。 */
    const state = fixture(() => state.setReason('BECAME_READ_ONLY'))
    expect(() => state.service.update({ projectId: 'project-1', canvasId: 'canvas-1', title: '新标题' })).toThrow('BECAME_READ_ONLY')
    await expect(state.service.delete({ projectId: 'project-1', canvasId: 'canvas-1' })).rejects.toThrow('BECAME_READ_ONLY')
    expect(state.calls).toEqual([])
  })
  test('Given 运行中任务或只读项目 When 删除 Then 不删除任何数据', async () => {
    /** 当前测试服务。 */
    const state = fixture()
    state.setBusy()
    await expect(state.service.delete({ projectId: 'project-1', canvasId: 'canvas-1' })).rejects.toThrow('BUSY')
    state.setReason('READ_ONLY')
    await expect(state.service.delete({ projectId: 'project-1', canvasId: 'canvas-1' })).rejects.toThrow('READ_ONLY')
    expect(state.calls).toEqual([])
  })
})


describe('整张 Canvas 删除与写事务串行', () => {
  test('Given 同画布写事务占用队列 When 删除排队后取消授权 Then 等待原事务且零删除', async () => {
    /** 使用生产同款 serializer，不能仅模拟回调顺序。 */
    const serializer = createCanvasOperationSerializer()
    /** 当前画布唯一身份。 */
    const target = { projectId: 'project-1', canvasId: 'canvas-1' }
    /** 控制占用中的事务何时提交。 */
    const held = Promise.withResolvers<void>()
    /** 确认首个事务已获锁。 */
    const entered = Promise.withResolvers<void>()
    /** 排队期间可被取消的宿主授权。 */
    let authorized = true
    /** 原写事务一直持锁至显式释放。 */
    const writer = serializer.run(target, async () => { entered.resolve(); await held.promise })
    await entered.promise
    /** 删除共享同一个 serializer。 */
    const state = fixture(() => undefined, { runExclusive: (canvas, effect) => serializer.run(canvas, effect) })
    /** 保留删除结果以检验获锁后的失败。 */
    const deletion = state.service.delete(target, () => { if (!authorized) throw new Error('CANCELLED') })
    await Promise.resolve()
    expect(state.calls).toEqual([])
    authorized = false
    held.resolve()
    await writer
    await expect(deletion).rejects.toThrow('CANCELLED')
    expect(state.calls).toEqual([])
  })

  test('Given 异步空闲检查尚未完成 When 调用方被撤权 Then 检查完成后重新授权且零删除', async () => {
    /** 异步媒体与编排状态读取屏障。 */
    const idle = Promise.withResolvers<void>()
    /** 确认已经进入空闲状态检查。 */
    const entered = Promise.withResolvers<void>()
    /** 可动态失效的授权。 */
    let authorized = true
    /** 返回 Promise 的真实业务检查必须被等待。 */
    const state = fixture(() => undefined, { assertCanvasIdle: async () => { entered.resolve(); await idle.promise } })
    /** 排队中的删除请求。 */
    const deletion = state.service.delete({ projectId: 'project-1', canvasId: 'canvas-1' }, () => {
      if (!authorized) throw new Error('REVOKED')
    })
    await entered.promise
    expect(state.calls).toEqual([])
    authorized = false
    idle.resolve()
    await expect(deletion).rejects.toThrow('REVOKED')
    expect(state.calls).toEqual([])
  })
})

test('Given 异步检查已返回同步复核器 When 返回间隙出现任务或授权失效 Then 零删除且总是释放观察者', async () => {
  /** 记录复查及清理是否执行。 */
  const lifecycle: string[] = []
  /** 最终同步校验才发现的新任务。 */
  let busy = true
  /** 校验返回后可被撤销的权限。 */
  let authorized = true
  /** 精确控制异步检查返回与删除 continuation 间隙。 */
  const state = fixture(() => undefined, {
    assertCanvasIdle: async () => ({
      assertIdle: () => { lifecycle.push('check'); if (busy) throw new Error('NEW_TASK') },
      dispose: () => { lifecycle.push('dispose') },
    }),
  })
  await expect(state.service.delete({ projectId: 'project-1', canvasId: 'canvas-1' })).rejects.toThrow('NEW_TASK')
  expect(state.calls).toEqual([])
  expect(lifecycle).toEqual(['check', 'dispose'])
  busy = false
  /** 第二次请求在 await 让出执行后失效。 */
  const deleting = state.service.delete({ projectId: 'project-1', canvasId: 'canvas-1' }, () => {
    if (!authorized) throw new Error('REVOKED')
  })
  authorized = false
  await expect(deleting).rejects.toThrow('REVOKED')
  expect(state.calls).toEqual([])
  expect(lifecycle).toEqual(['check', 'dispose', 'dispose'])
})
