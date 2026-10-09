import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEmptySceneDefinition } from '@proma/shared'
import type {
  CapabilityDataset,
  CapabilityFactoryBatchRunOptions,
  CapabilityRun,
  CapabilitySavedTask,
  CapabilityScene,
} from '@proma/shared'
import { createCapabilityFactoryBatchRunner } from './capability-factory-batch'

/** 每个用例使用独立目录，验证真实文件恢复而不是内存模拟。 */
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建只有提示词变化的候选场景，满足优化对比前置条件。 */
function createScene(): CapabilityScene {
  const definition = {
    ...createEmptySceneDefinition('测试场景'),
    acceptance: { criteria: ['包含证据'], judgePrompt: '核对证据', metrics: [] },
    steps: [{ type: 'llm' as const, id: 'answer', title: '回答', modelSlot: 'main', prompt: '回答问题' }],
  }
  return {
    id: 'scene-1', definition, currentVersion: 2, createdAt: 1, updatedAt: 2,
    draft: { definition: { ...definition, steps: [{ ...definition.steps[0]!, prompt: '先引用证据，再回答问题' }] },
      source: 'agent', note: '补齐证据', createdAt: 3 },
  }
}

/** 构造最小服务端口与真实运行历史，批次只能通过 runId 读取证据。 */
function createFixture() {
  const rootDir = mkdtempSync(join(tmpdir(), 'proma-capability-batch-'))
  roots.push(rootDir)
  let scene = createScene()
  const runs = new Map<string, CapabilityRun>()
  const tasks: CapabilitySavedTask[] = [1, 2].map((index) => ({
    id: `task-${index}`, sceneId: scene.id, input: { text: `输入 ${index}` }, createdAt: index, updatedAt: index,
  }))
  const dataset: CapabilityDataset = {
    id: 'dataset-1', name: '回归集', version: 4, updatedAt: 4,
    cases: tasks.map((task, index) => ({ id: `case-${index + 1}`, name: `用例 ${index + 1}`, input: task.input, source: 'human', tags: [] })),
  }
  let sequence = 0
  let getRunCalls = 0
  let getRunsByIdsCalls = 0
  const service = {
    getScene: (sceneId: string) => sceneId === scene.id ? structuredClone(scene) : null,
    listTasks: () => structuredClone(tasks),
    listDatasets: () => [structuredClone(dataset)],
    getRun: (_sceneId: string, runId: string) => {
      getRunCalls += 1
      return structuredClone(runs.get(runId) ?? null)
    },
    getRunsByIds: (_sceneId: string, runIds: readonly string[]) => {
      getRunsByIdsCalls += 1
      return runIds.flatMap((runId) => {
        const record = runs.get(runId)
        return record ? [structuredClone(record)] : []
      })
    },
  }
  /** 候选明确修复判据，基线明确失败，形成可采纳证据。 */
  const run = async (
    _sceneId: string,
    input: Record<string, unknown>,
    options: CapabilityFactoryBatchRunOptions = {},
  ): Promise<CapabilityRun> => {
    sequence += 1
    const candidate = options.target === 'draft'
    const id = `run-${sequence}`
    const record: CapabilityRun = {
      id, sceneId: scene.id, sceneVersion: scene.currentVersion, status: 'succeeded', valid: true,
      input, outputs: {}, steps: [], startedAt: sequence, finishedAt: sequence,
      definitionTarget: candidate ? 'draft' : 'current',
      definitionSnapshot: candidate ? structuredClone(scene.draft!.definition) : structuredClone(scene.definition),
      ...(candidate ? { draftCreatedAt: scene.draft!.createdAt } : {}),
      ...(typeof options.comparisonId === 'string' ? { comparisonId: options.comparisonId } : {}),
      ...(options.comparisonRole === 'baseline' || options.comparisonRole === 'candidate'
        ? { comparisonRole: options.comparisonRole } : {}),
      modelBindings: [{ slotId: 'main', declaredModel: 'test', channelId: 'channel', channelName: '测试', modelId: 'test', substituted: false }],
      review: {
        status: 'succeeded', passed: candidate, summary: candidate ? '已修复' : '缺少证据',
        acceptance: structuredClone(scene.definition.acceptance),
        criteria: [{ criterion: '包含证据', passed: candidate, evidence: candidate ? '有' : '无' }],
        metrics: [], suggestions: [], startedAt: sequence, finishedAt: sequence,
      },
    }
    runs.set(id, record)
    return structuredClone(record)
  }
  return {
    rootDir, service, run, runs, tasks, dataset,
    getScene: () => scene,
    setScene: (next: CapabilityScene) => { scene = next },
    getCallCount: () => sequence,
    getRunCalls: () => getRunCalls,
    getRunsByIdsCalls: () => getRunsByIdsCalls,
    resetReadCalls: () => { getRunCalls = 0; getRunsByIdsCalls = 0 },
  }
}

