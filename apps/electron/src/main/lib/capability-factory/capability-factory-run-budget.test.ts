import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilitySceneDefinition } from '@proma/shared'
import { CapabilityFactoryService } from './capability-factory-service'
import { CapabilityFactoryStore } from './capability-factory-store'
import { createCapabilityFactoryRunner } from './capability-factory-run'
import type { CapabilityFactoryModelInvocation } from './capability-factory-model-call'
import { createCapabilityFactoryCallLedger } from './capability-factory-budget'

/** 每例隔离真实持久目录，结束后仅移除测试自建文件。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 用可重试提取及独立评审复现普通运行的预算缺口。 */
function fixture(options: { malformedFirst?: boolean; delayMs?: number; delayReviewMs?: number; failPersistence?: boolean } = {}) {
  /** 当前fixture有真实服务和独立路径，只有模型传输用离线替身。 */
  const root = mkdtempSync(join(tmpdir(), 'factory-run-budget-'))
  roots.push(root)
  const service = new CapabilityFactoryService({ store: new CapabilityFactoryStore(root) })
  const scene = service.createScene('普通运行预算')
  const definition: CapabilitySceneDefinition = {
    name: '普通运行预算', description: '', inputs: [{ name: 'text', type: 'string' }], capabilities: [],
    modelSlots: [{ id: 'main', model: 'test-model' }],
    outputs: [{ name: 'answer', from: { stepId: 'extract' }, shape: 'structured' }],
    steps: [{ id: 'extract', title: '提取', type: 'extract', modelSlot: 'main', prompt: '{{text}}',
      inputs: { text: { from: 'workflow-input', field: 'text' } }, maxAttempts: 2, strictness: 'strict',
      judgeFields: [{ name: 'answer', type: 'string' }] }],
    acceptance: { criteria: ['答案有据'], judgePrompt: '核对', metrics: [] },
  }
  service.saveDraft(scene.id, definition, 'human', '预算测试')
  service.adoptDraft(scene.id)
  /** 实际进入模拟传输的计数与目的，不把被账本拒绝的调用当作已发送。 */
  const sent: string[] = []
  const callModel = async (invocation: CapabilityFactoryModelInvocation) => {
    /** 替身遵循生产端口的预留→持久化→发送→结算合同。 */
    const ledger = invocation.callLedger
    const reservation = ledger?.reserve({ ...invocation, purpose: invocation.purpose ?? 'execution' })
    if (reservation) {
      expect(service.listRuns(scene.id).some((run) => run.callBudget?.calls.some((call) => call.id === reservation))).toBe(true)
    }
    try {
      if (reservation) ledger!.markSent(reservation, invocation.signal)
      sent.push(invocation.purpose ?? 'execution')
      const delayMs = invocation.purpose === 'review' ? options.delayReviewMs : options.delayMs
      if (delayMs) await new Promise<void>((resolve, reject) => {
        /** 响应延迟可被预算终止信号取消，不留下计时器。 */
        const timer = setTimeout(resolve, delayMs)
        invocation.signal.addEventListener('abort', () => { clearTimeout(timer); reject(invocation.signal.reason) }, { once: true })
      })
      const text = invocation.purpose === 'review'
        ? JSON.stringify({ passed: true, summary: '通过', criteria: [{ criterion: '答案有据', passed: true, evidence: '原文' }], metrics: [], suggestions: [] })
        : options.malformedFirst && sent.length === 1 ? '格式不合法' : '{"answer":"原文"}'
      if (reservation) ledger!.settle(reservation, { status: 'completed', usage: { inputTokens: 10, outputTokens: 5 } })
      return { text, model: 'test-model' }
    } catch (error) {
      if (reservation) ledger!.settle(reservation, { status: invocation.signal.aborted ? 'cancelled' : 'failed' })
      throw error
    }
  }
  if (options.failPersistence) service.recordBudgetedRun = () => { throw new Error('账本写入失败') }
  const runner = createCapabilityFactoryRunner({ service, callModel,
    resolveModels: () => ({ bindings: [{ slotId: 'main', declaredModel: 'test-model', modelId: 'test-model', channelId: 'test-channel', channelName: '测试', substituted: false }] }),
  })
  return { service, runner, sceneId: scene.id, sent, root }
}

