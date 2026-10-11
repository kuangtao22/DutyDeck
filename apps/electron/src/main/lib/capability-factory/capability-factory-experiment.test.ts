import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmptySceneDefinition } from '@proma/shared'
import type { CapabilityExperimentCreateRequest, CapabilityRun, CapabilityScene } from '@proma/shared'
import { createCapabilityFactoryExperimentService } from './capability-factory-experiment'
import { createCapabilityFactoryBatchRunner } from './capability-factory-batch'
import { writeJsonFileAtomicSecure } from '../safe-file'

/** 离线实验只写临时目录，不连接真实模型。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** 构造真正的批次文件与运行引用，分别控制模型输出和语义评审。 */
function fixture(count = 1) {
  const rootDir = mkdtempSync(join(tmpdir(), 'factory-experiment-'))
  roots.push(rootDir)
  let tick = 1000
  let sequence = 0
  const definition = { ...createEmptySceneDefinition('小说角色'),
    acceptance: { criteria: ['角色正确'], judgePrompt: '检查角色', metrics: [] },
    steps: [{ type: 'llm' as const, id: 'extract', title: '提取', modelSlot: 'main', prompt: '原提示词' }],
  }
  const scene: CapabilityScene = { id: 'scene', definition, currentVersion: 1, createdAt: 1, updatedAt: 1,
    draft: { definition: { ...definition, description: '用户尚未采纳的其他改动' }, source: 'human', note: '保留', createdAt: 2 } }
  const dataset = { id: 'dataset', version: 1, name: '真实标注测试集', updatedAt: 1,
    cases: Array.from({ length: count * 3 }, (_, index) => ({ id: `case-${index}`, name: `${index}`,
      input: { text: `原文 ${index}` }, expected: ['A', 'B'], source: 'human' as const, tags: [] })) }
  const bindings = [{ slotId: 'main', declaredModel: 'm', modelId: 'm', channelId: 'c', channelName: '测试', substituted: false }]
  const runs = new Map<string, CapabilityRun>()
  const service = { getScene: (id: string) => id === scene.id ? structuredClone(scene) : null,
    listDatasets: () => [structuredClone(dataset)], listTasks: () => [],
    getRunsByIds: (_sceneId: string, ids: readonly string[]) => ids.flatMap((id) => runs.has(id) ? [structuredClone(runs.get(id)!)] : []),
  }
  let candidateImproves = true
  let oldGateImproves = true
  let beforeRun: (() => void) | undefined
  let calls = 0
  const options = { rootDir, service, now: () => ++tick, createId: () => `experiment-${++sequence}`,
    resolveModels: () => ({ bindings: structuredClone(bindings) }),
    runBatch: async (context: Parameters<Parameters<typeof createCapabilityFactoryExperimentService>[0]['runBatch']>[0]) => {
      const snapshotScene = { ...scene, definition: context.baselineDefinition,
        draft: { definition: context.candidate.definition, source: 'agent' as const, note: '实验隔离快照', createdAt: context.candidate.createdAt } }
      return createCapabilityFactoryBatchRunner({ rootDir, service: { ...service, getScene: () => structuredClone(snapshotScene) },
        signal: context.signal, assertCurrent: context.assertCurrent, onProgress: context.onProgress,
        run: async (_id, input, runOptions = {}) => {
          beforeRun?.()
          context.assertCurrent()
          calls += 1
          const candidate = runOptions.target === 'draft'
          const passed = candidate || !oldGateImproves
          const run: CapabilityRun = { id: `run-${calls}`, sceneId: scene.id, sceneVersion: scene.currentVersion,
            status: 'succeeded', valid: true, input, outputs: { values: candidate && candidateImproves ? ['A', 'B'] : ['A', 'C'] }, steps: [],
            startedAt: tick++, finishedAt: tick++, modelBindings: structuredClone(bindings),
            definitionTarget: candidate ? 'draft' : 'current',
            definitionSnapshot: candidate ? context.candidate.definition : context.baselineDefinition,
            ...(candidate ? { draftCreatedAt: context.candidate.createdAt } : {}),
            comparisonId: runOptions.comparisonId, comparisonRole: runOptions.comparisonRole,
            review: { status: 'succeeded', passed, summary: '评审', acceptance: definition.acceptance,
              criteria: [{ criterion: '角色正确', passed, evidence: '原文' }], metrics: [], suggestions: [], startedAt: tick, finishedAt: tick } }
          runs.set(run.id, run)
          return run
        },
      }).run(context.request)
    },
  }
  const api = createCapabilityFactoryExperimentService(options)
  const request: CapabilityExperimentCreateRequest = { sceneId: scene.id, expectedVersion: 1, datasetId: dataset.id,
    targetStepId: 'extract', candidatePrompt: '先核对原文，再提取所有角色',
    protocol: { protocolVersion: 'v1', scorerVersion: 1, primaryMetric: 'f1', mode: 'tuple-set', outputPath: 'values', expectedPath: '', tupleFields: [],
      normalization: { trim: true, caseFold: false, arrayOrder: 'ordered' }, requireReview: true },
    assignments: dataset.cases.map((item, index) => ({ caseId: item.id, sourceGroupId: `book-${index}`, labelStatus: 'complete',
      split: index < count ? 'optimization' : index < count * 2 ? 'validation' : 'held-out' })),
    limits: { maxCalls: 500, maxTransportAttempts: 600, durationMs: 60_000 }, heldOutExposure: 'declared-unseen' }
  return { rootDir, scene, dataset, bindings, runs, api, options, request, calls: () => calls,
    improve: (value: boolean) => { candidateImproves = value }, oldGate: (value: boolean) => { oldGateImproves = value },
    before: (callback: () => void) => { beforeRun = callback } }
}

