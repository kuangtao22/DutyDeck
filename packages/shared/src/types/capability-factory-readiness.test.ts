import { describe, expect, test } from 'bun:test'
import { describePackageReadiness } from './capability-factory'
import type { CapabilityRun } from './capability-factory'

/** 一次明确通过的自动内容评审。 */
const passedReview: NonNullable<CapabilityRun['review']> = {
  status: 'succeeded', passed: true, summary: '内容符合场景目标',
  acceptance: { criteria: ['结果有原文依据'], judgePrompt: '核对原文依据', metrics: [] },
  criteria: [{ criterion: '结果有原文依据', passed: true, evidence: '已找到对应原文' }],
  metrics: [], suggestions: [], startedAt: 1, finishedAt: 2,
}

/** 一次整链运行；只关心验证判定用到的那几个字段。 */
function run(overrides: Partial<CapabilityRun> = {}): CapabilityRun {
  return {
    id: 'run', sceneId: 'scene-1', sceneVersion: 2, kind: 'full',
    status: 'succeeded', valid: true, input: {}, outputs: null, steps: [],
    review: passedReview,
    startedAt: 0, finishedAt: 10,
    ...overrides,
  }
}

describe('交付前的验证状态', () => {
  test('Given 当前版本在真实数据上跑通过 When 判断 Then 算已验证', () => {
    expect(describePackageReadiness({ sceneVersion: 2, runs: [run()] })).toEqual({ verified: true, reason: null })
  })

  test('Given 模型评审通过但引用无法回溯 When 判断交付 Then 不能作为已验证证据', () => {
    /** 证据问题独立于模型评审，必须阻止孤立 passed=true 为交付背书。 */
    const invalidEvidence = run({ evidenceIssues: ['selectedText 不属于 paragraphRef'] })
    expect(describePackageReadiness({ sceneVersion: 2, runs: [invalidEvidence] }).verified).toBe(false)
    expect(describePackageReadiness({ sceneVersion: 2, runs: [invalidEvidence] }).reason).toContain('证据引用无法回溯')
    expect(describePackageReadiness({ sceneVersion: 2, runs: [invalidEvidence, run({ id: 'good' })] }).verified).toBe(true)
  })

  test('一次都没跑过 / 只跑过旧版本：各自给出可读原因', () => {
    expect(describePackageReadiness({ sceneVersion: 2, runs: [] }))
      .toEqual({ verified: false, reason: '这个场景还没有跑过一次整链运行' })
    expect(describePackageReadiness({ sceneVersion: 2, runs: [run({ sceneVersion: 1 })] }).reason)
      .toBe('v2 还没有跑过 —— 跑通过的是更早的版本')
  })

  test('只用占位桩跑过不算验证：空值跑出来的通过不能当证据', () => {
    const placeholder = run({ placeholderCapabilities: ['corpus.build'] })

    expect(describePackageReadiness({ sceneVersion: 2, runs: [placeholder] }).reason)
      .toContain('用的是占位桩')
  })

  test('跑过但没一次既完成又满足约束：如实说"还没跑通过"', () => {
    const failed = run({ status: 'failed', valid: false })
    const invalid = run({ status: 'succeeded', valid: false })

    expect(describePackageReadiness({ sceneVersion: 2, runs: [failed] }).reason).toContain('还没跑通过')
    expect(describePackageReadiness({ sceneVersion: 2, runs: [invalid] }).verified).toBe(false)
  })

  test('运行和格式通过但旧记录没有内容评审时仍未验证', () => {
    expect(describePackageReadiness({
      sceneVersion: 2,
      runs: [run({ review: undefined })],
    })).toEqual({
      verified: false,
      reason: 'v2 已跑通格式与约束，但还没有完成内容评审',
    })
  })

  test('内容评审进行中、失败、跳过或明确未通过都不能算已验证', () => {
    const review = (status: NonNullable<CapabilityRun['review']>['status'], passed: boolean | null) => ({
      ...passedReview, status, passed,
      ...(status === 'failed' ? { error: '评审模型不可用' } : {}),
    })

    expect(describePackageReadiness({
      sceneVersion: 2, runs: [run({ review: review('running', null) })],
    }).reason).toContain('内容评审还在进行')
    expect(describePackageReadiness({
      sceneVersion: 2, runs: [run({ review: review('failed', null) })],
    }).reason).toContain('内容评审失败')
    expect(describePackageReadiness({
      sceneVersion: 2, runs: [run({ review: review('skipped', null) })],
    }).reason).toContain('内容评审未完成')
    expect(describePackageReadiness({
      sceneVersion: 2, runs: [run({ review: review('succeeded', false) })],
    }).reason).toContain('内容评审未通过')
  })

  test('多次真实运行中只要至少一次内容评审明确通过即可验证', () => {
    const failedReview = { ...passedReview, passed: false }
    expect(describePackageReadiness({
      sceneVersion: 2,
      runs: [run({ id: 'failed-review', review: failedReview }), run({ id: 'passed-review' })],
    })).toEqual({ verified: true, reason: null })
  })

  test('单步试跑不算整链证据：训练用的记录不能拿来代表交付验证', () => {
    const stepRun = run({ kind: 'step', stepId: 'scan' })

    expect(describePackageReadiness({ sceneVersion: 2, runs: [stepRun] }).reason)
      .toBe('这个场景还没有跑过一次整链运行')
  })

  test('候选草案即使评审通过也不能当成当前版本的交付证据', () => {
    const candidate = run({ definitionTarget: 'draft' })

    expect(describePackageReadiness({ sceneVersion: 2, runs: [candidate] }).reason)
      .toBe('这个场景还没有跑过一次整链运行')
  })

  test('老记录没有 kind 字段时按整链处理，不误判成未验证', () => {
    const legacy = run()
    delete (legacy as { kind?: string }).kind

    expect(describePackageReadiness({ sceneVersion: 2, runs: [legacy] }).verified).toBe(true)
  })
})
