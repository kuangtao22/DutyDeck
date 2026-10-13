import { describe, expect, test } from 'bun:test'
import { createEmptySceneDefinition } from '../types/capability-factory'
import type { CapabilityRun, CapabilityRunReview } from '../types/capability-factory'
import { diagnoseCapabilityRun } from './capability-factory-run-diagnosis'

/** 构造已完成执行且可复核标准、模型与步骤轨迹的合成记录。 */
function fixture(): CapabilityRun {
  const definition = createEmptySceneDefinition('测试')
  const acceptance = { criteria: ['有原文证据'], judgePrompt: '', metrics: [] }
  definition.steps = [{ id: 'extract', title: '提取', type: 'llm', modelSlot: 'main', prompt: '提取' }]
  definition.stepAcceptances = { extract: acceptance }
  const review: CapabilityRunReview = { status: 'failed', passed: null, summary: '超时', failureKind: 'timeout', acceptance,
    criteria: [], metrics: [], suggestions: [], startedAt: 3, finishedAt: 4,
    modelBinding: { slotId: 'main', declaredModel: 'm', modelId: 'm', channelId: 'c', channelName: '渠道', substituted: false } }
  return { id: 'r', sceneId: 's', sceneVersion: 1, definitionSnapshot: definition, status: 'succeeded', valid: true,
    input: { text: '原文' }, outputs: { output: '角色' }, startedAt: 1, finishedAt: 2, review,
    steps: [{ stepId: 'extract', title: '提取', type: 'llm', status: 'succeeded', attempts: 1, input: {}, rawOutput: '角色', startedAt: 1, finishedAt: 2 }],
    stepReviews: { extract: review } }
}

describe('无模型运行诊断', () => {
  test.each(['timeout', 'invalid-response'] as const)('Given 完整材料和可恢复评审故障 When 诊断 Then 只建议补评失败步骤', (kind) => {
    const run = fixture(); run.stepReviews!.extract!.failureKind = kind
    expect(diagnoseCapabilityRun(run).category).toBe('review-retryable')
    expect(diagnoseCapabilityRun(run).retryableStepIds).toEqual(['extract'])
  })
  test.each(['cancelled', 'model-error'] as const)('Given 非自动恢复故障 When 诊断 Then 不建议重发', (kind) => {
    const run = fixture(); run.stepReviews!.extract!.failureKind = kind
    expect(diagnoseCapabilityRun(run).category).toBe('review-failed')
    expect(diagnoseCapabilityRun(run).retryableStepIds).toEqual([])
  })
  test('Given 旧记录 When 明确内容评审超时 Then 兼容而不猜测普通超时', () => {
    const run = fixture(); delete run.stepReviews!.extract!.failureKind
    run.stepReviews!.extract!.error = '内容评审超时，运行输出已保留'
    expect(diagnoseCapabilityRun(run).retryableStepIds).toEqual(['extract'])
    run.stepReviews!.extract!.error = 'request timed out'
    expect(diagnoseCapabilityRun(run).retryableStepIds).toEqual([])
  })
  test.each(['snapshot', 'binding', 'acceptance', 'trace', 'output', 'placeholder', 'unfinished'] as const)('Given 缺少 %s When 诊断 Then 禁止补评', (missing) => {
    const run = fixture()
    if (missing === 'snapshot') delete run.definitionSnapshot
    if (missing === 'binding') delete run.stepReviews!.extract!.modelBinding
    if (missing === 'acceptance') run.stepReviews!.extract!.acceptance = { criteria: ['篡改'], judgePrompt: '', metrics: [] }
    if (missing === 'trace') run.steps = []
    if (missing === 'output') delete run.steps[0]!.rawOutput
    if (missing === 'placeholder') run.placeholderCapabilities = ['tool']
    if (missing === 'unfinished') run.review!.finishedAt = null
    expect(diagnoseCapabilityRun(run).retryableStepIds).toEqual([])
  })
  test.each([['failed','execution-failed'],['running','in-progress']] as const)('Given 执行状态 %s When 诊断 Then 分类 %s', (status, category) => {
    const run = fixture(); run.status = status
    expect(diagnoseCapabilityRun(run).category).toBe(category)
    expect(diagnoseCapabilityRun(run).retryableStepIds).toEqual([])
  })
  test('Given 约束或证据错误 When 诊断 Then 不把错误算成超时', () => {
    const run = fixture(); run.evidenceIssues = ['引用不存在']
    expect(diagnoseCapabilityRun(run).category).toBe('invalid-output')
    expect(diagnoseCapabilityRun(run).retryableStepIds).toEqual([])
  })
  test('Given 内容不通过及另一评审故障 When 诊断 Then 保留各自问题只补故障步骤', () => {
    const run = fixture(); run.stepReviews!.other = { ...run.review!, status: 'succeeded', passed: false, summary: '漏提角色' }
    expect(diagnoseCapabilityRun(run).category).toBe('content-failed')
    expect(diagnoseCapabilityRun(run).issues.some((issue) => issue.stepId === 'other' && issue.kind === 'content-failed')).toBe(true)
    expect(diagnoseCapabilityRun(run).retryableStepIds).toEqual(['extract'])
  })
  test('Given 成功但未知判据 When 诊断 Then 不宣称通过', () => {
    const run = fixture(); run.stepReviews!.extract!.status = 'succeeded'
    expect(diagnoseCapabilityRun(run).category).toBe('review-incomplete')
    run.stepReviews!.extract!.passed = true
    expect(diagnoseCapabilityRun(run).category).toBe('passed')
  })
})

describe('单步输出与应评标准完整性', () => {
  test('Given 成功单步输出只在轨迹 When 诊断 Then 可补评对应步骤', () => {
    const run = fixture(); run.kind = 'step'; run.stepId = 'extract'; run.outputs = null
    expect(diagnoseCapabilityRun(run).retryableStepIds).toEqual(['extract'])
    run.stepId = 'other'
    expect(diagnoseCapabilityRun(run).retryableStepIds).toEqual([])
  })
  test('Given 整链输出丢失 When 诊断 Then 不能借成功轨迹绕过完整性', () => {
    const run = fixture(); run.outputs = null
    expect(diagnoseCapabilityRun(run).retryableStepIds).toEqual([])
  })
  test('Given 另一应评步骤没有标准 When 已评步骤通过 Then 不算完整通过', () => {
    const run = fixture(); run.review!.status = 'succeeded'; run.review!.passed = true
    run.definitionSnapshot!.steps.push({ id: 'other', title: '另一提取', type: 'llm', modelSlot: 'main', prompt: '提取' })
    expect(diagnoseCapabilityRun(run).category).toBe('review-incomplete')
    expect(diagnoseCapabilityRun(run).issues.some((issue) => issue.stepId === 'other' && issue.kind === 'missing-acceptance')).toBe(true)
    run.kind = 'step'; run.stepId = 'extract'
    expect(diagnoseCapabilityRun(run).category).toBe('passed')
  })
})