describe('有界工厂实验', () => {
  test('Given 用户已有草案 When 完成三批 Then 只运行60次且同一冻结B通过独立留出', async () => {
    const f = fixture(10)
    const draft = structuredClone(f.scene.draft)
    let record = f.api.create(f.request)
    expect(f.calls()).toBe(0)
    expect(record.status).toBe('prepared')
    record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
    expect(record.status).toBe('optimizing')
    record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision, candidatePrompt: '候选B：逐段核对原文角色' })
    expect(record.stages[1]?.quality?.validationEligible).toBe(true)
    record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
    expect(record.status).toBe('completed')
    expect(record.stages.map((stage) => stage.candidateId)).toEqual(['A', 'B', 'B'])
    expect(record.stages[2]?.quality?.adoptionEligible).toBe(true)
    expect(record.runUnitsReserved).toBe(60)
    expect(record.roundsUsed).toBe(3)
    expect(f.calls()).toBe(60)
    expect(f.scene.draft).toEqual(draft)
    expect(f.api.assertAdoptable('scene', record.id, record.candidates[1]!.definition).id).toBe(record.id)
    await expect(f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })).rejects.toThrow()
  })
  test('Given 验证没有改善 When 请求下一组 Then 拒绝留出且保留已付出证据', async () => {
    const f = fixture()
    let record = f.api.create(f.request)
    record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
    f.improve(false)
    record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
    expect(record.status).toBe('failed')
    expect(record.stages[1]?.quality?.validationEligible).toBe(false)
    expect(f.calls()).toBe(4)
    await expect(f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })).rejects.toThrow()
  })
  test('Given F1改善而旧门槛没有修复项 When 验证 Then 可进入留出但不能认证采纳', async () => {
    const f = fixture()
    f.oldGate(false)
    let record = f.api.create(f.request)
    for (let stage = 0; stage < 3; stage += 1) record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
    expect(record.status).toBe('completed')
    expect(record.stages[1]?.quality?.validationEligible).toBe(true)
    expect(record.stages[2]?.quality?.adoptionEligible).toBe(false)
    expect(() => f.api.assertAdoptable('scene', record.id, record.candidates[0]!.definition)).toThrow()
  })
  test('Given 冻结验证候选 When 试图在留出前再次改写 Then 零追加调用', async () => {
    const f = fixture()
    let record = f.api.create(f.request)
    for (let stage = 0; stage < 2; stage += 1) record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
    await expect(f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision, candidatePrompt: '偷换候选' })).rejects.toThrow()
    expect(f.calls()).toBe(4)
  })
  test('Given 进程退出留下半对 When 新实例读取 Then 中断终态且不能重发', async () => {
    const f = fixture()
    const record = f.api.create(f.request)
    record.running = true
    record.status = 'optimizing'
    record.runUnitsReserved = 2
    writeJsonFileAtomicSecure(join(f.rootDir, 'experiments', `${record.id}.json`), { schemaVersion: 1, experiment: record })
    const reopened = createCapabilityFactoryExperimentService(f.options)
    const interrupted = reopened.get('scene', record.id)!
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted.runUnitsReserved).toBe(2)
    await expect(reopened.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: interrupted.revision })).rejects.toThrow()
    expect(f.calls()).toBe(0)
  })
  test('Given 数据或模型漂移 When 推进 Then 不发起请求并保存停止原因', async () => {
    const f = fixture()
    const record = f.api.create(f.request)
    f.bindings[0]!.modelId = 'changed'
    const stopped = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
    expect(stopped.status).toBe('failed')
    expect(stopped.stopReason).toContain('模型')
    expect(f.calls()).toBe(0)
  })
  test('Given 标签或来源不可靠 When 建立实验 Then 拒绝跨组污染并保留部分标签真实状态', () => {
    const f = fixture()
    f.request.assignments[1]!.sourceGroupId = f.request.assignments[0]!.sourceGroupId
    expect(() => f.api.create(f.request)).toThrow('来源')
  })
  test('Given 查询详情 When 默认读取与显式留出读取 Then 标签默认隐藏并记录暴露', () => {
    const f = fixture()
    const record = f.api.create(f.request)
    const view = f.api.view('scene', record.id)!
    expect(view.samples[1]).not.toHaveProperty('expected')
    expect(view.details?.map((item) => item.caseId)).toEqual(['case-0'])
    expect(f.api.view('scene', record.id, 'held-out')?.heldOutExposure).toBe('exposed')
  })
  test('Given 已取消实验 When 读取和推进 Then 额度与磁盘证据保留', async () => {
    const f = fixture()
    let record = f.api.create(f.request)
    record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
    f.api.cancel('scene', record.id)
    const saved = JSON.parse(readFileSync(join(f.rootDir, 'experiments', `${record.id}.json`), 'utf8'))
    expect(saved.experiment.status).toBe('cancelled')
    expect(saved.experiment.runUnitsReserved).toBe(2)
    await expect(f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: saved.experiment.revision })).rejects.toThrow()
  })
})

