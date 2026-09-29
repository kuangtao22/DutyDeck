import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CapabilityRun } from '@proma/shared'
import { CapabilityFactoryAttemptCompare } from './CapabilityFactoryAttemptCompare'

/** 造一次单步尝试。 */
function attempt(overrides: Partial<CapabilityRun> = {}): CapabilityRun {
  return {
    id: 'run', sceneId: 'scene-1', sceneVersion: 2, kind: 'step', stepId: 'scan',
    status: 'succeeded', valid: true, input: { corpus: '第 1 段' }, outputs: null,
    steps: [{
      stepId: 'scan', title: '扫描人物候选', type: 'extract', status: 'succeeded', attempts: 1,
      input: { corpus: '第 1 段' }, rawOutput: '{"characters":[]}', parsedOutput: { characters: [] },
      startedAt: 0, finishedAt: 100,
    }],
    startedAt: 0, finishedAt: 100,
    ...overrides,
  }
}

/** 渲染对比视图。 */
function render(baseline: CapabilityRun, current: CapabilityRun): string {
  return renderToStaticMarkup(<CapabilityFactoryAttemptCompare baseline={baseline} current={current} />)
}

describe('两次尝试对比', () => {
  test('Given 两次都有自动评测 When 对比 Then 表头显示质量从未达标到达标', () => {
    const baseReview = {
      status: 'succeeded' as const, passed: false, summary: '证据不足',
      acceptance: { criteria: [], judgePrompt: '评审', metrics: [] },
      criteria: [], metrics: [], suggestions: [], startedAt: 1, finishedAt: 2,
    }
    const html = render(
      attempt({ review: baseReview }),
      attempt({ review: { ...baseReview, passed: true, summary: '证据完整' } }),
    )

    expect(html).toContain('质量：未达标 → 达标')
    expect(html).not.toContain('评审标准已变化')
  })

  test('Given 两次的评审快照不同 When 对比 Then 提示质量变化不能直接归因于提示词', () => {
    const baseReview = {
      status: 'succeeded' as const, passed: false, summary: '证据不足',
      acceptance: { criteria: ['有姓名即可'], judgePrompt: '宽松评审', metrics: [] },
      criteria: [], metrics: [], suggestions: [], startedAt: 1, finishedAt: 2,
    }
    const html = render(
      attempt({ review: baseReview }),
      attempt({ review: {
        ...baseReview,
        passed: true,
        acceptance: { ...baseReview.acceptance, criteria: ['姓名与原文证据都必须完整'] },
      } }),
    )

    expect(html).toContain('评审标准已变化')
    expect(html).toContain('不能把结论变化直接归因于提示词')
  })

  test('Given 旧记录没有评测 When 对比 Then 不凭空标记达标', () => {
    const html = render(attempt(), attempt())

    expect(html).toContain('质量：未评测 → 未评测')
    expect(html).not.toContain('质量：达标')
  })

  test('Given 改了提示词 When 渲染 Then 逐行标出增删并给出增删行数', () => {
    const html = render(
      attempt({ stepPrompt: '找出人物\n输出 JSON' }),
      attempt({ stepPrompt: '找出人物，必须带段落引用\n输出 JSON' }),
    )

    expect(html).toContain('提示词变化')
    expect(html).toContain('新增 1 行 · 删除 1 行')
    expect(html).toContain('- 找出人物')
    expect(html).toContain('+ 找出人物，必须带段落引用')
  })

  test('Given 提示词没变 When 渲染 Then 明说差异不是来自提示词（避免错归因）', () => {
    const html = render(attempt({ stepPrompt: '同一段' }), attempt({ stepPrompt: '同一段' }))

    expect(html).toContain('没有变化')
    expect(html).toContain('这次的差异不是来自提示词')
  })

  test('Given 输入变了 When 渲染 Then 指名哪个槽变了，并提示结果差异可能来自输入', () => {
    const html = render(
      attempt({ input: { corpus: '第 1 段' } }),
      attempt({ input: { corpus: '第 2 段' } }),
    )

    expect(html).toContain('变了 corpus')
    expect(html).toContain('结果差异可能是输入造成的')
  })

  test('Given 约束结论变了 When 渲染 Then 写成"从什么到什么"，并带上两份返回', () => {
    const html = render(
      attempt({ valid: false, steps: [{
        stepId: 'scan', title: '扫描', type: 'extract', status: 'invalid', attempts: 1, input: {},
        rawOutput: '{"characters":"不是数组"}', constraintErrors: ['characters: 期望数组'],
        startedAt: 0, finishedAt: 1,
      }] }),
      attempt(),
    )

    expect(html).toContain('约束不通过：characters: 期望数组 → 约束通过')
    expect(html).toContain('基线的返回')
    expect(html).toContain('这次的返回')
    expect(html).toContain('不是数组')
  })
})
