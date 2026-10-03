import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createEmptySceneDefinition } from '@proma/shared'
import type { CapabilityRun } from '@proma/shared'
import { CapabilityFactoryRunResult, type CapabilityFactoryRunResultProps } from './CapabilityFactoryRunResult'

/** 一次成功但约束不通过的运行：两轴给出不同结论，正是最容易被做错的那种。 */
function run(overrides: Partial<CapabilityRun> = {}): CapabilityRun {
  return {
    id: 'run-1', sceneId: 'scene-1', sceneVersion: 2, status: 'partial', valid: false,
    input: { chapterText: '第一章……' },
    outputs: { characters: { characters: [{ name: '阿明' }] } },
    steps: [
      {
        stepId: 'build', title: '构建批次正文', type: 'tool', status: 'succeeded', attempts: 1,
        input: { text: '第一章……' }, parsedOutput: { corpus: '第 1 段' }, startedAt: 0, finishedAt: 120,
      },
      {
        stepId: 'scan', title: '扫描人物候选', type: 'extract', status: 'invalid', attempts: 2,
        input: { corpus: '第 1 段' }, prompt: '从 {{corpus}} 里找出人物候选',
        rawOutput: '这不是 JSON', constraintErrors: ['characters: 期望数组'],
        model: 'deepseek-v4-flash', startedAt: 120, finishedAt: 1500,
      },
    ],
    modelBindings: [{
      slotId: 'main', declaredModel: 'gpt-5.4',
      channelId: 'ch-1', channelName: '传贝-DeepSeek', modelId: 'deepseek-v4-flash', substituted: true,
    }],
    startedAt: 0, finishedAt: 1500,
    ...overrides,
  }
}

/** 渲染结果视图，可指定单步试跑的展开方式。 */
function render(record: CapabilityRun = run(), props: Omit<CapabilityFactoryRunResultProps, 'run'> = {}): string {
  return renderToStaticMarkup(<CapabilityFactoryRunResult run={record} {...props} />)
}

