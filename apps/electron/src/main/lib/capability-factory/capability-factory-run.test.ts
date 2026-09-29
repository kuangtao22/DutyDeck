/**
 * 「运行」这一段的测试：桩 → runner → 运行记录，全部离线（模型与能力都是注入的）。
 * 断言重点不是"跑通"，而是**几种失败必须如实落进历史**：没绑桩、声明模型找不到、
 * 定义不合法、输入不满足契约；以及三轴（status / valid / 步骤状态）互不污染。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilitySceneDefinition, Channel } from '@proma/shared'
import { CapabilityFactoryStore } from './capability-factory-store'
import { CapabilityFactoryService } from './capability-factory-service'
import { createCapabilityFactoryRunner } from './capability-factory-run'
import { resolveCapabilityFactoryModels } from './capability-factory-model-call'

/** 一个两步场景：先取桩（tool），再抽取（extract），输出取第二步的结果。 */
function definition(overrides: Partial<CapabilitySceneDefinition> = {}): CapabilitySceneDefinition {
  return {
    name: '小说角色提取',
    description: '',
    inputs: [{ name: 'chapterText', type: 'string' }],
    outputs: [{ name: 'characters', from: { stepId: 'scan' }, shape: 'structured' }],
    steps: [
      {
        id: 'build', title: '构建批次正文', type: 'tool', capabilityId: 'corpus.build',
        bindings: { text: { from: 'workflow-input', field: 'chapterText' } },
      },
      {
        id: 'scan', title: '扫描人物候选', type: 'extract', modelSlot: 'main',
        prompt: '从 {{corpus}} 里找出人物候选',
        inputs: { corpus: { from: 'step-output', stepId: 'build' } },
        judgeFields: [{ name: 'characters', type: 'array' }],
        strictness: 'strict',
      },
    ],
    capabilities: [{
      id: 'corpus.build',
      description: '把正文解析成带段落引用的批次正文',
      inputSchema: [{ name: 'text', type: 'string' }],
      outputSchema: [{ name: 'corpus', type: 'string' }],
      sideEffect: 'read',
    }],
    modelSlots: [{ id: 'main', model: 'gpt-5.4' }],
    acceptance: { criteria: ['必须有段落引用'], judgePrompt: '', metrics: [] },
    ...overrides,
  }
}

/** 一个可用渠道：声明模型 gpt-5.4 在这里不存在，用来验证"落到会话模型"。 */
const channels: Channel[] = [{
  id: 'ch-1', name: '传贝-DeepSeek', provider: 'deepseek', baseUrl: 'https://example.invalid',
  apiKey: '', enabled: true, createdAt: 0, updatedAt: 0,
  models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true }],
}]

/** 造一个带场景与运行适配器的夹具。 */
function fixture(options: { definition?: CapabilitySceneDefinition; modelText?: string } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'cap-factory-run-'))
  let tick = 0
  const service = new CapabilityFactoryService({
    store: new CapabilityFactoryStore(rootDir),
    now: () => (tick += 1000),
    createId: () => 'scene-1',
  })
  service.createScene('小说角色提取')
  service.saveDraft('scene-1', options.definition ?? definition(), 'human', '测试用定义')
  service.adoptDraft('scene-1')

  /** 记录模型调用入参：验证格式说明真的被拼进了提示词，以及拿到的是解析后的模型。 */
  const calls: { prompt: string; formatInstruction?: string; model: string; channelId: string; modelId: string }[] = []
  const runner = createCapabilityFactoryRunner({
    service,
    resolveModels: (sceneDefinition) =>
      resolveCapabilityFactoryModels(sceneDefinition, channels, { channelId: 'ch-1', modelId: 'deepseek-v4-flash' }),
    callModel: async (invocation) => {
      calls.push({
        prompt: invocation.prompt,
        model: invocation.model,
        channelId: invocation.channelId,
        modelId: invocation.modelId,
        ...(invocation.formatInstruction === undefined ? {} : { formatInstruction: invocation.formatInstruction }),
      })
      return { text: options.modelText ?? '{"characters":[{"name":"阿明"}]}', model: 'deepseek-v4-flash' }
    },
    createId: () => `run-${calls.length + 1}`,
  })
  return { service, runner, calls }
}

