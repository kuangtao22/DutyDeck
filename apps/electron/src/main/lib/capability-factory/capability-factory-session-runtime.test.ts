import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  onModelCall?: (stepId: string) => void | Promise<void>
  assertCurrent?: () => void
  /** 控制离线评审故障，用真实运行生成可恢复记录。 */
  reviewMalformed?: () => boolean
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
        await options.onModelCall?.(invocation.stepId)
        if (invocation.stepId !== '__factory_review__') {
          return {
            text: invocation.prompt.includes('候选回答') ? '候选结果' : '基线结果',
            model: 'test-model',
          }
        }
        if (options.reviewMalformed?.()) return { text: '非JSON评审响应', model: 'test-model' }
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

test('Given 独立实验候选 When 三阶段走真实参考runner Then 不覆盖草案且批次与运行证据可复核', async () => {
  const setup = fixture()
  const baseline = setup.service.getScene(setup.sceneId)!
  const draft = setup.service.saveDraft(setup.sceneId, { ...baseline.definition, description: '保留未批准改动' }, 'human', '用户草案').draft
  const dataset = setup.service.createDataset('三组标签')
  for (const text of ['来源一', '来源二', '来源三']) setup.service.addCase(dataset.id, { text }, { expected: { answer: '候选结果' }, source: 'human' })
  const cases = setup.service.listDatasets().find((item) => item.id === dataset.id)!.cases
  const experiments = setup.runtime.experiments()
  let record = experiments.create({ sceneId: setup.sceneId, expectedVersion: baseline.currentVersion, datasetId: dataset.id,
    targetStepId: 'answer', candidatePrompt: '候选回答', heldOutExposure: 'declared-unseen',
    protocol: { protocolVersion: 'v1', scorerVersion: 1, primaryMetric: 'business-error-rate', mode: 'exact-value',
      outputPath: 'answer', expectedPath: 'answer', tupleFields: [], normalization: { trim: false, caseFold: false, arrayOrder: 'ordered' }, requireReview: true },
    assignments: cases.map((item, index) => ({ caseId: item.id, sourceGroupId: `book-${index}`, labelStatus: 'complete', split: (['optimization', 'validation', 'held-out'] as const)[index]! })),
    limits: { maxCalls: 20, maxTransportAttempts: 30, durationMs: 60000 },
  })
  for (let phase = 0; phase < 3; phase += 1) record = await setup.runtime.runExperiment({ sceneId: setup.sceneId, experimentId: record.id, expectedRevision: record.revision })
  expect(record.status).toBe('completed')
  expect(record.stages[2]?.quality?.adoptionEligible).toBe(true)
  expect(setup.service.getScene(setup.sceneId)?.draft).toEqual(draft)
  expect(setup.service.listRuns(setup.sceneId)).toHaveLength(6)
  expect(setup.runtime.batches().list(setup.sceneId)).toHaveLength(3)
  expect(experiments.assertAdoptable(setup.sceneId, record.id, record.candidates[0]!.definition).id).toBe(record.id)
  const experimentRunId = record.stages[0]!.pairs[0]!.baselineRunId!
  const diagnosis = setup.runtime.diagnoseRun(setup.sceneId, experimentRunId)
  expect(diagnosis.retryableStepIds).toEqual([])
  expect(diagnosis.nextAction).toContain('冻结实验')
  await expect(setup.runtime.retryReview({ sceneId: setup.sceneId, runId: experimentRunId, expectedSourceFingerprint: diagnosis.sourceFingerprint,
    limits: { maxCalls: 1, maxTransportAttempts: 2, durationMs: 1000 } })).rejects.toThrow('冻结实验')

})

test('Given 实验模型返回时用户取消 When 收尾 Then 保留真实取消轨迹和半对运行引用', async () => {
  const controller = new AbortController()
  const setup = fixture({ signal: controller.signal, onModelCall: (stepId) => {
    if (stepId !== '__factory_review__') controller.abort(new Error('用户取消'))
  } })
  const scene = setup.service.getScene(setup.sceneId)!
  const dataset = setup.service.createDataset('取消实验')
  for (const text of ['一', '二', '三']) setup.service.addCase(dataset.id, { text }, { expected: { answer: '候选结果' }, source: 'human' })
  const cases = setup.service.listDatasets().find((item) => item.id === dataset.id)!.cases
  const record = setup.runtime.experiments().create({ sceneId: scene.id, expectedVersion: scene.currentVersion,
    datasetId: dataset.id, targetStepId: 'answer', candidatePrompt: '候选回答', heldOutExposure: 'declared-unseen',
    protocol: { protocolVersion: 'v1', scorerVersion: 1, primaryMetric: 'business-error-rate', mode: 'exact-value',
      outputPath: 'answer', expectedPath: 'answer', tupleFields: [], normalization: { trim: false, caseFold: false, arrayOrder: 'ordered' }, requireReview: true },
    assignments: cases.map((item, index) => ({ caseId: item.id, sourceGroupId: `book-${index}`, labelStatus: 'complete', split: (['optimization', 'validation', 'held-out'] as const)[index]! })),
    limits: { maxCalls: 20, maxTransportAttempts: 30, durationMs: 60000 },
  })
  const stopped = await setup.runtime.runExperiment({ sceneId: scene.id, experimentId: record.id, expectedRevision: record.revision })
  expect(stopped.status).toBe('cancelled')
  const runId = stopped.stages[0]?.pairs[0]?.baselineRunId
  expect(runId).toBeDefined()
  expect(setup.service.getRun(scene.id, runId!)?.status).toBe('cancelled')
  expect(setup.service.listRuns(scene.id)).toHaveLength(1)
})

