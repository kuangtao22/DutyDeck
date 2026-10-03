import { describe, expect, test } from 'bun:test'
import { createEmptySceneDefinition } from '@proma/shared'
import type { CapabilityRun, FieldSchema } from '@proma/shared'
import {
  buildStepRunInput, describeConstraintAxis, describeReviewStatus, describeRunStatus, describeRunVerdict, describeStepSlots,
  describeSceneShape, describeStepStatus, describeRunStepNavigation, formatDuration, initialFieldDraft, initialStepRunDraft, inputFieldKind,
  isPromptStep, namedFields, parseWorkflowInput, stubSkeleton, type NamedField,
} from './capability-factory-run-view'
import type { Step } from '@proma/shared'

/** 造一条最小运行记录，只关心被断言的状态轴。 */
function run(overrides: Partial<CapabilityRun> = {}): CapabilityRun {
  return {
    id: 'run-1', sceneId: 'scene-1', sceneVersion: 2, status: 'succeeded', valid: true,
    input: {}, outputs: null, steps: [], startedAt: 0, finishedAt: 1500,
    ...overrides,
  }
}

describe('运行视图文案', () => {
  test('Given 并行子步骤先于父组完成 When 构建目录 Then 保留真实轨迹索引、重复项及活跃项', () => {
    /** 定义顺序与完成顺序不同，点击父组仍须定位它自己的轨迹。 */
    const definition = createEmptySceneDefinition('并行场景')
    definition.steps = [{ id: 'each', title: '并行组', type: 'map', over: { from: 'workflow-input', field: 'items' }, body: [
      { id: 'extract', title: '提取', type: 'llm', modelSlot: 'main', prompt: '{{item}}', inputs: {} },
    ] }, { id: 'merge', title: '汇总', type: 'llm', modelSlot: 'main', prompt: '', inputs: {} }]
    const record = run({ status: 'running', definitionSnapshot: definition, activeStepIds: ['each', 'extract'], steps: [
      { stepId: 'extract', title: '提取', type: 'llm', status: 'succeeded', attempts: 1, input: {}, startedAt: 0, finishedAt: 1 },
    ] })
    expect(describeRunStepNavigation(record).map((item) => [item.stepId, item.traceIndex, item.active])).toEqual([
      ['each', null, true], ['extract', 0, false], ['extract', null, true], ['merge', null, false],
    ])
    record.status = 'failed'
    record.steps.push({ ...record.steps[0]!, status: 'failed' }, {
      stepId: 'each', title: '并行组', type: 'map', status: 'failed', attempts: 1, input: {}, startedAt: 0, finishedAt: 2,
    })
    expect(describeRunStepNavigation(record).map((item) => [item.stepId, item.traceIndex, item.active])).toEqual([
      ['each', 2, false], ['extract', 0, false], ['extract', 1, false], ['merge', null, false],
    ])
    record.kind = 'step'
    record.stepId = 'extract'
    expect(describeRunStepNavigation(record).map((item) => item.traceIndex)).toEqual([0, 1])
  })

  test('完整性轴与约束轴分列：代码跑完但约束不通过时，两个标签给出相反结论', () => {
    const partial = run({ status: 'partial', valid: false })

    expect(describeRunStatus(partial)).toEqual({ label: '部分完成', tone: 'warn' })
    expect(describeConstraintAxis(partial)).toEqual({ label: '约束不通过', tone: 'bad' })
  })

  test('运行中的步骤不提前显示约束通过或失败', () => {
    const running = run({ status: 'running', valid: false, activeStepIds: ['extract'] })

    expect(describeConstraintAxis(running)).toEqual({ label: '约束检查中', tone: 'idle' })
    expect(describeRunVerdict(running)).toContain('正在执行')
  })

  test('含占位桩时不给绿灯：空值跑出来的"约束通过"标成不可采信', () => {
    const withPlaceholder = run({ placeholderCapabilities: ['corpus.build'] })

    expect(describeConstraintAxis(withPlaceholder)).toEqual({
      label: '约束通过（含占位桩，不可采信）', tone: 'warn',
    })
    /** 真实桩才给 ok。 */
    expect(describeConstraintAxis(run())).toEqual({ label: '约束通过', tone: 'ok' })
  })

  test('步骤状态四态各有中文标签，且不合法不等于失败', () => {
    expect(describeStepStatus('succeeded').label).toBe('完成')
    expect(describeStepStatus('invalid')).toEqual({ label: '不合法', tone: 'warn' })
    expect(describeStepStatus('failed').tone).toBe('bad')
    expect(describeStepStatus('skipped').tone).toBe('idle')
  })

  test('质量轴区分评测中、达标、未达标、待确认、评测失败与未评测', () => {
    const review = {
      status: 'succeeded' as const,
      passed: true,
      summary: '角色及证据可追溯。',
      acceptance: { criteria: ['角色有原文证据'], judgePrompt: '评审输出', metrics: [] },
      criteria: [], metrics: [], suggestions: [], startedAt: 1, finishedAt: 2,
    }

    expect(describeReviewStatus(run({ review: { ...review, status: 'running', passed: null, finishedAt: null } })))
      .toEqual({ label: '评测中', tone: 'idle' })
    expect(describeReviewStatus(run({ review }))).toEqual({ label: '达标', tone: 'ok' })
    expect(describeReviewStatus(run({ review: { ...review, passed: false } }))).toEqual({ label: '未达标', tone: 'bad' })
    expect(describeReviewStatus(run({ review: { ...review, passed: null } }))).toEqual({ label: '待确认', tone: 'warn' })
    expect(describeReviewStatus(run({ evidenceIssues: ['证据无法回溯'], review })))
      .toEqual({ label: '证据待确认', tone: 'warn' })
    expect(describeReviewStatus(run({ review: { ...review, status: 'failed', passed: null } })))
      .toEqual({ label: '评测失败', tone: 'bad' })
    expect(describeReviewStatus(run())).toEqual({ label: '未评测', tone: 'idle' })
  })

  test('运行失败时优先呈现执行事实，不把评审字段误读为质量不达标', () => {
    const failed = run({
      status: 'failed', valid: false,
      review: {
        status: 'succeeded', passed: false, summary: '无法评审',
        acceptance: { criteria: [], judgePrompt: '', metrics: [] },
        criteria: [], metrics: [], suggestions: [], startedAt: 1, finishedAt: 2,
      },
    })

    expect(describeReviewStatus(failed)).toEqual({ label: '未评测', tone: 'idle' })
  })

  test('评测达标的前提是整轮成功、约束有效且未使用占位桩', () => {
    const passedReview = {
      status: 'succeeded' as const, passed: true, summary: '评测通过',
      acceptance: { criteria: [], judgePrompt: '评审', metrics: [] },
      criteria: [], metrics: [], suggestions: [], startedAt: 1, finishedAt: 2,
    }

    expect(describeReviewStatus(run({ status: 'partial', review: passedReview }))).toEqual({ label: '待确认', tone: 'warn' })
    expect(describeReviewStatus(run({ valid: false, review: passedReview }))).toEqual({ label: '待确认', tone: 'warn' })
    expect(describeReviewStatus(run({ placeholderCapabilities: ['corpus.build'], review: passedReview })))
      .toEqual({ label: '待确认', tone: 'warn' })
    expect(describeRunVerdict(run({ status: 'partial', steps: [{
      stepId: 'a', title: 'a', type: 'extract', status: 'succeeded', attempts: 1,
      input: {}, startedAt: 0, finishedAt: 1,
    }], review: passedReview }))).not.toContain('自动评测已达标')
  })

  test('时长按量级换单位，缺结束时间时不给假数字', () => {
    expect(formatDuration(0, 820)).toBe('820ms')
    expect(formatDuration(0, 1500)).toBe('1.5s')
    expect(formatDuration(0, 75_000)).toBe('1m15s')
    expect(formatDuration(0, null)).toBe('—')
  })

  test('结论与下一步：占位桩说明"只验证了流程"，真实桩才谈质量', () => {
    const placeholder = describeRunVerdict(run({
      placeholderCapabilities: ['corpus.build', 'anchor.ground'],
      steps: [{
        stepId: 'a', title: 'a', type: 'tool', status: 'succeeded', attempts: 1, input: {},
        startedAt: 0, finishedAt: 1,
      }],
    }))
    expect(placeholder).toContain('只验证了流程')
    expect(placeholder).toContain('不可采信')
    expect(placeholder).toContain('换')

    const real = describeRunVerdict(run({ steps: [{
      stepId: 'a', title: 'a', type: 'tool', status: 'succeeded', attempts: 1, input: {},
      startedAt: 0, finishedAt: 1,
    }] }))
    expect(real).toContain('旧运行记录')
    expect(real).toContain('没有自动评测')

    expect(describeRunVerdict(run({ valid: false, steps: [{
      stepId: 'a', title: 'a', type: 'extract', status: 'invalid', attempts: 1, input: {},
      startedAt: 0, finishedAt: 1,
    }] }))).toContain('没通过约束')

    expect(describeRunVerdict(run({ status: 'failed', steps: [] }))).toContain('没跑起来')
  })

  test('运行详情按自动评测状态说明结论，不再让人工去判断质量', () => {
    const baseReview = {
      status: 'succeeded' as const, passed: true, summary: '证据完整',
      acceptance: { criteria: [], judgePrompt: '评审', metrics: [] },
      criteria: [], metrics: [], suggestions: [], startedAt: 1, finishedAt: 2,
    }
    const withStep = { steps: [{
      stepId: 'a', title: 'a', type: 'extract' as const, status: 'succeeded' as const, attempts: 1,
      input: {}, startedAt: 0, finishedAt: 1,
    }] }

    expect(describeRunVerdict(run({ ...withStep, review: baseReview }))).toContain('自动评测已达标')
    expect(describeRunVerdict(run({ ...withStep, review: { ...baseReview, passed: false } }))).toContain('自动评测未达标')
    expect(describeRunVerdict(run({ ...withStep, review: { ...baseReview, passed: null } }))).toContain('仍有待确认项')
    expect(describeRunVerdict(run({ ...withStep, review: { ...baseReview, status: 'running', passed: null, finishedAt: null } })))
      .toContain('自动评测仍在进行')
    expect(describeRunVerdict(run({ ...withStep, review: { ...baseReview, status: 'failed', passed: null } })))
      .toContain('自动评测失败')
    expect(describeRunVerdict(run({ ...withStep, evidenceIssues: ['evidence 错位'], review: baseReview })))
      .toContain('证据引用无法逐字回溯')
  })
})

