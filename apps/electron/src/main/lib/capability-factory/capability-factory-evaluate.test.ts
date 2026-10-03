/**
 * 评测适配器的测试：**只做约束轴**、分数挂在 (场景版本, 数据集版本) 上、
 * 逐条用例的结果能回答"是哪几条没过"，以及"没用例"与"逐条失败不中断"两种边界。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityRun, CapabilityRunReview, CapabilitySceneDefinition } from '@proma/shared'
import { CapabilityFactoryStore } from './capability-factory-store'
import { CapabilityFactoryService } from './capability-factory-service'
import { createCapabilityFactoryEvaluator } from './capability-factory-evaluate'

/** 一份最小可导出的定义（一个 llm 步骤 + 一条判据）。 */
const definition: CapabilitySceneDefinition = {
  name: '小说角色提取',
  description: '',
  inputs: [{ name: 'corpusText', type: 'string' }],
  outputs: [],
  steps: [{ id: 'scan', title: '扫描人物候选', type: 'llm', modelSlot: 'main', prompt: '从 {{corpusText}} 找人物' }],
  capabilities: [],
  modelSlots: [{ id: 'main', model: 'm' }],
  acceptance: { criteria: ['名称必须能在正文里找到'], judgePrompt: '', metrics: [] },
}

/** 造一个「场景已就绪 + 一个数据集」的夹具；run 用替身，按输入决定成败。 */
function fixture(outcomes: (input: Record<string, unknown>) => {
  status: CapabilityRun['status']
  valid: boolean
  error?: string
  review?: CapabilityRunReview
  sceneVersion?: number
  placeholderCapabilities?: string[]
  /** 证据质量独立于 JSON 格式轴，夹具允许注入确定性检查的问题。 */
  evidenceIssues?: string[]
}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'cap-factory-eval-'))
  let tick = 0
  let seq = 0
  const service = new CapabilityFactoryService({
    store: new CapabilityFactoryStore(rootDir),
    now: () => (tick += 1000),
    createId: () => `id-${(seq += 1)}`,
  })
  const scene = service.createScene('小说角色提取')
  service.saveDraft(scene.id, definition, 'human', '最小定义')
  service.adoptDraft(scene.id)

  const runs: CapabilityRun[] = []
  const runOptions: ({ saveTask?: boolean } | undefined)[] = []
  const evaluator = createCapabilityFactoryEvaluator({
    service,
    run: async (sceneId, input, options) => {
      runOptions.push(options)
      const outcome = outcomes(input)
      const run: CapabilityRun = {
        id: `run-${runs.length + 1}`, sceneId,
        sceneVersion: outcome.sceneVersion ?? service.getScene(sceneId)?.currentVersion ?? 1,
        kind: 'full', status: outcome.status, valid: outcome.valid, input, outputs: null,
        steps: outcome.error
          ? [{ stepId: 'scan', title: '扫描人物候选', type: 'llm', status: 'failed', attempts: 1, input, error: outcome.error, startedAt: 0, finishedAt: 1 }]
          : [],
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.review === undefined ? {} : { review: outcome.review }),
        ...(outcome.placeholderCapabilities === undefined
          ? {}
          : { placeholderCapabilities: outcome.placeholderCapabilities }),
        ...(outcome.evidenceIssues === undefined ? {} : { evidenceIssues: outcome.evidenceIssues }),
        startedAt: runs.length * 10, finishedAt: runs.length * 10 + 5,
      }
      runs.push(run)
      return run
    },
    createId: () => `eval-${(seq += 1)}`,
  })
  return { service, evaluator, sceneId: scene.id, runs, runOptions }
}