test('Given 计划模式 When 读取实验与尝试创建或运行 Then 只读可用且模型调用被拒绝', async () => {
  const setup = fixture()
  const readonly = createCapabilityFactorySessionRuntime({ rootDir: setup.rootDir, sessionId: 'read-only', service: setup.service,
    assertCurrent: () => undefined, canMutate: () => false,
    getRunPorts: () => { throw new Error('计划模式不应初始化模型端口') },
  })
  expect(readonly.experiments().list(setup.sceneId)).toEqual([])
  expect(() => readonly.experiments().markExposureForRead({ kind: 'datasets' })).not.toThrow()
  expect(() => readonly.runner()).toThrow('计划模式')
  await expect(readonly.runBatch({ sceneId: setup.sceneId, kind: 'comparison', taskIds: setup.taskIds })).rejects.toThrow('计划模式')
})


test('Given 原评审解析失败 When runtime定点补评 Then 原运行字节不变且仅增加评审调用', async () => {
  let malformed = true
  const calls: string[] = []
  const setup = fixture({ reviewMalformed: () => malformed, onModelCall: (stepId) => { calls.push(stepId) } })
  const run = await setup.runtime.runner().run(setup.sceneId, { text: '核对已有输出' })
  const original = readFileSync(join(setup.rootDir, 'runs', `${setup.sceneId}.jsonl`), 'utf8')
  const diagnosis = setup.runtime.diagnoseRun(setup.sceneId, run.id)
  expect(diagnosis.retryableStepIds).toEqual(['answer'])
  malformed = false
  const result = await setup.runtime.retryReview({ sceneId: setup.sceneId, runId: run.id, expectedSourceFingerprint: diagnosis.sourceFingerprint,
    limits: { maxCalls: 1, maxTransportAttempts: 2, durationMs: 1000 } })
  expect(result.status).toBe('completed')
  expect(calls).toEqual(['answer', '__factory_review__', '__factory_review__'])
  expect(readFileSync(join(setup.rootDir, 'runs', `${setup.sceneId}.jsonl`), 'utf8')).toBe(original)
  expect(setup.runtime.diagnoseRun(setup.sceneId, run.id).retry?.id).toBe(result.id)
})

test('Given plan或归属撤销 When 诊断与补评 Then 只读不初始化模型且失效归属不可读写', async () => {
  const setup = fixture({ reviewMalformed: () => true })
  const run = await setup.runtime.runner().run(setup.sceneId, { text: '已有输出' })
  let owner = true
  const readonly = createCapabilityFactorySessionRuntime({ rootDir: setup.rootDir, sessionId: 'readonly', service: setup.service,
    assertCurrent: () => { if (!owner) throw new Error('归属撤销') }, canMutate: () => false,
    getRunPorts: () => { throw new Error('只读不能加载模型') },
  })
  const diagnosis = readonly.diagnoseRun(setup.sceneId, run.id)
  expect(diagnosis.retryableStepIds).toEqual(['answer'])
  const request = { sceneId: setup.sceneId, runId: run.id, expectedSourceFingerprint: diagnosis.sourceFingerprint, limits: { maxCalls: 1, maxTransportAttempts: 2, durationMs: 1000 } }
  await expect(readonly.retryReview(request)).rejects.toThrow('计划模式')
  owner = false
  expect(() => readonly.diagnoseRun(setup.sceneId, run.id)).toThrow('归属撤销')
  await expect(readonly.retryReview(request)).rejects.toThrow('归属撤销')
})


test('Given 补评正在等待模型 When 并发批测与用户停止 Then 共用场景锁且取消保留独立报告', async () => {
  const controller = new AbortController()
  let retrying = false
  let notifyStarted!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { notifyStarted = resolve })
  const pending = new Promise<void>((resolve) => { release = resolve })
  const setup = fixture({ signal: controller.signal, reviewMalformed: () => !retrying,
    onModelCall: async (stepId) => {
      if (retrying && stepId === '__factory_review__') { notifyStarted(); await pending }
    },
  })
  const run = await setup.runtime.runner().run(setup.sceneId, { text: '原结果' })
  const diagnosis = setup.runtime.diagnoseRun(setup.sceneId, run.id)
  retrying = true
  const retry = setup.runtime.retryReview({ sceneId: setup.sceneId, runId: run.id, expectedSourceFingerprint: diagnosis.sourceFingerprint,
    limits: { maxCalls: 1, maxTransportAttempts: 2, durationMs: 1000 } })
  await started
  await expect(setup.runtime.runBatch({ sceneId: setup.sceneId, kind: 'evaluation', taskIds: setup.taskIds })).rejects.toThrow('已有批次')
  controller.abort(new Error('用户停止'))
  const result = await retry
  release()
  expect(result.status).toBe('cancelled')
  expect(setup.runtime.diagnoseRun(setup.sceneId, run.id).retry?.status).toBe('cancelled')
  expect(setup.service.getRun(setup.sceneId, run.id)?.status).toBe('succeeded')
})
