import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInteractionDesignAccess } from './access'
import type { InteractionDesignAccessDependencies } from './access'
import { InteractionDesignService } from './store'
import { registerInteractionDesignIpc } from './ipc'
import type { InteractionDesignIpcEvent } from './ipc'

/** 各用例使用独立项目目录，结束后移除测试数据。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** 返回可模拟撤权、目录切换和窗口关闭的真实文件服务环境。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prototype-access-')); roots.push(root)
  const state = { projectRoot: root, workspaceId: 'project-1', writable: true, alive: true, leases: 0, changes: 0 }
  const dependencies: InteractionDesignAccessDependencies = {
    resolveSession: () => ({ projectRoot: state.projectRoot, workspaceId: state.workspaceId }),
    assertCaller: () => { if (!state.alive) throw new Error('调用者已关闭') },
    canWrite: () => state.writable,
    acquireWriteLease: () => { state.leases += 1; return () => { state.leases -= 1 } },
    createService: (context) => new InteractionDesignService(context),
    onChanged: () => { state.changes += 1 },
  }
  return { root, state, dependencies, access: createInteractionDesignAccess('session-1', dependencies) }
}

describe('交互设计访问边界', () => {
  test('Given 计划模式 When 列举并尝试创建 Then 读取不建目录且写入被拒绝', async () => {
    const { root, access, state } = fixture(); state.writable = false
    expect(await access.execute('list', { sessionId: 'session-1' })).toEqual([])
    await expect(access.execute('create', { sessionId: 'session-1', name: '测试', platform: 'desktop' })).rejects.toThrow('计划模式')
    expect(existsSync(join(root, '.proma'))).toBe(false)
    expect(state.leases).toBe(0)
  })
  test('Given 固定会话 When 换会话或项目根 Then 不能跨归属读写', async () => {
    const { access, state } = fixture()
    await expect(access.execute('list', { sessionId: 'session-2' })).rejects.toThrow('会话身份')
    state.projectRoot += '-moved'
    await expect(access.execute('list', { sessionId: 'session-1' })).rejects.toThrow('项目归属或目录')
    expect(state.changes).toBe(0)
  })
  test('Given 正常保存 When 命令完成 Then 释放租约并广播一次', async () => {
    const { access, state } = fixture()
    const result = await access.execute('create', { sessionId: 'session-1', name: '测试', platform: 'mobile' })
    expect(result.document.revision).toBe(1)
    expect(state.changes).toBe(1)
    expect(state.leases).toBe(0)
  })
  test('Given 异步准备期间被撤权 When 提交前复核 Then 拒绝且始终释放租约', async () => {
    const { root, dependencies, state } = fixture()
    dependencies.createService = (context) => ({
      async invoke(method, input) {
        await Promise.resolve(); state.writable = false
        context.assertCurrent()
        return new InteractionDesignService(context).invoke(method, input)
      },
    })
    const access = createInteractionDesignAccess('session-1', dependencies)
    await expect(access.execute('create', { sessionId: 'session-1', name: '测试', platform: 'mobile' })).rejects.toThrow('写入权限')
    expect(state.leases).toBe(0)
    expect(state.changes).toBe(0)
    expect(existsSync(join(root, '.proma'))).toBe(false)
  })
  test('Given 读取期间项目改变 When 返回结果 Then 不向旧调用者泄漏结果', async () => {
    const { dependencies, state } = fixture()
    dependencies.createService = (context) => ({
      async invoke(method, input) {
        const result = await new InteractionDesignService(context).invoke(method, input)
        state.workspaceId = 'project-2'
        return result
      },
    })
    await expect(createInteractionDesignAccess('session-1', dependencies).execute('list', { sessionId: 'session-1' })).rejects.toThrow('项目归属')
  })
  test('Given 单工具在异步阶段取消而整轮仍活动 When 提交前检查 Then 不发布且释放租约', async () => {
    const { root, dependencies, state } = fixture()
    const controller = new AbortController()
    dependencies.createService = (context) => ({
      async invoke(method, input) {
        await Promise.resolve(); controller.abort()
        context.assertCurrent()
        return new InteractionDesignService(context).invoke(method, input)
      },
    })
    const access = createInteractionDesignAccess('session-1', dependencies)
    await expect(access.execute('create', { sessionId: 'session-1', name: '测试', platform: 'mobile' }, controller.signal)).rejects.toThrow('工具调用已取消')
    expect(existsSync(join(root, '.proma'))).toBe(false)
    expect(state.leases).toBe(0)
    expect(state.changes).toBe(0)
  })
  test('Given 非应用窗口或非法命令 When 调用 IPC Then 拒绝且正常调用可解除注册', async () => {
    const { access } = fixture()
    let handler: ((event: InteractionDesignIpcEvent, value: unknown) => Promise<unknown>) | undefined
    let removed = false
    const registration = registerInteractionDesignIpc({
      ipc: { handle: (_channel, callback) => { handler = callback }, removeHandler: () => { removed = true } },
      isAuthorizedSender: (event) => event.sender.id === 1,
      createAccess: () => access,
    })
    await expect(handler!({ sender: { id: 2 } }, { method: 'list', input: { sessionId: 'session-1' } })).rejects.toThrow('非法窗口')
    await expect(handler!({ sender: { id: 1 } }, { method: 'removeEverything' })).rejects.toThrow()
    expect(await handler!({ sender: { id: 1 } }, { method: 'list', input: { sessionId: 'session-1' } })).toEqual([])
    registration.dispose(); expect(removed).toBe(true)
  })
})