describe('运行：桩与轨迹', () => {
  test('整链提交在首次模型调用前保存为可复用任务', async () => {
    const { service, runner, calls } = fixture()
    service.setStub('corpus.build', { corpus: '正文' })
    const originalSaveTask = service.saveTask.bind(service)
    service.saveTask = (sceneId, input) => {
      expect(calls).toHaveLength(0)
      return originalSaveTask(sceneId, input)
    }

    await runner.run('scene-1', { chapterText: '待保存正文' })

    expect(service.listTasks('scene-1').map((task) => task.input)).toEqual([{ chapterText: '待保存正文' }])
  })

  test('任务保存失败时不调用模型，也不继续执行整链', async () => {
    const { service, runner, calls } = fixture()
    service.setStub('corpus.build', { corpus: '正文' })
    service.saveTask = () => { throw new Error('磁盘已满') }

    await expect(runner.run('scene-1', { chapterText: '待保存正文' })).rejects.toThrow(/磁盘已满/)
    expect(calls).toHaveLength(0)
    expect(service.listRuns('scene-1')).toEqual([])
  })

  test('单步试跑不保存为整链任务', async () => {
    const { service, runner } = fixture()
    await runner.runStep('scene-1', 'scan', { corpus: '步骤中间值' })
    expect(service.listTasks('scene-1')).toEqual([])
  })

  test('批量评测关闭保存时，运行记录不会经旧历史兼容重新进入任务列表', async () => {
    const { service, runner } = fixture()
    service.setStub('corpus.build', { corpus: '正文' })

    const run = await runner.run('scene-1', { chapterText: '评测集正文' }, { saveTask: false })

    expect(run.taskSaved).toBe(false)
    expect(service.listTasks('scene-1')).toEqual([])
  })

  test('Given 场景有待采纳草案 When 以候选身份运行 Then 使用草案定义并保存快照，但不采纳也不保存任务', async () => {
    const { service, runner, calls } = fixture()
    service.setStub('corpus.build', { corpus: '正文' })
    const current = service.getScene('scene-1')
    if (!current) throw new Error('缺少测试场景')
    const candidate = definition({
      steps: current.definition.steps.map((step) =>
        step.id === 'scan' && step.type === 'extract' ? { ...step, prompt: '候选提示词 {{corpus}}' } : step),
    })
    const drafted = service.saveDraft('scene-1', candidate, 'agent', '优化提示词')
    const draftCreatedAt = drafted.draft?.createdAt
    if (draftCreatedAt === undefined) throw new Error('草案应已创建')

    const run = await runner.run('scene-1', { chapterText: '评测正文' }, {
      target: 'draft', expectedVersion: 2, expectedDraftCreatedAt: draftCreatedAt,
      expectedDraftDefinition: candidate,
      comparisonId: 'compare-1', comparisonRole: 'candidate',
    })

    expect(calls[0]?.prompt).toContain('候选提示词')
    expect(run.definitionTarget).toBe('draft')
    expect(run.draftCreatedAt).toBe(draftCreatedAt)
    expect(run.definitionSnapshot).toEqual(candidate)
    expect(run.comparisonId).toBe('compare-1')
    expect(run.comparisonRole).toBe('candidate')
    expect(run.taskSaved).toBe(false)
    expect(service.listTasks('scene-1')).toEqual([])
    expect(service.getScene('scene-1')?.currentVersion).toBe(2)
    expect(service.getScene('scene-1')?.draft?.definition).toEqual(candidate)
  })

  test('Given 对比已绑定草案 When 草案被覆盖 Then 旧时间戳运行失败且不调模型', async () => {
    const { service, runner, calls } = fixture()
    const current = service.getScene('scene-1')
    if (!current) throw new Error('缺少测试场景')
    const first = service.saveDraft('scene-1', current.definition, 'agent', '第一份')
    const firstCreatedAt = first.draft?.createdAt
    service.saveDraft('scene-1', current.definition, 'agent', '第二份')

    const run = await runner.run('scene-1', { chapterText: '正文' }, {
      target: 'draft', expectedVersion: 2, expectedDraftCreatedAt: firstCreatedAt,
      expectedDraftDefinition: current.definition,
      comparisonId: 'compare-1', comparisonRole: 'candidate',
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('草案已变化')
    expect(calls).toHaveLength(0)
  })

  test('Given 候选草案改了评审标准 When 用于对比 Then 拒绝运行，避免用放宽标准制造优化', async () => {
    const { service, runner, calls } = fixture()
    const current = service.getScene('scene-1')
    if (!current) throw new Error('缺少测试场景')
    const candidate = definition({
      acceptance: { ...current.definition.acceptance, criteria: ['放宽后的标准'] },
    })
    const drafted = service.saveDraft('scene-1', candidate, 'agent', '改标准')

    const run = await runner.run('scene-1', { chapterText: '正文' }, {
      target: 'draft', expectedVersion: 2, expectedDraftCreatedAt: drafted.draft?.createdAt,
      expectedDraftDefinition: candidate,
      comparisonId: 'compare-1', comparisonRole: 'candidate',
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('评审标准不一致')
    expect(calls).toHaveLength(0)
  })

  test('Given 候选草案改了模型槽位 When 用于对比 Then 拒绝运行，避免把换模型当成提示词优化', async () => {
    const { service, runner, calls } = fixture()
    const current = service.getScene('scene-1')
    if (!current) throw new Error('缺少测试场景')
    const candidate = definition({ modelSlots: [{ id: 'main', model: 'another-model' }] })
    const drafted = service.saveDraft('scene-1', candidate, 'agent', '换模型')

    const run = await runner.run('scene-1', { chapterText: '正文' }, {
      target: 'draft', expectedVersion: 2, expectedDraftCreatedAt: drafted.draft?.createdAt,
      expectedDraftDefinition: candidate,
      comparisonId: 'compare-1', comparisonRole: 'candidate',
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('模型绑定不一致')
    expect(calls).toHaveLength(0)
  })

  test('Given 草案运行没有对比标识 When 执行 Then 仍不能污染用户保存任务', async () => {
    const { service, runner } = fixture()
    service.setStub('corpus.build', { corpus: '正文' })
    const current = service.getScene('scene-1')
    if (!current) throw new Error('缺少测试场景')
    const candidate = definition({ description: '不带对比标识的草案' })
    const drafted = service.saveDraft('scene-1', candidate, 'agent', '草案')

    const run = await runner.run('scene-1', { chapterText: '正文' }, {
      target: 'draft', expectedVersion: current.currentVersion,
      expectedDraftCreatedAt: drafted.draft?.createdAt, expectedDraftDefinition: candidate,
    })

    expect(run.taskSaved).toBe(false)
    expect(service.listTasks('scene-1')).toEqual([])
  })

  test('Given 预期草案只是对象键顺序不同 When 运行候选 Then 不误判为草案已变化', async () => {
    const { service, runner } = fixture()
    service.setStub('corpus.build', { corpus: '正文' })
    const candidate = definition({ description: '键顺序测试' })
    const drafted = service.saveDraft('scene-1', candidate, 'agent', '草案')
    /** 只倒置顶层键的插入顺序，JSON 语义不变。 */
    const reordered = Object.fromEntries(Object.entries(candidate).reverse()) as unknown as CapabilitySceneDefinition

    const run = await runner.run('scene-1', { chapterText: '正文' }, {
      target: 'draft', expectedVersion: 2, expectedDraftCreatedAt: drafted.draft?.createdAt,
      expectedDraftDefinition: reordered,
    })

    expect(run.status).toBe('succeeded')
  })

  test('Given 对比基线指定当前版本 When 版本已变化 Then 停止运行并保留可读失败记录', async () => {
    const { runner, calls } = fixture()

    const run = await runner.run('scene-1', { chapterText: '正文' }, {
      target: 'current', expectedVersion: 1,
      comparisonId: 'compare-1', comparisonRole: 'baseline',
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('基线版本已变化')
    expect(run.definitionTarget).toBe('current')
    expect(run.comparisonRole).toBe('baseline')
    expect(calls).toHaveLength(0)
  })

  test('Given 桩已绑定 When 运行 Then 两步都完成、输出按声明取出，并带回模型绑定', async () => {
    const { service, runner, calls } = fixture()
    service.setStub('corpus.build', { corpus: '第 1 段：阿明抬头看着天。' })

    const run = await runner.run('scene-1', { chapterText: '第一章……' })

    expect(run.status).toBe('succeeded')
    expect(run.valid).toBe(true)
    expect(run.sceneVersion).toBe(2)
    expect(run.outputs).toEqual({ characters: { characters: [{ name: '阿明' }] } })
    expect(run.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded'])
    /** 桩的返回值必须出现在轨迹里，否则"这次跑用的什么数据"就看不见。 */
    expect(run.steps[0]?.parsedOutput).toEqual({ corpus: '第 1 段：阿明抬头看着天。' })
    /** 声明的是 gpt-5.4、本机没有，于是落到会话模型，并如实记录。 */
    expect(run.modelBindings).toEqual([{
      slotId: 'main', declaredModel: 'gpt-5.4',
      channelId: 'ch-1', channelName: '传贝-DeepSeek', modelId: 'deepseek-v4-flash', substituted: true,
    }])
    expect(run.steps[1]?.model).toBe('deepseek-v4-flash')
    /**
     * 端口拿到的必须是**解析后**的渠道 + 模型：runner 只会给声明值（gpt-5.4），
     * 端口若拿声明值去渠道里找就永远找不到 —— 这条断言锁的就是这个接线错误。
     */
    expect(calls[0]?.channelId).toBe('ch-1')
    expect(calls[0]?.modelId).toBe('deepseek-v4-flash')
    expect(calls[0]?.model).toBe('gpt-5.4')
    /** 抽取步骤的格式说明要真的拼进提示词，否则模型不知道要输出什么形状。 */
    expect(calls[0]?.formatInstruction).toBeTruthy()
    expect(calls[0]?.prompt).toContain('阿明抬头看着天')
  })

  test('Given 没绑桩 When 运行 Then 那一步明确失败并指名能力，整次运行判不合法', async () => {
    const { runner } = fixture()

    const run = await runner.run('scene-1', { chapterText: '第一章……' })

    expect(run.status).toBe('failed')
    expect(run.valid).toBe(false)
    expect(run.steps[0]?.status).toBe('failed')
    expect(run.steps[0]?.error).toContain('corpus.build')
    /** 前一步失败就不该继续烧模型调用。 */
    expect(run.steps).toHaveLength(1)
  })

  test('Given 约束不通过 When 运行 Then 代码跑完但 valid=false，两条轴不互相覆盖', async () => {
    const { service, runner } = fixture({ modelText: '这不是 JSON' })
    service.setStub('corpus.build', { corpus: '正文' })

    const run = await runner.run('scene-1', { chapterText: '第一章……' })

    /** 运行轴：strict 抽取耗尽重试后整条链没跑完。 */
    expect(run.status).toBe('failed')
    /** 约束轴：这次输出不合法。 */
    expect(run.valid).toBe(false)
    /** 步骤轴：这一步是"判定不合法"，不是"执行失败" —— 两件事修法完全不同。 */
    expect(run.steps[1]?.status).toBe('invalid')
    expect(run.steps[1]?.constraintErrors?.length ?? 0).toBeGreaterThan(0)
  })

  test('Given 输入不满足契约 When 运行 Then 一次模型都不调，错误写进运行记录', async () => {
    const { service, runner, calls } = fixture()
    service.setStub('corpus.build', { corpus: '正文' })

    const run = await runner.run('scene-1', {})

    expect(run.status).toBe('failed')
    expect(run.error).toContain('chapterText')
    expect(run.steps).toEqual([])
    expect(calls).toHaveLength(0)
    /** 即使执行失败，提交本身也已保存，下次修好输入后仍可直接复用。 */
    expect(service.listTasks('scene-1').map((task) => task.input)).toEqual([{}])
  })

  test('Given 定义不合法 When 运行 Then 构建能力包这一步就拦住，不产生半截运行', async () => {
    /** 输出引用了不存在的步骤 —— 严格解析会拒绝。 */
    const broken = definition({ outputs: [{ name: 'x', from: { stepId: '不存在的步骤' }, shape: 'text' }] })
    const { runner } = fixture({ definition: broken })

    const run = await runner.run('scene-1', { chapterText: '第一章……' })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('场景定义还不合法')
    expect(run.steps).toEqual([])
  })

  test('Given 没有任何可用渠道 When 运行 Then 明确报"没有渠道"，而不是抛异常给界面', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cap-factory-run-'))
    const service = new CapabilityFactoryService({ store: new CapabilityFactoryStore(rootDir) })
    const scene = service.createScene('小说角色提取')
    const runner = createCapabilityFactoryRunner({
      service,
      resolveModels: (sceneDefinition) => resolveCapabilityFactoryModels(sceneDefinition, [], null),
      callModel: async () => ({ text: '', model: '' }),
    })

    const run = await runner.run(scene.id, {})

    expect(run.status).toBe('failed')
    expect(run.error).toContain('没有可用的模型渠道')
  })

  test('Given 用的是占位桩 When 运行 Then 记录里带上占位能力 id（否则空值结果会被当成质量结论）', async () => {
    const { service, runner } = fixture()
    /** 显式记成 placeholder：一键占位走的就是这条路径。 */
    service.setStub('corpus.build', { corpus: '' }, '先跑通流程', 'placeholder')

    const run = await runner.run('scene-1', { chapterText: '第一章……' })

    expect(run.placeholderCapabilities).toEqual(['corpus.build'])
  })

  test('Given 用的是真实形状的桩 When 运行 Then 不标占位', async () => {
    const { service, runner } = fixture()
    service.setStub('corpus.build', { corpus: '第 1 段：阿明抬头看着天。' }, '取自真实响应', 'human')

    const run = await runner.run('scene-1', { chapterText: '第一章……' })

    expect(run.placeholderCapabilities).toBeUndefined()
  })
})

describe('运行历史与虚拟接入的存取', () => {
  test('运行记录按场景追加，读取时最新的在前', async () => {
    const { service, runner } = fixture()
    service.setStub('corpus.build', { corpus: '正文' })

    const first = await runner.run('scene-1', { chapterText: '第一章' })
    const second = await runner.run('scene-1', { chapterText: '第二章' })

    expect(service.listRuns('scene-1').map((run) => run.id)).toEqual([second.id, first.id])
    expect(service.listRuns('scene-1', 1)).toHaveLength(1)
    /** 不同场景的历史互不干扰。 */
    expect(service.listRuns('scene-2')).toEqual([])
  })

  test('桩可覆盖、可清空；清空后回到未绑定（能力 id 非法直接拒绝）', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cap-factory-run-'))
    const service = new CapabilityFactoryService({ store: new CapabilityFactoryStore(rootDir) })

    service.setStub('corpus.build', { corpus: 'v1' })
    const stub = service.setStub('corpus.build', { corpus: 'v2' }, '取自真实响应')

    expect(stub.capabilityId).toBe('corpus.build')
    expect(stub.note).toBe('取自真实响应')
    expect(service.listStubs().map((item) => item.payload)).toEqual([{ corpus: 'v2' }])

    expect(service.deleteStub('corpus.build')).toEqual({ deleted: true })
    expect(service.listStubs()).toEqual([])
    expect(service.deleteStub('corpus.build')).toEqual({ deleted: false })
    expect(() => service.setStub('坏 id', {})).toThrow(/能力标识不合法/)
  })

  test('给不存在的场景记运行会被拒绝（历史不该挂在不存在的场景上）', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cap-factory-run-'))
    const service = new CapabilityFactoryService({ store: new CapabilityFactoryStore(rootDir) })

    expect(() => service.recordRun({
      id: 'run-1', sceneId: 'missing', sceneVersion: 1, status: 'failed', valid: false,
      input: {}, outputs: null, steps: [], startedAt: 0, finishedAt: 1,
    })).toThrow(/场景不存在/)
  })
})

describe('单步试跑：训练提示词不需要整条链可跑', () => {
  test('Given 上游是工具步骤且没绑桩 When 单跑抽取步骤 Then 照样跑通，且记录标成 step', async () => {
    const { service, runner, calls } = fixture()
    /** 故意不绑桩：单步试跑绕开上游，这正是它存在的理由。 */
    expect(service.listStubs()).toEqual([])

    const attempt = await runner.runStep('scene-1', 'scan', { corpus: '第 1 段：阿明抬头。' })

    expect(attempt.kind).toBe('step')
    expect(attempt.stepId).toBe('scan')
    expect(attempt.status).toBe('succeeded')
    expect(attempt.valid).toBe(true)
    expect(attempt.steps).toHaveLength(1)
    /** 提示词模板原文要落进记录：对比两次尝试时 diff 的就是它。 */
    expect(attempt.stepPrompt).toBe('从 {{corpus}} 里找出人物候选')
    expect(calls[0]?.prompt).toContain('阿明抬头')
    /** 单步试跑不产出场景输出。 */
    expect(attempt.outputs).toBeNull()
  })

  test('Given 弹窗里改了提示词 When 单跑 Then 用编辑中的那份跑，且不落盘、不推进版本', async () => {
    const { service, runner, calls } = fixture()
    const current = service.getScene('scene-1')
    if (!current) throw new Error('夹具里应当有 scene-1')
    const edited: CapabilitySceneDefinition = {
      ...current.definition,
      steps: current.definition.steps.map((step) =>
        step.id === 'scan' && step.type === 'extract' ? { ...step, prompt: '改过的提示词：{{corpus}}' } : step),
    }

    const attempt = await runner.runStep('scene-1', 'scan', { corpus: '正文' }, edited)

    expect(calls[0]?.prompt).toContain('改过的提示词')
    expect(attempt.stepPrompt).toBe('改过的提示词：{{corpus}}')
    /** 关键：试跑不写场景定义 —— 版本还停在 v2。 */
    expect(service.getScene('scene-1')?.currentVersion).toBe(2)
    expect(service.getScene('scene-1')?.draft).toBeNull()
  })

  test('Given 目标是 tool 步骤 When 单跑 Then 记一条失败并说明"这一步没有提示词"', async () => {
    const { runner } = fixture()

    const attempt = await runner.runStep('scene-1', 'build', { text: '正文' })

    expect(attempt.status).toBe('failed')
    expect(attempt.error).toContain('没有提示词')
    expect(attempt.steps).toEqual([])
  })

  test('Given 约束不通过 When 单跑 Then valid=false 且带上约束原因（训练要看的正是这个）', async () => {
    const { service, runner } = fixture({ modelText: '{"characters":"不是数组"}' })
    service.setStub('corpus.build', { corpus: '正文' })

    const attempt = await runner.runStep('scene-1', 'scan', { corpus: '正文' })

    expect(attempt.valid).toBe(false)
    expect(attempt.steps[0]?.status).toBe('invalid')
    expect(attempt.steps[0]?.constraintErrors?.length ?? 0).toBeGreaterThan(0)
  })

  test('提交历史按 kind 分开：单步试跑不会混进整链运行的历史', async () => {
    const { service, runner } = fixture()
    service.setStub('corpus.build', { corpus: '正文' })

    await runner.run('scene-1', { chapterText: '第一章' })
    await runner.runStep('scene-1', 'scan', { corpus: '正文' })
    await runner.runStep('scene-1', 'scan', { corpus: '正文二' })

    expect(service.listRuns('scene-1', 20, 'full')).toHaveLength(1)
    expect(service.listRuns('scene-1', 20, 'step')).toHaveLength(2)
    expect(service.listRuns('scene-1')).toHaveLength(3)
  })
})
