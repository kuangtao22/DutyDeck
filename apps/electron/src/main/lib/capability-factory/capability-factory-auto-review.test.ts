import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityRun, CapabilitySceneDefinition } from '@proma/shared'
import { CapabilityFactoryStore } from './capability-factory-store'
import { CapabilityFactoryService } from './capability-factory-service'
import { createCapabilityFactoryRunner } from './capability-factory-run'
import type { CapabilityFactoryModelInvocation } from './capability-factory-model-call'

/** 单步场景足以验证 UI、Agent 共用的运行后评审链路。 */
const definition: CapabilitySceneDefinition = {
  name: '合成提取', description: '', inputs: [{ name: 'text', type: 'string' }],
  outputs: [{ name: 'answer', from: { stepId: 'extract' }, shape: 'text' }],
  steps: [{ id: 'extract', title: '提取', type: 'llm', prompt: '{{text}}', modelSlot: 'm' }],
  capabilities: [], modelSlots: [{ id: 'm', model: 'test' }],
  acceptance: { criteria: ['必须有证据'], judgePrompt: '核对证据', metrics: [] },
}
/** 合成评审报告，内容未达标与执行成功分开。 */
const report = JSON.stringify({ passed: false, summary: '缺少证据',
  criteria: [{ criterion: '必须有证据', passed: false, evidence: '输出没有引用原文' }], metrics: [], suggestions: ['增加原文引用'] })

/** 每个测试隔离磁盘目录，可在模型等待期间检查保存的中间状态。 */
function fixture(judge?: (request: CapabilityFactoryModelInvocation) => Promise<{ text: string; model: string }>) {
  const service = new CapabilityFactoryService({ store: new CapabilityFactoryStore(mkdtempSync(join(tmpdir(), 'auto-review-'))) })
  const scene = service.createScene('合成提取')
  service.saveDraft(scene.id, definition, 'human', '测试')
  service.adoptDraft(scene.id)
  const calls: CapabilityFactoryModelInvocation[] = []
  const progress: CapabilityRun[] = []
  const runner = createCapabilityFactoryRunner({ service,
    resolveModels: () => ({ bindings: [{ slotId: 'm', declaredModel: 'test', channelId: 'c', channelName: '合成渠道', modelId: 'test', substituted: false }] }),
    callModel: async (request) => {
      calls.push(request)
      if (request.stepId === '__factory_review__') {
        expect(service.listRuns(scene.id)[0]?.review?.status).toBe('running')
        return judge ? judge(request) : { text: report, model: 'test' }
      }
      return { text: '小林', model: 'test' }
    },
    onProgress: (run) => progress.push(run),
  })
  return { service, scene, runner, calls, progress }
}

/** 为多步骤、失败链路与并行组提供可定制的真实 runner 夹具。 */
function scenarioFixture(
  sceneDefinition: CapabilitySceneDefinition,
  respond: (request: CapabilityFactoryModelInvocation) => Promise<{ text: string; model: string }>,
) {
  const service = new CapabilityFactoryService({ store: new CapabilityFactoryStore(mkdtempSync(join(tmpdir(), 'auto-review-scenario-'))) })
  const scene = service.createScene(sceneDefinition.name)
  service.saveDraft(scene.id, sceneDefinition, 'human', '多流程评审测试')
  service.adoptDraft(scene.id)
  const calls: CapabilityFactoryModelInvocation[] = []
  /** 保留独立进度快照，验证并发项完成时仍有其它项运行。 */
  const progress: CapabilityRun[] = []
  const runner = createCapabilityFactoryRunner({
    service,
    onProgress: (run) => { progress.push(structuredClone(run)) },
    resolveModels: () => ({ bindings: sceneDefinition.modelSlots.map((slot) => ({
      slotId: slot.id, declaredModel: slot.model, channelId: 'c', channelName: '合成渠道', modelId: slot.model, substituted: false,
    })) }),
    callModel: async (request) => {
      calls.push(request)
      return respond(request)
    },
  })
  return { service, scene, runner, calls, progress }
}