describe('运行输入表单', () => {
  const fields: NamedField[] = [
    { name: 'chapterText', type: 'string' },
    { name: 'catalogIndex', type: 'number' },
    { name: 'existingSnapshot', type: 'object' },
    { name: 'knownCharacters', type: 'array' },
    { name: 'dryRun', type: 'boolean' },
  ]

  test('对象与数组按 JSON 解析，字符串原样、数字转数字、布尔转布尔', () => {
    const definition = { ...createEmptySceneDefinition('小说角色提取'), inputs: fields }
    const parsed = parseWorkflowInput(definition, {
      chapterText: '第一章 正文……',
      catalogIndex: '12',
      existingSnapshot: '{"count":3}',
      knownCharacters: '[{"name":"阿明"}]',
      dryRun: 'true',
    })

    expect(parsed.errors).toEqual([])
    expect(parsed.input).toEqual({
      chapterText: '第一章 正文……',
      catalogIndex: 12,
      existingSnapshot: { count: 3 },
      knownCharacters: [{ name: '阿明' }],
      dryRun: true,
    })
  })

  test('坏输入就地报错，而不是把坏值塞进运行', () => {
    const definition = { ...createEmptySceneDefinition('小说角色提取'), inputs: fields }
    const parsed = parseWorkflowInput(definition, {
      catalogIndex: '十二章',
      existingSnapshot: '{count:3}',
      dryRun: 'yes',
    })

    expect(parsed.errors).toEqual([
      'catalogIndex 需要数字',
      'existingSnapshot 需要合法 JSON',
      'dryRun 需要 true 或 false',
    ])
    expect(parsed.input).toEqual({})
  })

  test('空着的字段不提交：缺必填由运行时的输入契约来判定，口径只留一处', () => {
    const definition = { ...createEmptySceneDefinition('小说角色提取'), inputs: fields }
    const parsed = parseWorkflowInput(definition, { chapterText: '   ' })

    expect(parsed.errors).toEqual([])
    expect(parsed.input).toEqual({})
  })

  test('控件种类：数字与布尔单行，对象数组走 JSON，字符串走多行', () => {
    expect(['chapterText', 'catalogIndex', 'existingSnapshot', 'knownCharacters', 'dryRun']
      .map((name) => inputFieldKind(fields.find((field) => field.name === name) as NamedField)))
      .toEqual(['text', 'number', 'json', 'json', 'boolean'])
    expect(initialFieldDraft(fields[1] as NamedField)).toBe('')
    expect(initialFieldDraft(fields[3] as NamedField)).toBe('[]')
    expect(initialFieldDraft(fields[4] as NamedField)).toBe('false')
  })

  test('无名字段不进表单、也不参与必填计数（它在运行时的契约里校验不了）', () => {
    const definition = {
      ...createEmptySceneDefinition('小说角色提取'),
      inputs: [{ type: 'string' as const }, { name: 'chapterText', type: 'string' as const }],
    }

    expect(namedFields(definition.inputs).map((field) => field.name)).toEqual(['chapterText'])
    expect(parseWorkflowInput(definition, { chapterText: '正文' }).input).toEqual({ chapterText: '正文' })
  })
})