describe('运行结果视图', () => {
  test('Given 步骤进度回传 When 运行中 Then 左侧步骤显示实时动画与等待状态', () => {
    const definition = createEmptySceneDefinition('实时进度')
    definition.steps = [
      { type: 'llm', id: 'scan', title: '扫描人物候选', modelSlot: 'main', prompt: '扫描' },
      { type: 'llm', id: 'merge', title: '汇总人物信息', modelSlot: 'main', prompt: '汇总' },
    ]
    const html = render(run({
      status: 'running', valid: false, outputs: null, finishedAt: null,
      activeStepIds: ['scan'], definitionSnapshot: definition, steps: [],
    }))

    expect(html).toContain('实时进度')
    expect(html).toContain('扫描人物候选')
    expect(html).toContain('汇总人物信息')
    expect(html).toContain('运行中')
    expect(html).toContain('等待')
    expect(html).toContain('animate-spin')
    expect(html).not.toContain('输出未通过约束')
    expect(html).not.toContain('没有步骤被执行')
    expect(html).toContain('motion-reduce:animate-none')
  })

  test('Given 执行失败或评审失败 When 查看导航 Then 不再保留运行动画', () => {
    expect(render(run({ status: 'failed' }))).not.toContain('animate-spin')
    expect(render(run({ status: 'succeeded', review: {
      status: 'failed', passed: null, summary: '评审失败', criteria: [], metrics: [], suggestions: [],
      acceptance: { criteria: [], judgePrompt: '', metrics: [] }, startedAt: 0, finishedAt: 1,
    } }))).not.toContain('animate-spin')
  })

  test('Given 运行结果 When 提供主操作 Then 开始运行显示在状态行右侧区域', () => {
    const html = render(run(), { actions: <button type="button">开始运行</button> })
    expect(html).toContain('开始运行')
    expect(html.indexOf('开始运行')).toBeGreaterThan(html.indexOf('v2'))
  })

  test('Given 历史运行记录 When 查看结果 Then 显示运行短 ID 与开始时间，避免混淆不同记录', () => {
    const html = render(run())
    expect(html).toContain('记录 run-1')
    expect(html).toContain('1970/1/1')
  })

  test('Given 评审标准归场景定义 When 查看运行 Then 不再显示独立标准导航且保留评审结果', () => {
    const html = render(run())
    expect(html).not.toContain('>评审标准</button>')
    expect(html).toContain('自动评审')
    expect(html).toContain('任务输入')
  })
  test('Given 当前会话中的已完成评审 When 展示 Then 提供本轮优化入口；评审异常和无会话时不显示', () => {
    const reviewed = run({ status: 'succeeded', valid: true, review: {
      status: 'succeeded', passed: false, summary: '证据不足', criteria: [], metrics: [], suggestions: [], startedAt: 1, finishedAt: 2,
      acceptance: { criteria: ['有证据'], judgePrompt: '核对证据', metrics: [] },
    } })
    const optimizationContext = { sessionId: 's1', sceneName: '角色提取' }
    expect(render(reviewed, { optimizationContext })).toContain('基于本轮优化')
    expect(render(reviewed)).not.toContain('基于本轮优化')
    expect(render({ ...reviewed, review: { ...reviewed.review!, status: 'failed' } }, { optimizationContext })).not.toContain('基于本轮优化')
  })
  test('Given 运行后评测未达标 When 渲染 Then 首屏优先显示结论、失败判据与改进建议', () => {
    const html = render(run({
      status: 'succeeded', valid: true,
      review: {
        status: 'succeeded', passed: false,
        summary: '人物已提取，但身份证据不足。',
        acceptance: {
          criteria: ['每个人物必须有原文证据'], judgePrompt: '检查角色证据',
          metrics: [{ name: '证据完整率', weight: 1, direction: 'positive' }],
        },
        criteria: [
          { criterion: '每个人物必须有原文证据', passed: false, evidence: '王进缺少 paragraphRef' },
          { criterion: '不得编造人物', passed: true, evidence: '所有人名均可回溯' },
        ],
        metrics: [{ name: '证据完整率', value: 0.5, evidence: '1/2 有完整证据' }],
        suggestions: ['提示词中强制每个人物返回 paragraphRef'],
        startedAt: 1_500, finishedAt: 1_800,
      },
    }))

    expect(html).toContain('未达标')
    expect(html).toContain('人物已提取，但身份证据不足。')
    expect(html).toContain('王进缺少 paragraphRef')
    expect(html).toContain('提示词中强制每个人物返回 paragraphRef')
    expect(html).not.toContain('所有人名均可回溯')
    expect(html).toContain('评测细项')
  })

  test('Given 已自动评测 When 首屏渲染 Then 默认选中评审而不挂载输出正文', () => {
    const html = render(run({
      status: 'succeeded', valid: true,
      review: {
        status: 'succeeded', passed: true, summary: '证据可追溯。',
        acceptance: { criteria: [], judgePrompt: '评审', metrics: [] },
        criteria: [], metrics: [], suggestions: [], startedAt: 1_500, finishedAt: 1_700,
      },
    }))

    expect(html).toContain('本次输出')
    expect(html).not.toContain('阿明')
  })

  test('Given 旧运行记录没有评测 When 渲染 Then 标记未评测且保持输出可见', () => {
    const html = render(run({ status: 'succeeded', valid: true }))

    expect(html).toContain('未评测')
    expect(html).toContain('阿明')
    expect(html).not.toContain('达标</')
  })

  test('Given 单步试跑有评审 When 渲染 Then 明确结论只覆盖当前步骤', () => {
    const html = render(run({
      kind: 'step', stepId: 'scan', status: 'succeeded', valid: true,
      steps: [run().steps[1]!],
      review: {
        status: 'succeeded', passed: true, summary: '人物证据完整。',
        acceptance: { criteria: [], judgePrompt: '评审', metrics: [] },
        criteria: [], metrics: [], suggestions: [], startedAt: 1_500, finishedAt: 1_700,
      },
    }))

    expect(html).toContain('当前步骤评审')
    expect(html).toContain('不代表整个场景已达标')
  })

  test('Given 自动评测进行中 When 渲染主状态 Then 不再突出绿色完成', () => {
    const html = render(run({
      status: 'succeeded', valid: true,
      review: {
        status: 'running', passed: null, summary: '',
        acceptance: { criteria: [], judgePrompt: '评审', metrics: [] },
        criteria: [], metrics: [], suggestions: [], startedAt: 1_500, finishedAt: null,
      },
    }))

    expect(html.match(/评测中/g)?.length).toBe(1)
    /** 主状态仍在评审；步骤导航可以如实标注已完成的业务步骤。 */
    expect(html.slice(0, html.indexOf('role="tablist"'))).not.toContain('>完成</')
  })

  test('Given 未通过判据与建议很多 When 渲染首屏 Then 合计最多显示三项，其余收进细项', () => {
    const html = render(run({
      status: 'succeeded', valid: true,
      review: {
        status: 'succeeded', passed: false, summary: '存在多项问题。',
        acceptance: { criteria: [], judgePrompt: '评审', metrics: [] },
        criteria: [1, 2, 3, 4].map((index) => ({
          criterion: `判据${index}`, passed: false, evidence: `证据${index}`,
        })),
        metrics: [], suggestions: ['建议1', '建议2', '建议3'], startedAt: 1_500, finishedAt: 1_700,
      },
    }))

    expect(html).toContain('判据1')
    expect(html).toContain('判据2')
    expect(html).toContain('建议1')
    expect(html).not.toContain('判据3')
    expect(html).not.toContain('建议2')
    expect(html).toContain('其余 4 项在评测细项中')
  })

  test('Given 部分完成且约束不通过 When 渲染 Then 两条轴各给一个徽标，不合并成一个结论', () => {
    const html = render()

    expect(html).toContain('部分完成')
    expect(html).toContain('约束不通过')
    expect(html).toContain('v2')
    expect(html).toContain('1.5s')
  })

  test('Given 查看步骤 When 渲染 Then 显示步骤模型，运行模型绑定放在输出和评审底部', () => {
    const stepHtml = render(run(), { initiallyOpenStepId: 'scan' })
    const html = render(run())

    expect(stepHtml).toContain('deepseek-v4-flash')
    expect(html).toContain('aria-label="当前使用模型"')
    expect(html).toContain('传贝-DeepSeek/deepseek-v4-flash（替代声明 gpt-5.4）')
    expect(html).not.toContain('模型信息')
    expect(stepHtml).not.toContain('main: gpt-5.4 →')
  })

  test('Given 用了占位桩 When 渲染 Then 结论行说明"只验证了流程"，且约束不再显示成绿灯', () => {
    const html = render(run({ placeholderCapabilities: ['corpus.build'] }))

    expect(html).toContain('只验证了流程')
    expect(html).toContain('不可采信')
    expect(html).toContain('占位桩：corpus.build')
  })

  test('Given 没跑起来 When 渲染 Then 结论行给出下一步而不是只显示失败', () => {
    const html = render(run({ status: 'failed', steps: [], outputs: null, error: '没有可用的模型渠道' }))

    expect(html).toContain('没跑起来')
    expect(html).toContain('先按上面的原因修掉')
  })

  test('Given 有多个步骤 When 默认渲染 Then 左侧目录列出步骤，右侧只显示本次输出', () => {
    const html = render()

    expect(html).toContain('aria-label="运行详情导航"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('构建批次正文')
    expect(html).toContain('扫描人物候选')
    expect(html).not.toContain('从 {{corpus}} 里找出人物候选')
    expect(html).not.toContain('渲染后的完整提示词')
  })

  test('Given 单步试跑 When 展示结果 Then 模型返回只出现一次且不重复输入', () => {
    /** 从基准记录取出目标步骤，避免测试夹具用数组位置表达业务语义。 */
    const scanStep = run().steps.find((step) => step.stepId === 'scan')
    if (!scanStep) throw new Error('测试夹具缺少 scan 步骤')
    /** 单步记录只保留被训练的步骤。 */
    const record = run({
      kind: 'step', stepId: 'scan', outputs: { scan: '这不是 JSON' },
      steps: [scanStep],
    })
    const html = render(record, { initiallyOpenStepId: 'scan', hideStepInput: true })

    expect(html).toContain('模型返回')
    expect(html.match(/这不是 JSON/g)?.length).toBe(1)
    expect(html).not.toContain('>步骤输出</')
    expect(html).not.toContain('>步骤输入</')
    expect(html).toContain('提示词')
    expect(html).not.toContain('从 {{corpus}} 里找出人物候选')
    expect(html.match(/characters: 期望数组/g)?.length).toBe(1)
  })

  test('Given 有输出 When 渲染 Then 本次输出按 JSON 展示', () => {
    const html = render()

    expect(html).toContain('本次输出')
    expect(html).toContain('阿明')
    expect(html).toContain('data-task-editor="json"')
    expect(html).toContain('readonly=""')
    expect(html).not.toContain('格式化 JSON')
    expect(html).toContain('data-run-detail-header="true"')
  })

  test('Given 真实运行格式通过 When 首屏渲染 Then 不把格式通过表述成内容质量合格', () => {
    const html = render(run({ status: 'succeeded', valid: true }))

    expect(html).toContain('输出格式符合约束，内容质量需另行评审。')
    expect(html).not.toContain('内容质量合格')
  })

  test('Given 一步都没跑 When 渲染 Then 说明原因位置，而不是空白', () => {
    const html = render(run({ status: 'failed', steps: [], outputs: null, error: '输入不满足输入契约：chapterText 缺少必填输入' }))

    expect(html).toContain('输入不满足输入契约')
    expect(html).toContain('没有步骤被执行')
    expect(html).toContain('没有产出（运行未完成）')
  })
})
