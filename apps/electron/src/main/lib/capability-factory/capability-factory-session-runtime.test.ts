import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilitySceneDefinition } from '@proma/shared'
import { CapabilityFactoryStore } from './capability-factory-store'
import { CapabilityFactoryService } from './capability-factory-service'
import { createCapabilityFactorySessionRuntime } from './capability-factory-session-runtime'

/** 每个集成用例使用独立真实目录，验证跨实例读取而不是共享内存。 */
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 构造只允许改提示词的基线定义，便于验证完整对比与采纳门槛。 */
function definition(prompt: string): CapabilitySceneDefinition {
  return {
    name: '回答测试',
    description: '',
    inputs: [{ name: 'text', type: 'string' }],
    outputs: [{ name: 'answer', from: { stepId: 'answer' }, shape: 'text' }],
    steps: [{ id: 'answer', title: '回答', type: 'llm', modelSlot: 'main', prompt }],
    capabilities: [],
    modelSlots: [{ id: 'main', model: 'test-model' }],
    acceptance: { criteria: ['回答符合要求'], judgePrompt: '核对回答是否符合要求', metrics: [] },
    stepAcceptances: {
      answer: { criteria: ['回答符合要求'], judgePrompt: '核对回答是否符合要求', metrics: [] },
    },
  }
}

/** 创建真实服务、场景和两条任务；模型端口仍使用离线 stub。 */
function fixture(options: {
  signal?: AbortSignal
  onModelCall?: (stepId: string) => void
  assertCurrent?: () => void
} = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'proma-factory-session-runtime-'))
  roots.push(rootDir)
  let tick = 100
  let sequence = 0
  let resolutionCalls = 0
  const service = new CapabilityFactoryService({
    store: new CapabilityFactoryStore(rootDir),
    now: () => (tick += 1),
    createId: () => `service-${++sequence}`,
  })
  const scene = service.createScene('回答测试')
  service.saveDraft(scene.id, definition('基线回答'), 'human', '建立基线')
  service.adoptDraft(scene.id)
  const firstTask = service.saveTask(scene.id, { text: '第一条' })
  const secondTask = service.saveTask(scene.id, { text: '第二条' })

  const runtime = createCapabilityFactorySessionRuntime({
    rootDir,
    sessionId: 'session-1',
    scopeId: 'session-1:run-1',
    service,
    assertCurrent: options.assertCurrent ?? (() => undefined),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    getRunPorts: () => ({
      resolveModels: (sceneDefinition) => {
        resolutionCalls += 1
        return {
          bindings: sceneDefinition.modelSlots.map((slot) => ({
            slotId: slot.id,
            declaredModel: slot.model,
            channelId: 'channel-1',
            channelName: '离线测试渠道',
            modelId: 'test-model',
            substituted: false,
          })),
        }
      },
      callModel: async (invocation) => {
        options.onModelCall?.(invocation.stepId)
        if (invocation.stepId !== '__factory_review__') {
          return {
            text: invocation.prompt.includes('候选回答') ? '候选结果' : '基线结果',
            model: 'test-model',
          }
        }
        const candidate = invocation.prompt.includes('候选结果')
        return {
          text: JSON.stringify({
            passed: candidate,
            summary: candidate ? '候选满足要求' : '基线未满足要求',
            criteria: [{
              criterion: '回答符合要求',
              passed: candidate,
              evidence: candidate ? '候选结果符合要求' : '基线结果不符合要求',
            }],
            metrics: [],
            suggestions: candidate ? [] : ['调整提示词'],
          }),
          model: 'test-model',
        }
      },
    }),
  })
  return {
    rootDir,
    service,
    runtime,
    sceneId: scene.id,
    taskIds: [firstTask.id, secondTask.id],
    resolutionCalls: () => resolutionCalls,
  }
}