/** 生成与单个步骤标准严格对应的评审报告。 */
function stepReport(criterion: string, passed: boolean, summary: string): string {
  return JSON.stringify({
    passed,
    summary,
    criteria: [{ criterion, passed, evidence: `证据：${summary}` }],
    metrics: [],
    suggestions: passed ? [] : ['调整该步骤提示词'],
  })
}

describe('运行后自动评审闭环', () => {
  test('Given 整链运行完成 When 自动评审 Then 同条记录保留输出与质量结论', async () => {
    const { service, scene, runner, calls, progress } = fixture()
    const run = await runner.run(scene.id, { text: '小林在书店。' })
    expect(calls).toHaveLength(2)
    expect(run.status).toBe('succeeded')
    expect(run.valid).toBe(true)
    expect(run.review?.passed).toBe(false)
    expect(run.outputs).toEqual({ answer: '小林' })
    expect(progress[0]?.status).toBe('running')
    expect(progress[0]?.activeStepIds).toEqual(['extract'])
    expect(progress.find((item) => item.review?.status === 'running')?.outputs).toEqual({ answer: '小林' })
    expect(progress.some((item) => item.stepReviews?.extract?.status === 'running')).toBe(true)
    expect(run.activeStepIds).toBeUndefined()
    expect(service.listRuns(scene.id)).toHaveLength(1)
    expect(service.listRuns(scene.id)[0]?.review?.status).toBe('succeeded')
  })

  test('Given 并行组同一步正在处理两项 When 首项完成 Then 另一项和并行组仍显示运行中', async () => {
    /** 两个并发调用在同一微任务轮次开始，首项完成不能清空第二项的活跃状态。 */
    const parallel: CapabilitySceneDefinition = { ...definition,
      inputs: [{ name: 'texts', type: 'array', items: { type: 'string' } }],
      steps: [{ id: 'each', title: '并行提取', type: 'map', concurrency: 2,
        over: { from: 'workflow-input', field: 'texts' }, body: definition.steps }],
      outputs: [{ name: 'answer', from: { stepId: 'each' }, shape: 'structured' }],
    }
    const { runner, scene, progress, service } = scenarioFixture(parallel, async (request) => ({
      text: request.stepId === '__factory_review__' ? report : '人物', model: 'test',
    }))
    const result = await runner.run(scene.id, { texts: ['甲', '乙'] })
    /** 第一个子项完成时，另一个同 ID 子项尚未结束。 */
    const firstCompleted = progress.find((item) => item.status === 'running' && item.steps.length === 1)
    expect(firstCompleted?.activeStepIds).toEqual(['each', 'extract'])
    expect(result.status).toBe('succeeded')
    expect(result.activeStepIds).toBeUndefined()
    expect(service.listRuns(scene.id)).toHaveLength(1)
  })

  test('Given 每个流程步骤有自己的标准 When 自动评审 Then 保存按步骤拆分的评审结果', async () => {
    const { scene, runner, service } = fixture()
    const current = service.getScene(scene.id)!
    service.saveDraft(scene.id, { ...current.definition, stepAcceptances: { extract: { criteria: ['必须有证据'], judgePrompt: '只评提取步骤', metrics: [] } } }, 'human', '步骤标准')
    service.adoptDraft(scene.id)
    const run = await runner.run(scene.id, { text: '小林在书店。' }, {
      target: 'current',
    })
    const saved = service.listRuns(scene.id)[0]
    expect(saved?.stepReviews?.extract?.acceptance.criteria).toEqual(['必须有证据'])
    expect(saved?.stepReviews?.extract?.passed).toBe(false)
    expect(run.review?.passed).toBe(false)
  })

  test('Given 两个模型步骤使用不同标准 When 评审结论不同 Then 分别持久化且整体不通过', async () => {
    const multiStepDefinition: CapabilitySceneDefinition = {
      name: '双步骤提取', description: '', inputs: [{ name: 'text', type: 'string' }],
      outputs: [{ name: 'answer', from: { stepId: 'summarize' }, shape: 'text' }],
      steps: [
        { id: 'extract', title: '提取事实', type: 'llm', prompt: '{{text}}', modelSlot: 'extract-model' },
        { id: 'summarize', title: '形成摘要', type: 'llm', prompt: '{{facts}}', modelSlot: 'summary-model', inputs: { facts: { from: 'step-output', stepId: 'extract' } } },
      ],
      capabilities: [],
      modelSlots: [{ id: 'extract-model', model: 'extract-test' }, { id: 'summary-model', model: 'summary-test' }],
      acceptance: { criteria: [], judgePrompt: '', metrics: [] },
      stepAcceptances: {
        extract: { criteria: ['事实必须来自原文'], judgePrompt: '只核对事实来源', metrics: [] },
        summarize: { criteria: ['摘要必须覆盖全部事实'], judgePrompt: '只核对摘要覆盖度', metrics: [] },
      },
    }
    const { service, scene, runner, calls } = scenarioFixture(multiStepDefinition, async (request) => {
      if (request.stepId === 'extract') return { text: '事实 A', model: 'extract-test' }
      if (request.stepId === 'summarize') return { text: '遗漏事实的摘要', model: 'summary-test' }
      if (request.prompt.includes('事实必须来自原文')) {
        return { text: stepReport('事实必须来自原文', true, '事实有原文依据'), model: request.modelId }
      }
      return { text: stepReport('摘要必须覆盖全部事实', false, '摘要遗漏事实'), model: request.modelId }
    })

    const run = await runner.run(scene.id, { text: '原文事实 A' })
    const saved = service.listRuns(scene.id)[0]

    expect(calls.filter((call) => call.stepId === '__factory_review__')).toHaveLength(2)
    expect(saved?.stepReviews?.extract?.passed).toBe(true)
    expect(saved?.stepReviews?.extract?.acceptance.judgePrompt).toBe('只核对事实来源')
    expect(saved?.stepReviews?.summarize?.passed).toBe(false)
    expect(saved?.stepReviews?.summarize?.acceptance.judgePrompt).toBe('只核对摘要覆盖度')
    expect(run.review?.passed).toBe(false)
  })

  test('Given 下游工具步骤失败 When 上游模型已有成功输出 Then 仍保存上游独立评审', async () => {
    const downstreamFailureDefinition: CapabilitySceneDefinition = {
      name: '下游失败', description: '', inputs: [{ name: 'text', type: 'string' }], outputs: [],
      steps: [
        { id: 'extract', title: '先提取', type: 'llm', prompt: '{{text}}', modelSlot: 'm' },
        { id: 'deliver', title: '再提交', type: 'tool', capabilityId: 'missing-delivery', bindings: { value: { from: 'step-output', stepId: 'extract' } } },
      ],
      capabilities: [{ id: 'missing-delivery', description: '测试下游失败', inputSchema: [], outputSchema: [], sideEffect: 'write' }],
      modelSlots: [{ id: 'm', model: 'test' }], acceptance: { criteria: [], judgePrompt: '', metrics: [] },
      stepAcceptances: { extract: { criteria: ['提取结果必须非空'], judgePrompt: '核对提取结果', metrics: [] } },
    }
    const { service, scene, runner, calls } = scenarioFixture(downstreamFailureDefinition, async (request) => {
      if (request.stepId === 'extract') return { text: '已提取内容', model: 'test' }
      return { text: stepReport('提取结果必须非空', true, '提取结果非空'), model: 'test' }
    })

    const run = await runner.run(scene.id, { text: '正文' })
    const saved = service.listRuns(scene.id)[0]

    expect(run.status).toBe('failed')
    expect(run.steps.find((step) => step.stepId === 'extract')?.status).toBe('succeeded')
    expect(calls.filter((call) => call.stepId === '__factory_review__')).toHaveLength(1)
    expect(saved?.stepReviews?.extract?.passed).toBe(true)
  })

  test('Given map 内同一模型步骤执行多项 When 自动评审 Then 汇集全部轨迹生成一份步骤报告', async () => {
    const mapDefinition: CapabilitySceneDefinition = {
      name: '并行分类', description: '',
      inputs: [{ name: 'items', type: 'array', items: { type: 'string' } }],
      outputs: [{ name: 'labels', from: { stepId: 'parallel' }, shape: 'structured' }],
      steps: [{
        id: 'parallel', title: '并行处理', type: 'map', over: { from: 'workflow-input', field: 'items' }, concurrency: 2,
        body: [{ id: 'classify', title: '逐项分类', type: 'llm', prompt: '分类：{{item}}', modelSlot: 'm', inputs: { item: { from: 'workflow-input', field: 'item' } } }],
      }],
      capabilities: [], modelSlots: [{ id: 'm', model: 'test' }], acceptance: { criteria: [], judgePrompt: '', metrics: [] },
      stepAcceptances: { classify: { criteria: ['每一项都必须有分类'], judgePrompt: '逐项核对分类', metrics: [] } },
    }
    const reviewPrompts: string[] = []
    const { service, scene, runner, calls } = scenarioFixture(mapDefinition, async (request) => {
      if (request.stepId === 'classify') return { text: request.prompt.includes('甲') ? '类别甲' : '类别乙', model: 'test' }
      reviewPrompts.push(request.prompt)
      return { text: stepReport('每一项都必须有分类', true, '两项均有分类'), model: 'test' }
    })

    await runner.run(scene.id, { items: ['甲', '乙'] })
    const saved = service.listRuns(scene.id)[0]

    expect(saved?.steps.filter((step) => step.stepId === 'classify')).toHaveLength(2)
    expect(calls.filter((call) => call.stepId === '__factory_review__')).toHaveLength(1)
    expect(reviewPrompts[0]).toContain('类别甲')
    expect(reviewPrompts[0]).toContain('类别乙')
    expect(Object.keys(saved?.stepReviews ?? {})).toEqual(['classify'])
    expect(saved?.stepReviews?.classify?.passed).toBe(true)
  })

  test('Given 另一步缺少标准 When 整链与单步运行 Then 整链阻断但已配置步骤可单跑', async () => {
    const incompleteDefinition: CapabilitySceneDefinition = {
      name: '标准未配完', description: '', inputs: [{ name: 'text', type: 'string' }],
      outputs: [{ name: 'answer', from: { stepId: 'second' }, shape: 'text' }],
      steps: [
        { id: 'first', title: '第一步', type: 'llm', prompt: '{{text}}', modelSlot: 'm' },
        { id: 'second', title: '第二步', type: 'llm', prompt: '{{value}}', modelSlot: 'm', inputs: { value: { from: 'step-output', stepId: 'first' } } },
      ],
      capabilities: [], modelSlots: [{ id: 'm', model: 'test' }], acceptance: { criteria: [], judgePrompt: '', metrics: [] },
      stepAcceptances: { first: { criteria: ['第一步结果必须非空'], judgePrompt: '只评第一步', metrics: [] } },
    }
    const { scene, runner, calls } = scenarioFixture(incompleteDefinition, async (request) => {
      if (request.stepId === '__factory_review__') {
        return { text: stepReport('第一步结果必须非空', true, '第一步非空'), model: 'test' }
      }
      return { text: '第一步结果', model: 'test' }
    })

    const fullRun = await runner.run(scene.id, { text: '正文' })
    expect(fullRun.status).toBe('failed')
    expect(fullRun.error).toContain('评审标准')
    expect(calls).toHaveLength(0)

    const stepRun = await runner.runStep(scene.id, 'first', { text: '正文' })
    expect(stepRun.status).toBe('succeeded')
    expect(stepRun.stepReviews?.first?.passed).toBe(true)
    expect(calls.map((call) => call.stepId)).toEqual(['first', '__factory_review__'])
  })

  test('Given 单步临时编辑标准 When 试跑 Then 使用临时快照而非当前场景', async () => {
    const { scene, runner } = fixture(async (request) => {
      expect(request.prompt).toContain('只评当前步骤')
      expect(request.prompt).toContain('临时评审要求')
      return { text: report, model: 'test' }
    })
    const run = await runner.runStep(scene.id, 'extract', { text: '正文' }, {
      ...definition, acceptance: { ...definition.acceptance, judgePrompt: '临时评审要求' },
    })
    expect(run.review?.status).toBe('succeeded')
    expect(run.review?.acceptance.judgePrompt).toBe('临时评审要求')
  })

  test('Given 评审服务失败 When 运行完成 Then 输出与历史保留且质量不通过不混淆', async () => {
    const { scene, runner, service } = fixture(async () => { throw new Error('评审超时') })
    const run = await runner.run(scene.id, { text: '正文' })
    expect(run.status).toBe('succeeded')
    expect(run.review?.status).toBe('failed')
    expect(run.review?.passed).toBeNull()
    expect(service.listRuns(scene.id)[0]?.outputs).toEqual({ answer: '小林' })
  })

  test('Given 无评审规则 When 运行 Then 继承能力包契约要求并明确缺少标准', async () => {
    const { scene, runner, calls } = fixture()
    const run = await runner.runStep(scene.id, 'extract', { text: '正文' }, {
      ...definition, acceptance: { criteria: [], judgePrompt: '', metrics: [] },
    })
    expect(run.status).toBe('failed')
    expect(run.error).toContain('评审标准')
    expect(calls).toHaveLength(0)
  })

  test('Given 输入缺失 When 执行失败 Then 不调用评审模型', async () => {
    const { scene, runner, calls } = fixture()
    const run = await runner.run(scene.id, {})
    expect(run.status).toBe('failed')
    expect(calls).toHaveLength(0)
  })

  test('Given 评审期间场景有新版本 When 完成 Then 报告仍绑定本轮旧规则', async () => {
    const { scene, runner, service } = fixture(async () => {
      service.saveDraft(scene.id, { ...definition,
        acceptance: { criteria: ['新的标准'], judgePrompt: '新的评审', metrics: [] },
      }, 'human', '评审期间修改')
      service.adoptDraft(scene.id)
      return { text: report, model: 'test' }
    })
    const run = await runner.run(scene.id, { text: '正文' })
    expect(run.sceneVersion).toBe(2)
    expect(service.getScene(scene.id)?.currentVersion).toBe(3)
    expect(run.review?.acceptance.criteria).toEqual(['必须有证据'])
    expect(run.review?.criteria[0]?.criterion).toBe('必须有证据')
  })

  test('Given 两次运行同时评审 When 先后落盘 Then 不丢记录且各自只有一行', async () => {
    const { scene, runner, service } = fixture()
    const runs = await Promise.all([
      runner.run(scene.id, { text: '第一份正文' }),
      runner.run(scene.id, { text: '第二份正文' }),
    ])
    const saved = service.listRuns(scene.id)
    expect(saved).toHaveLength(2)
    expect(new Set(saved.map((item) => item.id))).toEqual(new Set(runs.map((item) => item.id)))
    expect(saved.every((item) => item.review?.status === 'succeeded')).toBe(true)
  })

  test('Given 上次退出时评审未结束 When 新进程恢复 Then 保留输出并标记评测中断', () => {
    const { service, scene } = fixture()
    service.recordRun({
      id: 'interrupted', sceneId: scene.id, sceneVersion: 2, status: 'succeeded', valid: true,
      input: { text: '正文' }, outputs: { answer: '小林' }, steps: [], startedAt: 1, finishedAt: 2,
      review: { status: 'running', passed: null, summary: '评测中', acceptance: definition.acceptance,
        criteria: [], metrics: [], suggestions: [], startedAt: 3, finishedAt: null },
    })
    service.recoverInterruptedReviews()
    const saved = service.listRuns(scene.id)[0]
    expect(saved?.review?.status).toBe('failed')
    expect(saved?.review?.error).toContain('中断')
    expect(saved?.outputs).toEqual({ answer: '小林' })
    expect(service.listRuns(scene.id)).toHaveLength(1)
  })
})