test('Given 验证后丢失一侧证据 When 进入留出 Then 不消耗留出预算', async () => {
  const f = fixture()
  let record = f.api.create(f.request)
  for (let stage = 0; stage < 2; stage += 1) record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
  f.runs.delete(record.stages[1]!.pairs[0]!.candidateRunId!)
  record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
  expect(record.status).toBe('failed')
  expect(record.stages).toHaveLength(2)
  expect(f.calls()).toBe(4)
})

test('Given 阶段间进程退出 When 重读已消费实验 Then 中断且不支持恢复', async () => {
  const f = fixture()
  let record = f.api.create(f.request)
  record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
  writeJsonFileAtomicSecure(join(f.rootDir, 'experiments', `${record.id}.json`), { schemaVersion: 1, experiment: { ...record, processId: 'previous-process' } })
  const reopened = createCapabilityFactoryExperimentService(f.options)
  expect(reopened.get('scene', record.id)?.status).toBe('interrupted')
  expect(f.calls()).toBe(2)
})

test('Given 运行期间材料暴露 When 下一次模型调用前复核 Then 立即停止且保留半对', async () => {
  const f = fixture()
  const record = f.api.create(f.request)
  f.before(() => { if (f.calls() === 1) f.api.markExposureForRead({ kind: 'datasets' }) })
  const stopped = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
  expect(stopped.status).toBe('failed')
  expect(stopped.stages[0]?.pairs[0]?.baselineRunId).toBeDefined()
  expect(f.calls()).toBe(1)
})

test('Given 已完成独立留出 When 用户查看结果 Then 记录已见但不撤销已冻结试验的事实', async () => {
  const f = fixture()
  let record = f.api.create(f.request)
  for (let stage = 0; stage < 3; stage += 1) record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
  expect(f.api.view('scene', record.id, 'held-out')?.heldOutExposure).toBe('exposed')
  expect(f.api.assertAdoptable('scene', record.id, record.candidates[0]!.definition).id).toBe(record.id)
})

test('Given 运行列表只返回优化材料 When 继续推进 Then 不污染留出且仅实际读取验证运行时标记暴露', async () => {
  const f = fixture()
  let record = f.api.create(f.request)
  f.api.markExposureForRead({ kind: 'runs', sceneId: 'scene', runIds: [] })
  expect(f.api.get('scene', record.id)?.heldOutExposure).toBe('declared-unseen')
  record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
  /** 已返回的优化运行与不属于当前实验的运行都不构成受保护材料暴露。 */
  const optimizationRunId = record.stages[0]!.pairs[0]!.baselineRunId!
  f.api.markExposureForRead({ kind: 'runs', sceneId: 'scene', runIds: [optimizationRunId, 'unrelated-run'] })
  expect(f.api.get('scene', record.id)?.heldOutExposure).toBe('declared-unseen')
  record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
  expect(record.status).toBe('validating')
  f.api.markExposureForRead({ kind: 'runs', sceneId: 'scene', runIds: [optimizationRunId] })
  expect(f.api.get('scene', record.id)?.heldOutExposure).toBe('declared-unseen')
  /** 返回真实验证输入/输出后保守停止后续留出调用，避免把已见材料继续声称为独立。 */
  const validationRunId = record.stages[1]!.pairs[0]!.candidateRunId!
  f.api.markExposureForRead({ kind: 'runs', sceneId: 'scene', runIds: [validationRunId] })
  record = f.api.get('scene', record.id)!
  expect(record.heldOutExposure).toBe('exposed')
  record = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
  expect(record.status).toBe('failed')
  expect(f.calls()).toBe(4)
})