describe('能力工厂持久批次', () => {
  test('Given 两条冻结任务 When 完成对比 Then 逐条持久化运行索引且重开可采纳', async () => {
    const fixture = createFixture()
    const progress: number[] = []
    const runner = createCapabilityFactoryBatchRunner({
      service: fixture.service, rootDir: fixture.rootDir, run: fixture.run, scopeId: 'session:run',
      createId: (() => { let index = 0; return () => `id-${++index}` })(), now: (() => { let time = 10; return () => ++time })(),
      onProgress: (batch) => { progress.push(batch.items.filter((item) => item.status === 'succeeded').length) },
    })
    const scene = fixture.getScene()
    const batch = await runner.run({
      sceneId: scene.id, kind: 'comparison', taskIds: fixture.tasks.map((task) => task.id),
      expectedVersion: scene.currentVersion, expectedDraftCreatedAt: scene.draft!.createdAt,
      expectedDraftDefinition: scene.draft!.definition,
    })

    expect(batch.status).toBe('succeeded')
    expect(batch.scopeId).toBe('session:run')
    expect(batch.items.every((item) => item.baselineRunId && item.candidateRunId)).toBe(true)
    expect(batch.adoptable).toBe(true)
    expect(batch.comparison).toMatchObject({ comparable: 2, candidatePassed: 2, regressed: [], unknown: [] })
    expect(progress).toContain(1)
    expect(fixture.getCallCount()).toBe(4)

    const reopened = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: fixture.rootDir, run: fixture.run })
    expect(reopened.list(scene.id)[0]).not.toHaveProperty('items')
    expect(reopened.get(scene.id, batch.id)?.items[0]?.input).toEqual({ text: '输入 1' })
    expect(reopened.assertAdoptable(scene.id, batch.id).id).toBe(batch.id)
    const stored = readFileSync(join(fixture.rootDir, 'batches', scene.id, `${batch.id}.json`), 'utf8')
    expect(stored).not.toContain('"outputs": {}')
  })

  test('Given 十组对比证据 When 采纳复核 Then 单阶段只批读一次且不逐条读取', async () => {
    const fixture = createFixture()
    for (let index = 3; index <= 10; index += 1) {
      fixture.tasks.push({
        id: `task-${index}`, sceneId: 'scene-1', input: { text: `输入 ${index}` },
        createdAt: index, updatedAt: index,
      })
    }
    const runner = createCapabilityFactoryBatchRunner({
      service: fixture.service, rootDir: fixture.rootDir, run: fixture.run,
      createId: (() => { let index = 0; return () => `id-${++index}` })(),
    })
    const batch = await runner.run({
      sceneId: 'scene-1', kind: 'comparison', taskIds: fixture.tasks.map((task) => task.id),
    })
    expect(batch.adoptable).toBe(true)

    fixture.resetReadCalls()
    expect(runner.assertAdoptable('scene-1', batch.id).id).toBe(batch.id)
    expect(fixture.getRunsByIdsCalls()).toBe(1)
    expect(fixture.getRunCalls()).toBe(0)
  })

  test('Given 数据集 When 运行 evaluation Then 逐条执行并形成质量汇总', async () => {
    const fixture = createFixture()
    const runner = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: fixture.rootDir, run: fixture.run })
    const batch = await runner.run({ sceneId: 'scene-1', kind: 'evaluation', datasetId: fixture.dataset.id })
    expect(batch.status).toBe('succeeded')
    expect(batch.snapshot).toMatchObject({ datasetId: fixture.dataset.id, datasetVersion: 4, itemIds: ['case-1', 'case-2'] })
    expect(batch.evaluation).toEqual({ total: 2, completed: 2, valid: 2, reviewed: 2, passedReview: 0 })
    expect(batch.items.map((item) => item.runId)).toEqual(['run-1', 'run-2'])
  })

  test('Given 数据集超过十条 When 选择两条用例 Then 只冻结并执行所选输入', async () => {
    const fixture = createFixture()
    const cases = Array.from({ length: 12 }, (_, index) => ({
      id: `large-case-${index + 1}`, name: `大数据集用例 ${index + 1}`, input: { index }, source: 'human' as const, tags: [],
    }))
    fixture.service.listDatasets = () => [{ ...fixture.dataset, cases }]
    const runner = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: fixture.rootDir, run: fixture.run })
    const batch = await runner.run({
      sceneId: 'scene-1', kind: 'evaluation', datasetId: fixture.dataset.id,
      caseIds: ['large-case-7', 'large-case-2'],
    })
    expect(batch.snapshot.itemIds).toEqual(['large-case-7', 'large-case-2'])
    expect(batch.items.map((item) => item.input)).toEqual([{ index: 6 }, { index: 1 }])
    expect(fixture.getCallCount()).toBe(2)
  })

  test('Given 用例选择重复、不存在或超过十条 When 启动 Then 模型调用前拒绝', async () => {
    const fixture = createFixture()
    const cases = Array.from({ length: 12 }, (_, index) => ({
      id: `large-case-${index + 1}`, name: `大数据集用例 ${index + 1}`, input: { index }, source: 'human' as const, tags: [],
    }))
    fixture.service.listDatasets = () => [{ ...fixture.dataset, cases }]
    const runner = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: fixture.rootDir, run: fixture.run })
    await expect(runner.run({ sceneId: 'scene-1', kind: 'evaluation', datasetId: fixture.dataset.id, caseIds: [] }))
      .rejects.toThrow('至少选择')
    await expect(runner.run({ sceneId: 'scene-1', kind: 'evaluation', datasetId: fixture.dataset.id,
      caseIds: ['large-case-1', 'large-case-1'] })).rejects.toThrow('重复')
    await expect(runner.run({ sceneId: 'scene-1', kind: 'evaluation', datasetId: fixture.dataset.id,
      caseIds: ['missing-case'] })).rejects.toThrow('不存在')
    await expect(runner.run({ sceneId: 'scene-1', kind: 'evaluation', datasetId: fixture.dataset.id,
      caseIds: cases.slice(0, 11).map((item) => item.id) })).rejects.toThrow('1–10')
    await expect(runner.run({ sceneId: 'scene-1', kind: 'evaluation', caseIds: ['large-case-1'] }))
      .rejects.toThrow('数据集')
    expect(fixture.getCallCount()).toBe(0)
  })

  test('Given 已停止的信号 When 当前项完成 Then 保留结果并取消后续项', async () => {
    const fixture = createFixture()
    const controller = new AbortController()
    const runner = createCapabilityFactoryBatchRunner({
      service: fixture.service, rootDir: fixture.rootDir, signal: controller.signal,
      run: async (...args) => {
        const result = await fixture.run(...args)
        controller.abort()
        return result
      },
    })
    const batch = await runner.run({ sceneId: 'scene-1', kind: 'evaluation', datasetId: fixture.dataset.id })
    expect(batch.status).toBe('cancelled')
    expect(batch.items.map((item) => item.status)).toEqual(['succeeded', 'cancelled'])
    expect(batch.items[0]?.runId).toBe('run-1')
    expect(fixture.getCallCount()).toBe(1)
  })

  test('Given 场景版本在批次中变化 When 准备下一项 Then 停止且不混合版本', async () => {
    const fixture = createFixture()
    const runner = createCapabilityFactoryBatchRunner({
      service: fixture.service, rootDir: fixture.rootDir,
      run: async (...args) => {
        const result = await fixture.run(...args)
        fixture.setScene({ ...fixture.getScene(), currentVersion: 3 })
        return result
      },
    })
    const batch = await runner.run({ sceneId: 'scene-1', kind: 'evaluation', datasetId: fixture.dataset.id })
    expect(batch.status).toBe('failed')
    expect(batch.error).toContain('版本')
    expect(fixture.getCallCount()).toBe(1)
  })

  test('Given 超过十项或非法选择 When 启动 Then 模型调用前拒绝', async () => {
    const fixture = createFixture()
    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      id: `task-${index}`, sceneId: 'scene-1', input: { index }, createdAt: index, updatedAt: index,
    }))
    fixture.service.listTasks = () => tooMany
    const runner = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: fixture.rootDir, run: fixture.run })
    await expect(runner.run({ sceneId: 'scene-1', kind: 'comparison', taskIds: tooMany.map((task) => task.id) }))
      .rejects.toThrow('1–10')
    await expect(runner.run({ sceneId: '../scene', kind: 'evaluation', datasetId: fixture.dataset.id }))
      .rejects.toThrow('标识')
    expect(fixture.getCallCount()).toBe(0)
  })

  test('Given 旧 running 文件 When 当前进程没有活动执行 Then 只读投影为 interrupted', () => {
    const fixture = createFixture()
    const directory = join(fixture.rootDir, 'batches', 'scene-1')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'old-batch.json'), JSON.stringify({
      schemaVersion: 1,
      batch: {
        id: 'old-batch', sceneId: 'scene-1', kind: 'evaluation', status: 'running',
        snapshot: { sceneVersion: 2, itemIds: ['case-1'] },
        items: [{ id: 'case-1', name: '用例', input: {}, status: 'running' }],
        evaluation: { total: 1, completed: 0, valid: 0, reviewed: 0, passedReview: 0 },
        adoptable: false, startedAt: 1, updatedAt: 1, finishedAt: null,
      },
    }))
    const runner = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: fixture.rootDir, run: fixture.run })
    expect(runner.get('scene-1', 'old-batch')?.status).toBe('interrupted')
    expect(JSON.parse(readFileSync(join(directory, 'old-batch.json'), 'utf8')).batch.status).toBe('running')
  })

  test('Given 批次目录被替换为符号链接 When 读写 Then 拒绝越出固定根', async () => {
    const fixture = createFixture()
    const outside = mkdtempSync(join(tmpdir(), 'proma-capability-batch-outside-'))
    roots.push(outside)
    symlinkSync(outside, join(fixture.rootDir, 'batches'))
    const runner = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: fixture.rootDir, run: fixture.run })
    await expect(runner.run({ sceneId: 'scene-1', kind: 'evaluation', datasetId: fixture.dataset.id }))
      .rejects.toThrow('符号链接')
  })

  test('Given 草案或证据运行变化 When 核对采纳 Then 拒绝旧批次背书', async () => {
    const fixture = createFixture()
    const runner = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: fixture.rootDir, run: fixture.run })
    const scene = fixture.getScene()
    const batch = await runner.run({ sceneId: scene.id, kind: 'comparison', taskIds: ['task-1'],
      expectedVersion: 2, expectedDraftCreatedAt: 3, expectedDraftDefinition: scene.draft!.definition })
    fixture.runs.delete(batch.items[0]!.candidateRunId!)
    expect(() => runner.assertAdoptable(scene.id, batch.id)).toThrow('运行证据')
  })

  test('Given 运行结束前归属失效 When 尝试保存进度 Then 不写入越权终态', async () => {
    const fixture = createFixture()
    let checks = 0
    const runner = createCapabilityFactoryBatchRunner({
      service: fixture.service,
      rootDir: fixture.rootDir,
      run: fixture.run,
      assertCurrent: () => {
        checks += 1
        if (checks >= 4) throw new Error('会话归属已失效')
      },
      createId: () => 'ownership-batch',
    })
    await expect(runner.run({ sceneId: 'scene-1', kind: 'evaluation', datasetId: fixture.dataset.id }))
      .rejects.toThrow('会话归属已失效')
    const stored = JSON.parse(readFileSync(
      join(fixture.rootDir, 'batches', 'scene-1', 'ownership-batch.json'),
      'utf8',
    )) as { batch: { status: string; items: Array<{ status: string; runId?: string }> } }
    expect(stored.batch.status).toBe('running')
    expect(stored.batch.items[0]).toEqual(expect.objectContaining({ status: 'running' }))
    expect(stored.batch.items[0]?.runId).toBeUndefined()
  })

  test('Given 同一 scope 已启动三轮对比 When 请求第四轮 Then 模型调用前拒绝', async () => {
    const fixture = createFixture()
    const runner = createCapabilityFactoryBatchRunner({
      service: fixture.service,
      rootDir: fixture.rootDir,
      run: fixture.run,
      scopeId: 'session:run',
    })
    const request = { sceneId: 'scene-1', kind: 'comparison' as const, taskIds: ['task-1'] }
    await runner.run(request)
    await runner.run(request)
    await runner.run(request)
    expect(fixture.getCallCount()).toBe(6)
    await expect(runner.run(request)).rejects.toThrow('最多运行 3 轮')
    expect(fixture.getCallCount()).toBe(6)
  })

  test('Given 另一 runner 读取正在执行的同批次 When 根与场景相同 Then 保持 running 且不同根不串扰', async () => {
    const fixture = createFixture()
    const controller = new AbortController()
    let releaseRun: ((value: CapabilityRun) => void) | undefined
    const blockedRun = (...args: Parameters<typeof fixture.run>): Promise<CapabilityRun> => new Promise((resolve) => {
      void fixture.run(...args).then((result) => { releaseRun = () => resolve(result) })
    })
    const runner = createCapabilityFactoryBatchRunner({
      service: fixture.service,
      rootDir: fixture.rootDir,
      run: blockedRun,
      signal: controller.signal,
      createId: () => 'shared-id',
    })
    const pending = runner.run({ sceneId: 'scene-1', kind: 'evaluation', datasetId: fixture.dataset.id })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const observer = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: fixture.rootDir, run: fixture.run })
    expect(observer.get('scene-1', 'shared-id')?.status).toBe('running')

    const otherRoot = mkdtempSync(join(tmpdir(), 'proma-capability-batch-other-'))
    roots.push(otherRoot)
    const otherDirectory = join(otherRoot, 'batches', 'scene-1')
    mkdirSync(otherDirectory, { recursive: true })
    const activeRecord = readFileSync(join(fixture.rootDir, 'batches', 'scene-1', 'shared-id.json'), 'utf8')
    writeFileSync(join(otherDirectory, 'shared-id.json'), activeRecord)
    const otherObserver = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: otherRoot, run: fixture.run })
    expect(otherObserver.get('scene-1', 'shared-id')?.status).toBe('interrupted')
    controller.abort()
    releaseRun?.(fixture.runs.get('run-1')!)
    await pending
  })

  test('Given 批次目录不存在 When 只读列表 Then 返回空且不创建目录', () => {
    const fixture = createFixture()
    const runner = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: fixture.rootDir, run: fixture.run })
    expect(runner.list('scene-1')).toEqual([])
    expect(existsSync(join(fixture.rootDir, 'batches'))).toBe(false)
  })

  test('Given 批次由上一回合创建 When 新 scope 读取 Then 历史证据仍可见', async () => {
    const fixture = createFixture()
    const first = createCapabilityFactoryBatchRunner({
      service: fixture.service, rootDir: fixture.rootDir, run: fixture.run, scopeId: 'session:run-1',
    })
    const batch = await first.run({ sceneId: 'scene-1', kind: 'evaluation', datasetId: fixture.dataset.id })
    const next = createCapabilityFactoryBatchRunner({
      service: fixture.service, rootDir: fixture.rootDir, run: fixture.run, scopeId: 'session:run-2',
    })
    expect(next.get('scene-1', batch.id)?.id).toBe(batch.id)
    expect(next.list('scene-1').map((item) => item.id)).toContain(batch.id)
  })

  test('Given 超过一百条历史 When 列表 Then 只读取最近更新的一百条', () => {
    const fixture = createFixture()
    const directory = join(fixture.rootDir, 'batches', 'scene-1')
    mkdirSync(directory, { recursive: true })
    for (let index = 0; index < 101; index += 1) {
      const id = `batch-${String(index).padStart(3, '0')}`
      const filePath = join(directory, `${id}.json`)
      writeFileSync(filePath, JSON.stringify({
        schemaVersion: 1,
        batch: {
          id, sceneId: 'scene-1', kind: 'evaluation', status: 'succeeded',
          snapshot: { sceneVersion: 2, itemIds: [] }, items: [],
          evaluation: { total: 0, completed: 0, valid: 0, reviewed: 0, passedReview: 0 },
          adoptable: false, startedAt: index, updatedAt: index, finishedAt: index,
        },
      }))
      utimesSync(filePath, index + 1, index + 1)
    }
    const runner = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: fixture.rootDir, run: fixture.run })
    const ids = runner.list('scene-1').map((item) => item.id)
    expect(ids).toHaveLength(100)
    expect(ids).toContain('batch-100')
    expect(ids).not.toContain('batch-000')
  })

  test('Given 运行ID存在但身份或快照被替换 When 核对采纳 Then 拒绝错配证据', async () => {
    const fixture = createFixture()
    const runner = createCapabilityFactoryBatchRunner({ service: fixture.service, rootDir: fixture.rootDir, run: fixture.run })
    const scene = fixture.getScene()
    const batch = await runner.run({ sceneId: scene.id, kind: 'comparison', taskIds: ['task-1'],
      expectedVersion: 2, expectedDraftCreatedAt: 3, expectedDraftDefinition: scene.draft!.definition })
    const item = batch.items[0]!
    const candidate = fixture.runs.get(item.candidateRunId!)!
    fixture.runs.set(candidate.id, { ...candidate, input: { text: '其它输入' } })
    expect(() => runner.assertAdoptable(scene.id, batch.id)).toThrow('身份')
    fixture.runs.set(candidate.id, { ...candidate, sceneVersion: 9 })
    expect(() => runner.assertAdoptable(scene.id, batch.id)).toThrow('身份')
    fixture.runs.set(candidate.id, { ...candidate, definitionSnapshot: scene.definition })
    expect(() => runner.assertAdoptable(scene.id, batch.id)).toThrow('身份')
  })
})