describe('能力工厂会话运行层集成', () => {
  test('Given 真实运行与评审 When 完成对比 Then 可跨 runtime 重读并按原快照核对采纳', async () => {
    const setup = fixture()
    const current = setup.service.getScene(setup.sceneId)
    if (!current) throw new Error('缺少测试场景')
    const drafted = setup.service.saveDraft(setup.sceneId, definition('候选回答'), 'agent', '优化提示词')

    const batch = await setup.runtime.runBatch({
      sceneId: setup.sceneId,
      kind: 'comparison',
      taskIds: setup.taskIds,
      expectedVersion: current.currentVersion,
      expectedDraftCreatedAt: drafted.draft?.createdAt,
      expectedDraftDefinition: drafted.draft?.definition,
    })

    expect(batch.status).toBe('succeeded')
    expect(batch.adoptable).toBe(true)
    expect(batch.items.every((item) => item.baselineRunId && item.candidateRunId)).toBe(true)
    expect(setup.resolutionCalls()).toBe(1)

    const reopenedService = new CapabilityFactoryService({ store: new CapabilityFactoryStore(setup.rootDir) })
    const reopened = createCapabilityFactorySessionRuntime({
      rootDir: setup.rootDir,
      sessionId: 'session-2',
      service: reopenedService,
      assertCurrent: () => undefined,
      getRunPorts: () => { throw new Error('只读重开不应初始化模型端口') },
    }).batches()
    expect(reopened.get(setup.sceneId, batch.id)?.items).toHaveLength(2)
    expect(reopened.assertAdoptable(setup.sceneId, batch.id).id).toBe(batch.id)

    const latest = reopenedService.getScene(setup.sceneId)
    if (!latest?.draft) throw new Error('缺少候选草案')
    reopenedService.saveDraft(setup.sceneId, definition('另一份候选回答'), 'agent', '覆盖候选', {
      currentVersion: latest.currentVersion,
      draft: { createdAt: latest.draft.createdAt, definition: latest.draft.definition },
    })
    expect(() => reopened.assertAdoptable(setup.sceneId, batch.id)).toThrow('候选草案已变化')
  })

  test('Given 模型调用期间取消 When 批次停止 Then 真实运行证据可重读且后续任务不启动', async () => {
    const controller = new AbortController()
    let calls = 0
    const setup = fixture({
      signal: controller.signal,
      onModelCall: (stepId) => {
        if (stepId === '__factory_review__') return
        calls += 1
        controller.abort(new DOMException('用户停止', 'AbortError'))
      },
    })
    const dataset = setup.service.createDataset('取消测试')
    setup.service.addCase(dataset.id, { text: '第一条' })
    setup.service.addCase(dataset.id, { text: '第二条' })

    const batch = await setup.runtime.runBatch({
      sceneId: setup.sceneId,
      kind: 'evaluation',
      datasetId: dataset.id,
    })

    expect(calls).toBe(1)
    expect(batch.status).toBe('cancelled')
    expect(batch.items.map((item) => item.status)).toEqual(['failed', 'cancelled'])
    const completedRunId = batch.items[0]?.runId
    expect(completedRunId).toBeDefined()
    const persisted = completedRunId ? setup.service.getRun(setup.sceneId, completedRunId) : null
    expect(persisted).toMatchObject({ status: 'cancelled', sceneId: setup.sceneId })
    expect(persisted?.steps).toHaveLength(1)

    const reopened = createCapabilityFactorySessionRuntime({
      rootDir: setup.rootDir,
      sessionId: 'session-after-cancel',
      service: new CapabilityFactoryService({ store: new CapabilityFactoryStore(setup.rootDir) }),
      assertCurrent: () => undefined,
      getRunPorts: () => { throw new Error('只读重开不应初始化模型端口') },
    }).batches()
    expect(reopened.get(setup.sceneId, batch.id)?.items[0]?.runId).toBe(completedRunId)
  })

  test('Given 模型返回后会话归属失效 When 批次收尾 Then 不写迟到终态与运行记录', async () => {
    let current = true
    const setup = fixture({
      assertCurrent: () => {
        if (!current) throw new Error('会话归属已失效')
      },
      onModelCall: (stepId) => {
        if (stepId !== '__factory_review__') current = false
      },
    })
    const dataset = setup.service.createDataset('归属失效测试')
    setup.service.addCase(dataset.id, { text: '第一条' })

    await expect(setup.runtime.runBatch({
      sceneId: setup.sceneId,
      kind: 'evaluation',
      datasetId: dataset.id,
    })).rejects.toThrow('会话归属已失效')

    current = true
    const persisted = setup.runtime.batches().list(setup.sceneId)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.status).toBe('interrupted')
    expect(setup.service.listRuns(setup.sceneId)).toEqual([])
  })
})