test('Given 部分标签或无可计算F1 When 创建优化实验 Then 请求前拒绝无效消费', () => {
  const f = fixture()
  f.request.assignments[0]!.labelStatus = 'partial'
  expect(() => f.api.create(f.request)).toThrow('完整')
  f.request.assignments[0]!.labelStatus = 'complete'
  f.request.protocol.mode = 'exact-value'
  expect(() => f.api.create(f.request)).toThrow('F1')
})

test('Given 前次已经查看的留出来源 When 以新实验ID重复声明未见 Then 不得重新认证独立性', async () => {
  const f = fixture()
  const previous = f.api.create(f.request)
  f.api.view('scene', previous.id, 'held-out')
  const next = f.api.create(f.request)
  expect(next.heldOutExposure).toBe('exposed')
  const stopped = await f.api.advance({ sceneId: 'scene', experimentId: next.id, expectedRevision: next.revision })
  expect(stopped.status).toBe('failed')
  expect(f.calls()).toBe(0)
})

test('Given 实验期间虚拟接入变化 When 继续 Then 旧环境不能给候选背书', async () => {
  const f = fixture()
  let environment = 'stub-v1'
  const api = createCapabilityFactoryExperimentService({ ...f.options, environmentFingerprint: () => environment })
  const record = api.create(f.request)
  environment = 'stub-v2'
  const stopped = await api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
  expect(stopped.status).toBe('failed')
  expect(stopped.stopReason).toContain('接入')
  expect(f.calls()).toBe(0)
})

test('Given 阶段中取消 When 模型端口再次启动 Then 不再发送且保留基线证据', async () => {
  const f = fixture()
  const record = f.api.create(f.request)
  f.before(() => { if (f.calls() === 1) f.api.cancel('scene', record.id) })
  const stopped = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
  expect(stopped.status).toBe('cancelled')
  expect(stopped.stages[0]?.quality?.unknown).toBe(1)
  expect(f.calls()).toBe(1)
})

test('Given 已到截止时间 When 继续下一批 Then 保留额度且零追加调用', async () => {
  const f = fixture()
  const record = f.api.create({ ...f.request, limits: { ...f.request.limits, durationMs: 1 } })
  const stopped = await f.api.advance({ sceneId: 'scene', experimentId: record.id, expectedRevision: record.revision })
  expect(stopped.status).toBe('failed')
  expect(stopped.stopReason).toContain('截止')
  expect(f.calls()).toBe(0)
})

test('Given 工作区其他场景已见来源 When 新建实验 Then 同样退役该留出来源', () => {
  const f = fixture()
  const prior = f.api.create(f.request)
  f.api.view('scene', prior.id, 'held-out')
  f.scene.id = 'another-scene'
  const next = f.api.create({ ...f.request, sceneId: f.scene.id })
  expect(next.heldOutExposure).toBe('exposed')
  expect(f.api.list('scene')).toHaveLength(1)
  expect(f.api.list('another-scene')).toHaveLength(1)
})

test('Given 损坏的历史身份 When 列表或来源退休扫描 Then 显式失败而非当作未见', () => {
  const f = fixture()
  const prior = f.api.create(f.request)
  writeJsonFileAtomicSecure(join(f.rootDir, 'experiments', `${prior.id}.json`), { schemaVersion: 1, experiment: { ...prior, workspaceFingerprint: 'invalid' } })
  expect(() => f.api.list('scene')).toThrow('身份')
  expect(() => f.api.create(f.request)).toThrow('身份')
})

test('Given 超大初始标签 When 创建实验 Then 保留计量空间且不写不可读记录', () => {
  const f = fixture()
  f.dataset.cases[0]!.expected = ['A'.repeat(2 * 1024 * 1024), 'B']
  expect(() => f.api.create(f.request)).toThrow('2 MiB')
  expect(f.api.list('scene')).toEqual([])
})