describe('评测：对一组固定输入跑当前版本', () => {
  test('批量评测明确关闭提交任务保存，避免数据集用例污染任务列表', async () => {
    const { service, evaluator, sceneId, runOptions } = fixture(() => ({ status: 'succeeded', valid: true }))
    const dataset = service.createDataset('批量输入')
    service.addCase(dataset.id, { corpusText: '第 1 段' })
    service.addCase(dataset.id, { corpusText: '第 2 段' })

    await evaluator.evaluate(sceneId, dataset.id)

    expect(runOptions).toEqual([{ saveTask: false }, { saveTask: false }])
  })

  test('Given 3 条用例 2 条合法 When 评测 Then 合规率 2/3 并逐条给出结果', async () => {
    const { service, evaluator, sceneId } = fixture((input) => ({
      status: input['corpusText'] === '坏输入' ? 'failed' : 'succeeded',
      valid: input['corpusText'] !== '坏输入',
      ...(input['corpusText'] === '坏输入' ? { error: '输出不是合法 JSON' } : {}),
    }))
    const dataset = service.createDataset('真实输入集')
    service.addCase(dataset.id, { corpusText: '第 1 段' })
    service.addCase(dataset.id, { corpusText: '坏输入' })
    service.addCase(dataset.id, { corpusText: '第 3 段' })

    const evaluation = await evaluator.evaluate(sceneId, dataset.id)

    expect(evaluation.status).toBe('succeeded')
    expect(evaluation.totalSamples).toBe(3)
    expect(evaluation.validSamples).toBe(2)
    expect(evaluation.constraintCompliance).toBeCloseTo(2 / 3, 5)
    /** 分数必须挂在两个版本上，"这分属于哪一版"才答得上。 */
    expect(evaluation.sceneVersion).toBe(2)
    expect(evaluation.datasetVersion).toBe(4)
    /** 不通过那条要能一眼看出原因。 */
    const failed = evaluation.caseResults?.find((result) => !result.valid)
    expect(failed?.detail).toBe('输出不是合法 JSON')
    /** 质量轴留空：没有评审器就不给分。 */
    expect(evaluation.metrics).toEqual({})
    expect(evaluation.judgeResults).toEqual([])
  })

  test('Given 数据集为空 When 评测 Then 明确失败并说明先固化用例，不返回 0/0 的假分数', async () => {
    const { service, evaluator, sceneId } = fixture(() => ({ status: 'succeeded', valid: true }))
    const dataset = service.createDataset('空的')

    const evaluation = await evaluator.evaluate(sceneId, dataset.id)

    expect(evaluation.status).toBe('failed')
    expect(evaluation.error).toContain('还没有用例')
    expect(evaluation.totalSamples).toBe(0)
  })

  test('Given 某条用例失败 When 评测 Then 不中断整轮，其余用例照常计入', async () => {
    const { service, evaluator } = fixture((input) => ({
      status: input['boom'] === true ? 'failed' : 'succeeded',
      valid: input['boom'] !== true,
    }))
    const scene = service.listScenes()[0]
    const dataset = service.createDataset('含失败')
    service.addCase(dataset.id, { corpusText: '正常' })
    service.addCase(dataset.id, { corpusText: '会炸', boom: true })
    service.addCase(dataset.id, { corpusText: '正常二' })

    const evaluation = await evaluator.evaluate(scene?.id ?? '', dataset.id)

    expect(evaluation.totalSamples).toBe(3)
    expect(evaluation.caseResults).toHaveLength(3)
    expect(evaluation.validSamples).toBe(2)
  })

  test('Given 每次运行都有自动内容评审 When 批量评测 Then 汇总质量结论与逐条判据', async () => {
    const { service, evaluator, sceneId } = fixture((input) => {
      const passed = input['corpusText'] === '好结果'
      return {
        status: 'succeeded',
        valid: true,
        review: {
          status: 'succeeded', passed, summary: passed ? '角色证据完整' : '存在无原文依据的角色',
          acceptance: definition.acceptance,
          criteria: [{
            criterion: '名称必须能在正文里找到', passed,
            evidence: passed ? '名称与原文一致' : '输出包含正文未出现的名称',
          }],
          metrics: [], suggestions: passed ? [] : ['收紧角色名称的原文证据要求'],
          startedAt: 1, finishedAt: 2,
        },
      }
    })
    const dataset = service.createDataset('质量回归集')
    service.addCase(dataset.id, { corpusText: '好结果' })
    service.addCase(dataset.id, { corpusText: '坏结果' })

    const evaluation = await evaluator.evaluate(sceneId, dataset.id)

    expect(evaluation.reviewedSamples).toBe(2)
    expect(evaluation.passedReviewSamples).toBe(1)
    expect(evaluation.judgeResults).toEqual([{
      criterionId: 'criterion-1', criterion: '名称必须能在正文里找到', passed: 1, total: 2,
    }])
    expect(evaluation.caseResults?.[0]?.review?.summary).toBe('角色证据完整')
    expect(evaluation.caseResults?.[1]?.review?.passed).toBe(false)
    /** 指标单位与方向未声明，批量层不能擅自平均。 */
    expect(evaluation.metrics).toEqual({})
  })

  test('Given 一条评审失败且一条缺失 When 汇总 Then 两条都不能算质量通过', async () => {
    const { service, evaluator, sceneId } = fixture((input) => ({
      status: 'succeeded',
      valid: true,
      ...(input['corpusText'] === '评审失败'
        ? {
            review: {
              status: 'failed' as const, passed: null, summary: '', acceptance: definition.acceptance,
              criteria: [], metrics: [], suggestions: [], error: '评审模型不可用',
              startedAt: 1, finishedAt: 2,
            },
          }
        : {}),
    }))
    const dataset = service.createDataset('异常评审集')
    service.addCase(dataset.id, { corpusText: '评审失败' })
    service.addCase(dataset.id, { corpusText: '旧运行无评审' })

    const evaluation = await evaluator.evaluate(sceneId, dataset.id)

    expect(evaluation.reviewedSamples).toBe(0)
    expect(evaluation.passedReviewSamples).toBe(0)
    expect(evaluation.caseResults?.map((item) => item.review?.status ?? 'missing')).toEqual(['failed', 'missing'])
  })

  test('Given 遗留评审错误地保留 passed=true When 运行失败、格式无效或用了占位桩 Then 都不能计为质量通过', async () => {
    const passedReview: CapabilityRunReview = {
      status: 'succeeded', passed: true, summary: '遗留通过结论', acceptance: definition.acceptance,
      criteria: [{ criterion: '名称必须能在正文里找到', passed: true, evidence: '旧证据' }],
      metrics: [], suggestions: [], startedAt: 1, finishedAt: 2,
    }
    const { service, evaluator, sceneId } = fixture((input) => {
      switch (input['corpusText']) {
        case '运行失败': return { status: 'failed', valid: false, review: passedReview }
        case '格式无效': return { status: 'succeeded', valid: false, review: passedReview }
        case '占位桩': return {
          status: 'succeeded', valid: true, review: passedReview,
          placeholderCapabilities: ['account.lookup'],
        }
        default: return { status: 'succeeded', valid: true, review: passedReview }
      }
    })
    const dataset = service.createDataset('质量资格边界')
    service.addCase(dataset.id, { corpusText: '运行失败' })
    service.addCase(dataset.id, { corpusText: '格式无效' })
    service.addCase(dataset.id, { corpusText: '占位桩' })
    service.addCase(dataset.id, { corpusText: '真实通过' })

    const evaluation = await evaluator.evaluate(sceneId, dataset.id)

    expect(evaluation.reviewedSamples).toBe(4)
    expect(evaluation.passedReviewSamples).toBe(1)
    expect(evaluation.caseResults?.map((item) => item.reviewEligible)).toEqual([false, false, false, true])
    expect(evaluation.judgeResults).toEqual([{
      criterionId: 'criterion-1', criterion: '名称必须能在正文里找到', passed: 1, total: 1,
    }])
  })

  test('Given 评测期间场景版本发生变化 When 后续运行返回新版本 Then 整批失败并停止剩余用例', async () => {
    let calls = 0
    const { service, evaluator, sceneId } = fixture(() => {
      calls += 1
      return { status: 'succeeded', valid: true, ...(calls === 2 ? { sceneVersion: 99 } : {}) }
    })
    const dataset = service.createDataset('固定版本集')
    service.addCase(dataset.id, { corpusText: '第一条' })
    service.addCase(dataset.id, { corpusText: '第二条' })
    service.addCase(dataset.id, { corpusText: '第三条' })

    const evaluation = await evaluator.evaluate(sceneId, dataset.id)

    expect(evaluation.status).toBe('failed')
    expect(evaluation.error).toContain('场景版本')
    expect(evaluation.sceneVersion).toBe(2)
    expect(evaluation.caseResults).toHaveLength(1)
    expect(calls).toBe(2)
  })

  test('Given 证据无法回溯但模型评审判通过 When 批量评测 Then 排除质量通过并保留具体原因', async () => {
    /** 故意模拟模型误判通过，质量闸门必须独立于评审结论。 */
    const { service, evaluator, sceneId } = fixture(() => ({
      status: 'succeeded', valid: true, evidenceIssues: ['scan.evidence.selectedText 不属于 c0-p1'],
      review: {
        status: 'succeeded', passed: true, summary: '模型误判通过', acceptance: definition.acceptance,
        criteria: [{ criterion: '名称必须能在正文里找到', passed: true, evidence: '模型误判' }],
        metrics: [], suggestions: [], startedAt: 1, finishedAt: 2,
      },
    }))
    const dataset = service.createDataset('证据错误')
    service.addCase(dataset.id, { corpusText: '真实原文' })

    const evaluation = await evaluator.evaluate(sceneId, dataset.id)

    expect(evaluation.validSamples).toBe(1)
    expect(evaluation.passedReviewSamples).toBe(0)
    expect(evaluation.judgeResults).toEqual([])
    expect(evaluation.caseResults?.[0]?.reviewEligible).toBe(false)
    expect(evaluation.caseResults?.[0]?.detail).toContain('selectedText 不属于 c0-p1')
  })

  test('用例集变了就递增数据集版本：分数不能跨用例集直接比', () => {
    const { service } = fixture(() => ({ status: 'succeeded', valid: true }))
    const dataset = service.createDataset('真实输入集')

    expect(dataset.version).toBe(1)
    const afterAdd = service.addCase(dataset.id, { corpusText: '第 1 段' })
    expect(afterAdd.version).toBe(2)
    const caseId = afterAdd.cases[0]?.id as string
    expect(service.deleteCase(dataset.id, caseId).version).toBe(3)
    expect(() => service.deleteCase(dataset.id, 'nope')).toThrow(/用例不存在/)
    expect(() => service.createDataset('   ')).toThrow(/名称不能为空/)
  })

  test('评测记录挂在场景上，未知场景/数据集直接拒绝', async () => {
    const { service, evaluator } = fixture(() => ({ status: 'succeeded', valid: true }))
    const scene = service.listScenes()[0]
    await expect(evaluator.evaluate('missing', 'ds')).rejects.toThrow(/场景不存在/)
    await expect(evaluator.evaluate(scene?.id ?? '', 'missing')).rejects.toThrow(/数据集不存在/)
  })
})
