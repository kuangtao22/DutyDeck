import { describe, expect, test } from 'bun:test'
import { createEmptySceneDefinition, type CapabilityFactoryBatch, type CapabilityRun, type CapabilityScene } from '@proma/shared'
import { createCapabilityFactoryAdoptionSummary } from './capability-factory-adoption-summary'

/** 构造同一输入、同一模型与同一评审标准的基线/候选运行。 */
function fixture() {
  const definition = {
    ...createEmptySceneDefinition('回答'),
    acceptance: { criteria: ['必须引用原文', '不得编造'], judgePrompt: '逐条核对', metrics: [] },
    steps: [{ type: 'llm' as const, id: 'answer', title: '回答', modelSlot: 'main', prompt: '回答问题' }],
  }
  const scene: CapabilityScene = {
    id: 'scene-1', definition, currentVersion: 2, createdAt: 1, updatedAt: 2,
    draft: {
      definition: { ...definition, steps: [{ ...definition.steps[0]!, prompt: '先引用原文，再回答问题' }] },
      source: 'agent', note: '补齐证据', createdAt: 3,
    },
  }
  const review = (candidate: boolean) => ({
    status: 'succeeded' as const,
    passed: candidate,
    summary: candidate ? '符合要求' : '缺少引用',
    acceptance: structuredClone(definition.acceptance),
    criteria: [
      { criterion: '必须引用原文', passed: candidate, evidence: candidate ? '已引用' : '无引用' },
      { criterion: '不得编造', passed: true, evidence: '未发现编造' },
    ],
    metrics: [], suggestions: [], modelBinding: modelBinding(), startedAt: 1, finishedAt: 2,
  })
  const run = (id: string, candidate: boolean): CapabilityRun => ({
    id, sceneId: scene.id, sceneVersion: scene.currentVersion, status: 'succeeded', valid: true,
    input: { text: '材料' }, outputs: {}, steps: [], startedAt: 1, finishedAt: 2,
    definitionTarget: candidate ? 'draft' : 'current',
    definitionSnapshot: structuredClone(candidate ? scene.draft!.definition : scene.definition),
    ...(candidate ? { draftCreatedAt: scene.draft!.createdAt } : {}),
    comparisonId: 'compare-1', comparisonRole: candidate ? 'candidate' : 'baseline',
    modelBindings: [modelBinding()], review: review(candidate),
  })
  const runs = new Map([['baseline', run('baseline', false)], ['candidate', run('candidate', true)]])
  const batch: CapabilityFactoryBatch = {
    id: 'batch-1', sceneId: scene.id, kind: 'comparison', status: 'succeeded', adoptable: true,
    snapshot: {
      sceneVersion: scene.currentVersion, draftCreatedAt: scene.draft!.createdAt,
      draftDefinition: structuredClone(scene.draft!.definition), itemIds: ['task-1'],
    },
    items: [{
      id: 'task-1', name: '材料', input: { text: '材料' }, status: 'succeeded',
      comparisonId: 'compare-1', baselineRunId: 'baseline', candidateRunId: 'candidate',
    }],
    comparison: { comparable: 1, candidatePassed: 1, fixed: ['必须引用原文'], regressed: [], unknown: [], reasons: [] },
    startedAt: 4, updatedAt: 5, finishedAt: 5,
  }
  return { scene, runs, batch }
}

/** 测试模型绑定必须完全一致，才能把变化归因到提示词。 */
function modelBinding() {
  return { slotId: 'main', declaredModel: 'test', channelId: 'channel', channelName: '测试', modelId: 'test', substituted: false }
}

/** 测试场景首步固定为 llm；集中收窄联合类型，避免测试靠类型断言掩盖错误。 */
function firstLlm(definition: CapabilityScene['definition']) {
  const step = definition.steps[0]
  if (!step || step.type !== 'llm') throw new Error('测试场景首步应为 llm')
  return step
}