describe('虚拟接入骨架', () => {
  test('按 outputSchema 生成同名字段的骨架，值留空（形状提示，不是桩本身）', () => {
    const skeleton = JSON.parse(stubSkeleton([
      { name: 'corpusText', type: 'string' },
      { name: 'paragraphCount', type: 'number' },
      { name: 'characters', type: 'array' },
      { name: 'meta', type: 'object', fields: [{ name: 'hash', type: 'string' }] },
    ]))

    expect(skeleton).toEqual({ corpusText: '', paragraphCount: 0, characters: [], meta: { hash: '' } })
  })

  test('能力没有声明输出时给出空对象，而不是报错', () => {
    expect(stubSkeleton(undefined)).toBe('{}')
  })
})

describe('单步试跑（提示词训练主回路）', () => {
  /** 一个抽取步骤 + 一个工具步骤：前者能训练，后者只能看契约。 */
  const extractStep: Step = {
    id: 'scan', title: '扫描人物候选', type: 'extract', modelSlot: 'main',
    prompt: '从 {{corpus}} 里找出人物，并与 {{known}} 去重',
    inputs: {
      corpus: { from: 'step-output', stepId: 'build' },
      known: { from: 'workflow-input', field: 'knownCharacters' },
    },
    judgeFields: [{ name: 'characters', type: 'array' }],
  }
  const toolStep: Step = {
    id: 'build', title: '构建批次正文', type: 'tool', capabilityId: 'corpus.build',
    bindings: { text: { from: 'workflow-input', field: 'chapterText' } },
  }

  test('只有带提示词的步骤能试跑；tool 步骤没有提示词可训练', () => {
    expect(isPromptStep(extractStep)).toBe(true)
    expect(isPromptStep(toolStep)).toBe(false)
    expect(isPromptStep({ id: 'm', title: '并行组', type: 'map', over: { from: 'workflow-input', field: 'x' }, body: [] })).toBe(false)
  })

  test('输入槽写清"平时从哪来"：上一步输出 / 工作流输入 / 固定值', () => {
    expect(describeStepSlots(extractStep)).toEqual([
      { name: 'corpus', hint: '上一步输出 · build' },
      { name: 'known', hint: '工作流输入 · knownCharacters' },
    ])
    expect(describeStepSlots({ ...extractStep, inputs: { fixed: { from: 'literal', value: 1 } } }))
      .toEqual([{ name: 'fixed', hint: '固定值' }])
  })

  test('试跑表单默认复用上一次用过的输入 —— 改一句话就重跑时才不用重粘', () => {
    const previous = run({
      kind: 'step', stepId: 'scan',
      input: { corpus: '第 1 段：阿明抬头。', known: [{ name: '祖母' }] },
      steps: [],
    })

    expect(initialStepRunDraft(extractStep, previous)).toEqual({
      corpus: '第 1 段：阿明抬头。',
      known: '[\n  {\n    "name": "祖母"\n  }\n]',
    })
    /** 没有历史时留空，不编造默认值。 */
    expect(initialStepRunDraft(extractStep, null)).toEqual({ corpus: '', known: '' })
  })

  test('输入解析：纯文本就是文本，看起来是 JSON 才按 JSON 解析（解析失败不丢内容）', () => {
    const built = buildStepRunInput(extractStep, {
      corpus: '第 1 段：阿明抬头。',
      known: '[{"name":"祖母"}]',
    })
    expect(built).toEqual({ corpus: '第 1 段：阿明抬头。', known: [{ name: '祖母' }] })

    /** `{` 开头但不是合法 JSON：当纯文本用，人能看到自己粘错了。 */
    expect(buildStepRunInput(extractStep, { corpus: '{这不是 JSON', known: '' }))
      .toEqual({ corpus: '{这不是 JSON', known: '' })
  })
})

