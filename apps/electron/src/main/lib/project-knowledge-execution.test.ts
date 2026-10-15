import { describe, expect, test } from 'bun:test'
import type { KnowledgeExecution, KnowledgeWorkflow } from '@proma/shared'
import { createKnowledgeExecutionController, knowledgeExecutionPrompt } from './project-knowledge-execution'

/** 隔离任务时钟和持久工作流，验证实际状态机而非模型文本。 */
function fixture() {
  let clock = 1000
  let workflow: KnowledgeWorkflow = {
    paused: false,
    approved: { id: 'plan', revision: 1, title: '项目', rootRelativePath: 'knowledge', groups: [], createdAt: 0 },
    outline: { revision: 1, planRevision: 1, relativePath: '索引.md', items: [
      { id: 'first', groupId: 'g', title: '规则', relativePath: 'a.md', summary: '规则', sections: [], status: 'pending' },
      { id: 'second', groupId: 'g', title: '权益', relativePath: 'b.md', summary: '权益', sections: [], status: 'pending' },
    ] },
  }
  const dispatched: string[] = []
  /** 记录被宿主精确撤回的排队消息。 */
  const cancelled: string[] = []
  const eligible = new Set<string>()
  let aborted = 0
  const controller = createKnowledgeExecutionController({
    now: () => clock,
    read: () => workflow,
    update: async (_workspaceId, mutate) => { workflow = mutate(workflow); return workflow },
    assertSession: () => undefined,
    enqueue: async (_sessionId, prompt) => { dispatched.push(prompt) },
    cancel: async (_sessionId, dispatchId) => { cancelled.push(dispatchId) },
    eligibleItemIds: async () => eligible,
    changed: () => undefined,
  })
  return {
    controller, dispatched, eligible, cancelled,
    get execution(): KnowledgeExecution { return workflow.execution! },
    get aborted() { return aborted },
    advance: (ms: number) => { clock += ms },
    ready: () => { for (const item of workflow.outline!.items) item.status = 'ready' },
    claim: () => controller.claim('workspace', 'session', dispatched.at(-1)!, 1, () => { aborted += 1 }),
  }
}

describe('知识任务有界执行', () => {
  test('Given 排队消息被取消 When 重启同一范围 Then 能重新派发且旧取消不能影响新任务', async () => {
    const f = fixture()
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    const oldDispatch = f.execution.dispatchId
    await f.controller.discard('workspace', 'session', oldDispatch, 'queue_cancelled')
    expect(f.execution.status).toBe('interrupted')
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    await f.controller.discard('workspace', 'session', oldDispatch, 'dispatch_failed')
    expect(f.execution.status).toBe('queued')
    expect(f.dispatched).toHaveLength(2)
    await f.controller.pause('workspace')
    expect(f.cancelled).toEqual([f.execution.dispatchId])
  })
  test('Given 上轮已经读完一个范围 When 新轮拆成重叠小页 Then 不冒充新进展', async () => {
    const f = fixture()
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    const first = (await f.claim())!
    await first.onProgress({ kind: 'read', entryId: 'source', revision: 'v1', offset: 0, endOffset: 100 })
    await first.finish({})
    const second = (await f.claim())!
    await second.onProgress({ kind: 'read', entryId: 'source', revision: 'v1', offset: 10, endOffset: 80 })
    await second.finish({})
    expect(f.execution.reason).toBe('no_progress')
    expect(f.dispatched).toHaveLength(2)
  })
  test('Given 同一来源版本已自动恢复 When 续接再次恢复 Then 拒绝而新版本可以恢复', async () => {
    const f = fixture()
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    const first = (await f.claim())!
    await first.beforeSourceRecovery('source', 'v1')
    await first.onProgress({ kind: 'read', entryId: 'source', revision: 'v1', offset: 0, endOffset: 100 })
    await first.finish({})
    const second = (await f.claim())!
    await expect(second.beforeSourceRecovery('source', 'v1')).rejects.toThrow('恢复一次')
    await second.beforeSourceRecovery('source', 'v2')
    await second.finish({})
  })
  test('Given 相同正文已经两次失败 When 自动续接再次提交 Then 拒绝重复但允许修订输入', async () => {
    const f = fixture()
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    const run = (await f.claim())!
    run.assertDocumentAttempt('same')
    await run.onDocumentRejected('same')
    run.assertDocumentAttempt('same')
    await run.onDocumentRejected('same')
    expect(() => run.assertDocumentAttempt('same')).toThrow('两次')
    expect(() => run.assertDocumentAttempt('revised')).not.toThrow()
    await run.finish({})
  })
  test('Given 同一用户重复启动 When 任务已排队 Then 不重复调用模型', async () => {
    const f = fixture()
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    expect(f.dispatched).toHaveLength(1)
    expect(f.execution.status).toBe('queued')
  })
  test('Given 新页后续接 When 下一轮重复读取同页 Then 阻塞而非无限续接', async () => {
    const f = fixture()
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    const first = (await f.claim())!
    await first.onProgress({ kind: 'read', entryId: 'source', revision: 'v1', offset: 0, endOffset: 100 })
    await first.finish({})
    expect(f.dispatched).toHaveLength(2)
    const second = (await f.claim())!
    await second.onProgress({ kind: 'read', entryId: 'source', revision: 'v1', offset: 0, endOffset: 100 })
    await second.finish({})
    expect(f.execution.reason).toBe('no_progress')
    expect(f.dispatched).toHaveLength(2)
  })
  test('Given 持续新证据 When 三轮用尽 Then 预算阻塞且额度不隐式重置', async () => {
    const f = fixture()
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    for (let index = 0; index < 3; index += 1) {
      const run = (await f.claim())!
      await run.onBudget({ calls: 12, bytes: 96000 })
      await run.onProgress({ kind: 'read', entryId: 'source', revision: 'v1', offset: index * 100, endOffset: index * 100 + 100 })
      await run.finish({})
    }
    expect(f.execution.status).toBe('blocked')
    expect(f.execution.reason).toBe('budget_exhausted')
    expect(f.execution.calls).toBe(36)
    expect(f.dispatched).toHaveLength(3)
  })
  test('Given 暂停后又开始新一段 When 旧回执到达 Then 不修改新运行也不取消新运行', async () => {
    const f = fixture()
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    const old = (await f.claim())!
    await f.controller.pause('workspace')
    expect(f.aborted).toBe(1)
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    await old.finish({ stopped: true })
    expect(f.execution.status).toBe('queued')
    expect(f.aborted).toBe(1)
  })
  test('Given ready正文但未达准入 When 回合结束 Then 不能显示全部完成', async () => {
    const f = fixture()
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    const run = (await f.claim())!
    f.ready()
    await run.finish({})
    expect(f.execution.status).toBe('blocked')
    expect(f.execution.reason).toBe('no_progress')
  })
  test('Given 全部正文达标 When 正常结束 Then finished', async () => {
    const f = fixture()
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    const run = (await f.claim())!
    f.ready(); f.eligible.add('first'); f.eligible.add('second')
    await run.finish({})
    expect(f.execution.status).toBe('finished')
  })
  test('Given 重启恢复 When 遗留排队或运行记录 Then 只标中断不重新发送', async () => {
    const f = fixture()
    await f.controller.start({ workspaceId: 'workspace', sessionId: 'session', planRevision: 1 })
    await f.controller.recover('workspace')
    expect(f.execution.status).toBe('interrupted')
    expect(f.dispatched).toHaveLength(1)
    expect(await f.controller.claim('workspace', 'session', knowledgeExecutionPrompt(f.execution), 2, () => undefined)).toBeUndefined()
  })
})
