import { describe, expect, test } from 'bun:test'
import { PROJECT_KNOWLEDGE_IPC_CHANNELS } from '@proma/shared'
import type { KnowledgeSnapshot } from '@proma/shared'
import { parseKnowledgeSearchInput, registerProjectKnowledgeIpc } from './project-knowledge-ipc'

/** 无 Electron 的 IPC 替身，用真实分派验证窗口与参数边界。 */
function fixture() {
  /** 捕获的通道处理器。 */
  const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => Promise<unknown>>()
  /** 服务实际收到的操作，便于确认坏输入没有引发副作用。 */
  const calls: string[] = []
  /** 可在请求中途改变的窗口与工作区授权。 */
  const access = { authorized: true, exists: true, writable: true }
  /** 首次尚未扫描的真实公开状态形态。 */
  const snapshot: KnowledgeSnapshot = {
    projectId: 'workspace-1', initialized: false, revision: 0, entries: [], totalEntries: 0,
    scan: { status: 'idle', discovered: 0, indexed: 0, skipped: 0, changed: 0 },
    maintenance: { enabled: false, dailyJobLimit: 20, generation: 0 }, pendingTurns: 0,
  }
  /** 支持模拟异步请求返回前的撤权。 */
  let beforeReturn = (): void => undefined
  /** 注册使用依赖注入的真实知识库 IPC。 */
  const registration = registerProjectKnowledgeIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
    isAuthorizedSender: () => access.authorized,
    assertProject: () => { if (!access.exists) throw new Error('项目不存在') },
    assertWritable: () => { if (!access.writable) throw new Error('项目正在迁移') },
    service: {
      getSnapshot: async () => { calls.push('snapshot'); beforeReturn(); return snapshot },
      startScan: async () => { calls.push('scan'); return snapshot },
      cancelScan: async () => { calls.push('cancel'); return snapshot },
      search: async (input) => { calls.push(`search:${input.workspaceId}`); return { revision: 0, items: [], total: 0, indexStatus: 'missing' } },
      read: async () => { calls.push('read'); throw new Error('未登记来源') },
      updateMaintenance: async () => { calls.push('maintenance'); return snapshot },
      retryMaintenance: async () => { calls.push('retry'); return snapshot },
      reviewEntry: async () => { calls.push('review'); return snapshot },
      organize: async () => { calls.push('organize'); return snapshot },
      undo: async () => { calls.push('undo'); return snapshot },
      excludeSession: async () => { calls.push('exclude'); return snapshot },
      previewMemory: async () => ({ projectId: 'workspace-1', inspected: 0, truncated: false, proposals: [] }),
      confirmPlan: async (input) => { calls.push(`confirm:${input.groups.map((group) => `${group.id}=${group.title}`).join(',')}`); return snapshot },
      pauseWorkflow: async (input) => { calls.push(`pause:${input.paused}`); return snapshot },
    },
  })
  /** 在发起窗口内调用真实 handler。 */
  const invoke = (channel: string, input: unknown): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error('通道未注册')
    return handler({ sender: { id: 1 } }, input)
  }
  return { invoke, access, calls, handlers, registration, setBeforeReturn: (callback: () => void) => { beforeReturn = callback } }
}