describe('场景形状体检：一个场景只该编排模型要做的那部分', () => {
  const extract: Step = {
    id: 'scan', title: '扫描人物候选', type: 'extract', modelSlot: 'main',
    prompt: '从 {{corpus}} 里找出人物', judgeFields: [{ name: 'characters', type: 'array' }],
  }
  const tool = (id: string, title: string): Step => ({
    id, title, type: 'tool', capabilityId: id, bindings: {},
  })

  test('Given 只编排模型步骤 When 体检 Then 不给建议（形状是对的）', () => {
    const shape = describeSceneShape({ ...createEmptySceneDefinition('小说角色提取'), steps: [extract] })

    expect(shape).toEqual({
      modelSteps: 1, codeSteps: 0, containerSteps: 0, codeStepTitles: [], advice: null,
    })
  })

  test('Given 把 app 管线搬进了场景 When 体检 Then 指名哪些步骤该移到边界', () => {
    /** 这正是 2026-09-28 那个 4 步场景的形状：1 步模型 + 3 步代码。 */
    const definition = {
      ...createEmptySceneDefinition('小说角色提取'),
      steps: [
        tool('chapter.corpus.build', '构建带段落引用的批次正文'),
        extract,
        tool('anchor.ground', '候选证据逐条落锚到本地正文'),
        tool('character.ledger.merge-preview', '与既有角色合并为候选变更集'),
      ],
    }

    const shape = describeSceneShape(definition)

    expect(shape.modelSteps).toBe(1)
    expect(shape.codeSteps).toBe(3)
    expect(shape.codeStepTitles).toEqual([
      '构建带段落引用的批次正文', '候选证据逐条落锚到本地正文', '与既有角色合并为候选变更集',
    ])
    expect(shape.advice).toContain('有 3 步是代码步骤')
    expect(shape.advice).toContain('移到边界')
    expect(shape.advice).toContain('既训不动提示词')
  })

  test('并行组单独计数，不混进模型步骤或代码步骤', () => {
    const shape = describeSceneShape({
      ...createEmptySceneDefinition('小说角色提取'),
      steps: [{ id: 'batch', title: '逐章处理', type: 'map', over: { from: 'workflow-input', field: 'chapters' }, body: [extract] }],
    })

    expect(shape).toEqual({ modelSteps: 0, codeSteps: 0, containerSteps: 1, codeStepTitles: [], advice: null })
  })
})