describe('采纳审核摘要', () => {
  test('Given 当前草案的真实可比批次 When 生成摘要 Then 只陈述已修复事实并列出基线缺点与覆盖风险', () => {
    const { scene, runs, batch } = fixture()
    /** 摘要必须合并读取全部证据，不能为每个运行重复扫描历史。 */
    const readRequests: Array<readonly string[]> = []
    const result = createCapabilityFactoryAdoptionSummary({
      scene, testedBatchId: batch.id,
      listBatches: () => [], getBatch: () => structuredClone(batch),
      getRunsByIds: (_sceneId, runIds) => {
        readRequests.push(runIds)
        return runIds.flatMap((id) => { const run = runs.get(id); return run ? [structuredClone(run)] : [] })
      },
    })

    expect(result.adoption.benefits).toEqual(['已改善：必须引用原文'])
    expect(result.adoption.currentProblems).toEqual(['基线未通过：必须引用原文'])
    expect(result.adoption.remainingRisks).toContain('仅覆盖 1 个测试样本，未覆盖的输入仍有风险')
    expect(result.adoption.validation).toContain('1/1 组同条件对比')
    expect(result.adoption.changes).toContain('提示词（回答（answer））：「回答问题」→「先引用原文，再回答问题」')
    expect(result.adoption.rationale).toBe('补齐证据')
    expect(readRequests).toEqual([['baseline', 'candidate']])
  })

  test('Given 指定批次不匹配当前草案 When 生成摘要 Then 不声明已验证收益', () => {
    const { scene, batch } = fixture()
    batch.snapshot.draftCreatedAt = 999
    const result = createCapabilityFactoryAdoptionSummary({
      scene, testedBatchId: batch.id,
      listBatches: () => [], getBatch: () => structuredClone(batch),
      getRunsByIds: () => { throw new Error('不应为已失效的批次读取完整运行') },
    })

    expect(result.adoption.benefits).toEqual([])
    expect(result.adoption.currentProblems).toEqual([])
    expect(result.adoption.validation).toContain('与当前草案不匹配')
    expect(result.adoption.remainingRisks).toEqual([])
  })

  test('Given 普通采纳存在匹配批次 When 生成摘要 Then 可参考事实但明确不代表优化通过', () => {
    const { scene, runs, batch } = fixture()
    const stale = structuredClone(batch)
    stale.id = 'batch-newer-but-stale'
    stale.updatedAt = 20
    stale.snapshot.draftCreatedAt = 999
    const result = createCapabilityFactoryAdoptionSummary({
      scene,
      listBatches: () => [
        { ...stale, itemCount: 1, completedCount: 1 },
        { ...batch, itemCount: 1, completedCount: 1 },
      ],
      getBatch: (_sceneId, batchId) => structuredClone(batchId === stale.id ? stale : batch),
      getRunsByIds: (_sceneId, runIds) => runIds.flatMap((id) => { const run = runs.get(id); return run ? [structuredClone(run)] : [] }),
    })

    expect(result.adoption.benefits).toEqual(['已改善：必须引用原文'])
    expect(result.adoption.validation).toContain('仅作参考，本次未申请已验证采纳')
    expect(result.adoption.remainingRisks).toContain('未指定验证批次，本次采纳不代表优化通过')
  })

  test('Given 草案删除评审判据并提供提案 When 生成摘要 Then 展示真实差异且提案不冒充证据', () => {
    const { scene } = fixture()
    scene.draft!.definition.acceptance = {
      ...scene.definition.acceptance,
      criteria: ['必须引用原文'],
      judgePrompt: '只检查引用',
    }
    const result = createCapabilityFactoryAdoptionSummary({
      scene,
      proposal: { problem: '原提示词没有要求引用', expectedBenefit: '降低无依据回答', risk: '回答可能变长' },
      getRunsByIds: () => [],
    })

    expect(result.adoption.changes).toContain('评审判据（场景）：删除「不得编造」')
    expect(result.adoption.changes).toContain('评审提示词（场景）：「逐条核对」→「只检查引用」')
    expect(result.adoption.proposal).toEqual({
      problem: '原提示词没有要求引用', expectedBenefit: '降低无依据回答', risk: '回答可能变长',
    })
    expect(result.adoption.benefits).toEqual([])
    expect(result.adoption.currentProblems).toEqual([])
  })

  test('Given 长文本只在中间或末尾变化 When 生成摘要 Then 前后变化片段都可见且不超长', () => {
    const { scene } = fixture()
    const prefix = '共同规则：先核对材料。'.repeat(18)
    const suffix = '；其余规则保持不变。'.repeat(10)
    scene.definition.steps[0] = { ...firstLlm(scene.definition), prompt: `${prefix}旧结尾` }
    scene.draft!.definition.steps[0] = { ...firstLlm(scene.draft!.definition), prompt: `${prefix}新结尾` }
    scene.definition.acceptance = { ...scene.definition.acceptance, judgePrompt: `${prefix}旧中间${suffix}` }
    scene.draft!.definition.acceptance = { ...scene.draft!.definition.acceptance, judgePrompt: `${prefix}新中间${suffix}` }

    const result = createCapabilityFactoryAdoptionSummary({ scene, getRunsByIds: () => [] })
    const promptChange = result.adoption.changes.find((item) => item.startsWith('提示词')) ?? ''
    const judgeChange = result.adoption.changes.find((item) => item.startsWith('评审提示词')) ?? ''
    expect(promptChange).toContain('【旧】')
    expect(promptChange).toContain('【新】')
    expect(judgeChange).toContain('【旧】')
    expect(judgeChange).toContain('【新】')
    expect(promptChange.length).toBeLessThanOrEqual(240)
    expect(judgeChange.length).toBeLessThanOrEqual(240)
  })

  test('Given 步骤输入绑定和模型槽变化 When 生成摘要 Then 用标题定位并显示真实字段差异', () => {
    const { scene } = fixture()
    scene.definition.steps[0] = {
      ...firstLlm(scene.definition), inputs: { text: { from: 'workflow-input', field: 'text' } },
    }
    scene.draft!.definition.steps[0] = {
      ...firstLlm(scene.draft!.definition), modelSlot: 'backup',
      inputs: { text: { from: 'literal', value: '固定材料' } },
    }
    scene.draft!.definition.modelSlots = [...scene.definition.modelSlots, { id: 'backup', model: 'backup-model' }]

    const result = createCapabilityFactoryAdoptionSummary({ scene, getRunsByIds: () => [] })
    const stepChange = result.adoption.changes.find((item) => item.startsWith('流程步骤')) ?? ''
    expect(stepChange).toContain('回答（answer）')
    expect(stepChange).toContain('workflow-input')
    expect(stepChange).toContain('literal')
    expect(stepChange).toContain('main')
    expect(stepChange).toContain('backup')
    expect(stepChange.length).toBeLessThanOrEqual(240)
  })

  test('Given 长文本插入内容或仅调整空白 When 生成摘要 Then 明确标记无与空白调整', () => {
    const { scene } = fixture()
    const prefix = '固定前缀'.repeat(24)
    const suffix = '固定后缀'.repeat(24)
    scene.definition.steps[0] = { ...firstLlm(scene.definition), prompt: `${prefix}${suffix}` }
    scene.draft!.definition.steps[0] = { ...firstLlm(scene.draft!.definition), prompt: `${prefix}新增约束${suffix}` }
    scene.definition.acceptance = { ...scene.definition.acceptance, judgePrompt: '逐条\n核对' }
    scene.draft!.definition.acceptance = { ...scene.draft!.definition.acceptance, judgePrompt: '逐条 核对' }

    const result = createCapabilityFactoryAdoptionSummary({ scene, getRunsByIds: () => [] })
    const promptChange = result.adoption.changes.find((item) => item.startsWith('提示词')) ?? ''
    expect(promptChange).toContain('【无】')
    expect(promptChange).toContain('【新增约束】')
    expect(result.adoption.changes).toContain('评审提示词（场景）：仅换行/空白调整')
  })

  test('Given 顶层步骤仅调整顺序 When 生成摘要 Then 明确显示标题与前后顺序', () => {
    const { scene } = fixture()
    const second = { type: 'llm' as const, id: 'polish', title: '润色', modelSlot: 'main', prompt: '润色回答' }
    scene.definition.steps = [firstLlm(scene.definition), second]
    scene.draft!.definition.steps = [second, firstLlm(scene.draft!.definition)]

    const result = createCapabilityFactoryAdoptionSummary({ scene, getRunsByIds: () => [] })
    const orderChange = result.adoption.changes.find((item) => item.startsWith('流程顺序')) ?? ''
    expect(orderChange).toContain('回答（answer） → 润色（polish）')
    expect(orderChange).toContain('润色（polish） → 回答（answer）')
  })

  test('Given 评审判据集合相同但顺序变化 When 生成摘要 Then 不把口径变化静默忽略', () => {
    const { scene } = fixture()
    scene.draft!.definition.acceptance = {
      ...scene.definition.acceptance,
      criteria: [...scene.definition.acceptance.criteria].reverse(),
    }

    const result = createCapabilityFactoryAdoptionSummary({ scene, getRunsByIds: () => [] })
    expect(result.adoption.changes).toContain(
      '评审判据顺序（场景）：「必须引用原文 → 不得编造」→「不得编造 → 必须引用原文」',
    )
  })

  test('Given 大量提示词变化后还有契约与模型变化 When 截成六行 Then 第六行列全遗漏类别', () => {
    const { scene } = fixture()
    scene.definition.steps = Array.from({ length: 7 }, (_, index) => ({
      type: 'llm' as const, id: `step-${index}`, title: `步骤 ${index}`, modelSlot: 'main', prompt: `旧提示词 ${index}`,
    }))
    scene.draft!.definition.steps = scene.definition.steps.map((step, index) => ({ ...step, prompt: `新提示词 ${index}` }))
    scene.draft!.definition.inputs = [{ name: 'text', type: 'string' }]
    scene.draft!.definition.outputs = [{ name: 'answer', from: { stepId: 'step-6' }, shape: 'text' }]
    scene.draft!.definition.modelSlots = [{ id: 'main', model: 'new-model' }]

    const result = createCapabilityFactoryAdoptionSummary({ scene, getRunsByIds: () => [] })
    expect(result.adoption.changes).toHaveLength(6)
    expect(result.adoption.changes[5]).toContain('提示词 2 项')
    expect(result.adoption.changes[5]).toContain('输入契约 1 项')
    expect(result.adoption.changes[5]).toContain('输出契约 1 项')
    expect(result.adoption.changes[5]).toContain('模型配置 1 项')
    expect(result.adoption.changes[5]).toContain('工厂草案对比')
  })

  test('Given 普通采纳存在多项候选失败与退化 When 生成风险 Then 显示首项并报告其余数量', () => {
    const { scene, runs, batch } = fixture()
    const candidate = runs.get('candidate')!
    candidate.evidenceIssues = ['引用无法回溯']
    candidate.review!.passed = false
    candidate.review!.criteria = candidate.review!.criteria.map((criterion) => ({ ...criterion, passed: false }))
    const result = createCapabilityFactoryAdoptionSummary({
      scene,
      listBatches: () => [{ ...batch, itemCount: 1, completedCount: 1 }],
      getBatch: () => structuredClone(batch),
      getRunsByIds: (_sceneId, runIds) => runIds.flatMap((id) => {
        const run = runs.get(id)
        return run ? [structuredClone(run)] : []
      }),
    })

    expect(result.adoption.remainingRisks[0]).toContain('候选证据问题：引用无法回溯')
    expect(result.adoption.remainingRisks[0]).toMatch(/另有 \d+ 项风险或待确认问题/)
    expect(result.adoption.remainingRisks).toContain('未指定验证批次，本次采纳不代表优化通过')
    expect(result.adoption.remainingRisks).toContain('仅覆盖 1 个测试样本，未覆盖的输入仍有风险')

    const tested = createCapabilityFactoryAdoptionSummary({
      scene, testedBatchId: batch.id,
      getBatch: () => structuredClone(batch),
      getRunsByIds: (_sceneId, runIds) => runIds.flatMap((id) => {
        const run = runs.get(id)
        return run ? [structuredClone(run)] : []
      }),
    })
    expect(tested.adoption.remainingRisks[1]).toMatch(/另有 \d+ 项风险或待确认问题/)
    expect(tested.adoption.remainingRisks[1]!.length).toBeLessThanOrEqual(240)
  })
})