describe('项目知识库 IPC 边界', () => {
  test('Given 非法维护设置 When 保存 Then 不调用写端口', async () => {
    const context = fixture()
    for (const input of [
      { workspaceId: 'workspace-1', enabled: 'yes', dailyJobLimit: 1 },
      { workspaceId: 'workspace-1', enabled: true, dailyJobLimit: 0 },
      { workspaceId: 'workspace-1', enabled: true, dailyJobLimit: 10, path: '/tmp' },
    ]) await expect(context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.MAINTENANCE, input)).rejects.toThrow()
    expect(context.calls).toEqual([])
  })
  test('Given 维护与整理动作 When 项目正在迁移 Then 全部拒绝写入', async () => {
    const context = fixture()
    context.access.writable = false
    for (const channel of [PROJECT_KNOWLEDGE_IPC_CHANNELS.ORGANIZE, PROJECT_KNOWLEDGE_IPC_CHANNELS.RETRY]) {
      await expect(context.invoke(channel, { workspaceId: 'workspace-1' })).rejects.toThrow('迁移')
    }
    expect(context.calls).toEqual([])
  })

  test('Given 用户只选择部分分组并改名 When 确认计划 Then 原样提交可见版本和选择结果', async () => {
    const context = fixture()
    await context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.CONFIRM_PLAN, {
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      expectedRevision: 3,
      groups: [{ id: 'group-a', title: '产品规则' }],
    })
    expect(context.calls).toEqual(['confirm:group-a=产品规则'])
  })

  test('Given 确认计划包含未知字段、旧版本或非法分组 When 提交 Then 写端口保持零调用', async () => {
    const context = fixture()
    for (const input of [
      { workspaceId: 'workspace-1', planId: 'plan-1', expectedRevision: 0, groups: [{ id: 'group-a', title: '产品规则' }] },
      { workspaceId: 'workspace-1', planId: 'plan-1', expectedRevision: 3, groups: [] },
      { workspaceId: 'workspace-1', planId: 'plan-1', expectedRevision: 3, groups: [{ id: 'group-a', title: '' }] },
      { workspaceId: 'workspace-1', planId: 'plan-1', expectedRevision: 3, groups: [{ id: 'group-a', title: '产品规则', sources: [] }] },
      { workspaceId: 'workspace-1', planId: 'plan-1', expectedRevision: 3, groups: [{ id: 'group-a', title: '产品规则' }], confirmedAt: 1 },
    ]) {
      await expect(context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.CONFIRM_PLAN, input)).rejects.toThrow()
    }
    expect(context.calls).toEqual([])
  })

  test('Given 用户暂停或继续 When 写入工作流状态 Then 只接受布尔值并经过写守卫', async () => {
    const context = fixture()
    await context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.PAUSE_WORKFLOW, { workspaceId: 'workspace-1', paused: true })
    expect(context.calls).toEqual(['pause:true'])

    context.access.writable = false
    await expect(context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.PAUSE_WORKFLOW, { workspaceId: 'workspace-1', paused: false })).rejects.toThrow('迁移')
    await expect(context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.PAUSE_WORKFLOW, { workspaceId: 'workspace-1', paused: 'false' })).rejects.toThrow()
    await expect(context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.PAUSE_WORKFLOW, { workspaceId: 'workspace-1', paused: true, generation: 1 })).rejects.toThrow()
    expect(context.calls).toEqual(['pause:true'])
  })
  test('Given 非应用窗口 When 请求扫描 Then 在调用服务前拒绝', async () => {
    const context = fixture()
    context.access.authorized = false
    await expect(context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.SCAN, { workspaceId: 'workspace-1' })).rejects.toThrow('无权')
    expect(context.calls).toEqual([])
  })

  test('Given 非法路径或参数 When 检索 Then 不触发服务', async () => {
    const context = fixture()
    for (const input of [
      { workspaceId: '../other', query: '' },
      { workspaceId: 'workspace-1', query: '', limit: -1 },
      { workspaceId: 'workspace-1', query: '', offset: 0.5 },
      { workspaceId: 'workspace-1', query: '', category: '   ' },
      { workspaceId: 'workspace-1', query: '', path: '/etc/passwd' },
      { workspaceId: 'workspace-1', query: 'x'.repeat(2001) },
    ]) {
      await expect(context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.SEARCH, input)).rejects.toThrow()
    }
    expect(context.calls).toEqual([])
  })

  test('Given 正常项目 When 只读搜索 Then 不启动扫描', async () => {
    const context = fixture()
    await context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.SEARCH, { workspaceId: 'workspace-1', query: '登录' })
    expect(context.calls).toEqual(['search:workspace-1'])
  })

  test('Given 知识或来源范围 When IPC 解析 Then 保留范围且拒绝未知值', () => {
    for (const scope of ['knowledge', 'sources', 'all'] as const) {
      expect(parseKnowledgeSearchInput({ workspaceId: 'workspace-1', query: '', scope }).scope).toBe(scope)
    }
    expect(() => parseKnowledgeSearchInput({ workspaceId: 'workspace-1', query: '', scope: 'system' })).toThrow()
  })

  test('Given 内部检索限定来源类型 When IPC 解析 Then 保留合法类型且拒绝未知值', () => {
    expect(parseKnowledgeSearchInput({
      workspaceId: 'workspace-1', query: '偏好', scope: 'sources', sourceKind: 'memory-file',
    }).sourceKind).toBe('memory-file')
    expect(() => parseKnowledgeSearchInput({
      workspaceId: 'workspace-1', query: '偏好', sourceKind: 'filesystem',
    })).toThrow('知识来源类型无效')
  })

  test('Given 自由知识分类 When IPC 解析 Then 接受有界名称并拒绝空白或过长值', () => {
    expect(parseKnowledgeSearchInput({ workspaceId: 'workspace-1', query: '', category: '客户成功案例' }).category).toBe('客户成功案例')
    expect(() => parseKnowledgeSearchInput({ workspaceId: 'workspace-1', query: '', category: '   ' })).toThrow('知识分类无效')
    expect(() => parseKnowledgeSearchInput({ workspaceId: 'workspace-1', query: '', category: 'x'.repeat(201) })).toThrow('知识分类无效')
  })

  test('Given 项目正在迁移 When 扫描 Then 写守卫阻止副作用', async () => {
    const context = fixture()
    context.access.writable = false
    await expect(context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.SCAN, { workspaceId: 'workspace-1' })).rejects.toThrow('正在迁移')
    expect(context.calls).toEqual([])
  })

  test('Given 请求开始后窗口撤权 When 返回结果 Then 丢弃迟到内容', async () => {
    const context = fixture()
    context.setBeforeReturn(() => { context.access.authorized = false })
    await expect(context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.SNAPSHOT, { workspaceId: 'workspace-1' })).rejects.toThrow('无权')
  })

  test('Given 读取完成前项目被删除 When 返回 Then 不泄露已取内容', async () => {
    const context = fixture()
    context.setBeforeReturn(() => { context.access.exists = false })
    await expect(context.invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.SNAPSHOT, { workspaceId: 'workspace-1' })).rejects.toThrow('不存在')
  })

  test('Given 已注册服务 When 释放 Then 清理全部知识通道', () => {
    const context = fixture()
    expect(context.handlers.size).toBe(Object.keys(PROJECT_KNOWLEDGE_IPC_CHANNELS).length)
    context.registration.dispose()
    expect(context.handlers.size).toBe(0)
  })
})