describe('普通工厂运行的持久预算', () => {
  test('Given 一次执行加一次评审 When 限额为2 Then 两次都计量并可重开读取', async () => {
    const setup = fixture()
    const limits = { maxCalls: 2, maxTransportAttempts: 2, deadlineAt: Date.now() + 60000 }
    const run = await setup.runner.run(setup.sceneId, { text: '原文' }, { limits, saveTask: false })
    expect(setup.sent).toEqual(['execution', 'review'])
    expect(run.review?.passed).toBe(true)
    expect(run.callBudget?.calls).toHaveLength(2)
    expect(run.callBudget?.limits).toEqual(limits)
    const reopened = new CapabilityFactoryService({ store: new CapabilityFactoryStore(setup.root) })
    expect(reopened.getRun(setup.sceneId, run.id)?.callBudget).toEqual(run.callBudget)
    expect(reopened.listRuns(setup.sceneId)).toHaveLength(1)
    expect(() => reopened.recordBudgetedRun(run)).toThrow('运行已结束')
  })

  test('Given 格式错误触发重试 When 两次额度耗尽 Then 保留输出且评审不能越限发送', async () => {
    const setup = fixture({ malformedFirst: true })
    const run = await setup.runner.run(setup.sceneId, { text: '原文' }, {
      limits: { maxCalls: 2, maxTransportAttempts: 2, deadlineAt: Date.now() + 60000 }, saveTask: false,
    })
    expect(setup.sent).toEqual(['execution', 'retry'])
    expect(run.outputs).not.toBeNull()
    expect(run.callBudget?.calls).toHaveLength(2)
    expect(run.review?.passed).toBeNull()
    expect(run.review?.error).toContain('额度')
  })

  test('Given 仅允许一次传输 When 准备评审 Then 独立传输限额阻止第二次发送并保留已用额度', async () => {
    const setup = fixture()
    const run = await setup.runner.run(setup.sceneId, { text: '原文' }, {
      limits: { maxCalls: 3, maxTransportAttempts: 1, deadlineAt: Date.now() + 60000 }, saveTask: false,
    })
    expect(setup.sent).toEqual(['execution'])
    expect(run.callBudget?.calls.filter((call) => call.sent)).toHaveLength(1)
    expect(run.review?.passed).toBeNull()
  })

  test('Given 模型仍未返回 When 到达总截止时间 Then 在途调用取消且不启动评审', async () => {
    const setup = fixture({ delayMs: 2000 })
    const run = await setup.runner.run(setup.sceneId, { text: '原文' }, {
      limits: { maxCalls: 3, maxTransportAttempts: 3, deadlineAt: Date.now() + 60 }, saveTask: false,
    })
    expect(setup.sent).toEqual(['execution'])
    expect(run.status).toBe('cancelled')
    expect(run.callBudget?.calls[0]?.status).toBe('cancelled')
    expect(run.callBudget?.calls[0]?.billing).toBe('unknown')
  })

  test('Given 账本持久化失败 When 尝试预留 Then 没有传输请求', async () => {
    const setup = fixture({ failPersistence: true })
    await expect(setup.runner.run(setup.sceneId, { text: '原文' }, {
      limits: { maxCalls: 3, maxTransportAttempts: 3, deadlineAt: Date.now() + 60000 }, saveTask: false,
    })).rejects.toThrow('账本写入失败')
    expect(setup.sent).toEqual([])
  })

  test('Given 执行完成后评审仍在途 When 总截止时间到达 Then 整条运行标记取消并持久化', async () => {
    const setup = fixture({ delayReviewMs: 2000 })
    const run = await setup.runner.run(setup.sceneId, { text: '原文' }, {
      limits: { maxCalls: 3, maxTransportAttempts: 3, deadlineAt: Date.now() + 60 }, saveTask: false,
    })
    expect(setup.sent).toEqual(['execution', 'review'])
    expect(run.status).toBe('cancelled')
    expect(new CapabilityFactoryService({ store: new CapabilityFactoryStore(setup.root) }).getRun(setup.sceneId, run.id)?.status).toBe('cancelled')
  })

  test('Given 截止时间已经过去 When 开始运行 Then 零发送且保存取消结果', async () => {
    const setup = fixture()
    const run = await setup.runner.run(setup.sceneId, { text: '原文' }, {
      limits: { maxCalls: 3, maxTransportAttempts: 3, deadlineAt: Date.now() - 1 }, saveTask: false,
    })
    expect(run.status).toBe('cancelled')
    expect(run.callBudget?.calls).toEqual([])
    expect(setup.sent).toEqual([])
  })

  test('Given 实验已有共享账本 When 追加单次限额 Then 拒绝替换以免重置预算', async () => {
    const setup = fixture()
    const runner = createCapabilityFactoryRunner({ service: setup.service,
      callLedger: createCapabilityFactoryCallLedger({ maxCalls: 2 }),
      callModel: async () => { throw new Error('不得发送') }, resolveModels: () => ({ bindings: [] }),
    })
    await expect(runner.run(setup.sceneId, { text: '原文' }, {
      limits: { maxCalls: 3, maxTransportAttempts: 3, deadlineAt: Date.now() + 60000 },
    })).rejects.toThrow('不能用单次限额替换')
  })
})
