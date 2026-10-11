import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createEmptySceneDefinition, type CapabilityFactoryExperimentView } from '@proma/shared'
import { CapabilityFactoryExperimentSummary } from './CapabilityFactoryExperimentSummary'

/** 最小持久实验快照；不调用模型或读取用户数据。 */
function experiment(overrides: Partial<CapabilityFactoryExperimentView> = {}): CapabilityFactoryExperimentView {
  return { id: 'experiment-1', sceneId: 'scene-1', workspaceFingerprint: 'workspace', revision: 1,
    status: 'prepared', running: false, sceneVersion: 1, datasetId: 'dataset', datasetVersion: 1,
    datasetFingerprint: 'data', protocol: { protocolVersion: 'v1', scorerVersion: 1, primaryMetric: 'f1',
      mode: 'tuple-set', outputPath: '', expectedPath: '', tupleFields: [], normalization: { trim: true, caseFold: false, arrayOrder: 'set' }, requireReview: true },
    protocolFingerprint: 'protocol', samples: Array.from({ length: 10 }, (_, index) => ({ caseId: `case-${index}`,
      sourceGroupId: `source-${index}`, inputFingerprint: `input-${index}`, split: 'held-out', labelStatus: 'complete' })),
    targetStepId: 'extract', baselineDefinition: createEmptySceneDefinition('测试'), modelBindings: [{
      slotId: 'main', declaredModel: 'model', modelId: 'actual-model', channelId: 'channel', channelName: '测试渠道', substituted: false }],
    modelFingerprint: 'model', candidates: [], stages: [], heldOutExposure: 'declared-unseen',
    limits: { maxCalls: 120, maxTransportAttempts: 150, durationMs: 300000 }, calls: [], roundsUsed: 0,
    runUnitsReserved: 0, createdAt: 1, startedAt: null, deadlineAt: null, updatedAt: 1, finishedAt: null,
    providerRevision: 'unknown', proposalCost: 'unattributed', ...overrides }
}
/** 静态渲染用于覆盖所有结果分支的用户可见文案。 */
function render(record: CapabilityFactoryExperimentView): string {
  return renderToStaticMarkup(<CapabilityFactoryExperimentSummary experiments={[record]} />)
}
describe('实验摘要', () => {
  test('Given 旧场景无实验 When 展示 Then 显示空状态和非付费入口', () => {
    const html = renderToStaticMarkup(<CapabilityFactoryExperimentSummary experiments={[]} />)
    expect(html).toContain('暂无优化实验')
    expect(html).not.toContain('开始实验')
  })
  test('Given 小留出集和未知费用 When 查看 Then 不宣称优化成功或免费', () => {
    const html = render(experiment())
    expect(html).toContain('小样本初步结果')
    expect(html).toContain('费用未知')
    expect(html).toContain('提案 Agent 费用未归因')
    expect(html).toContain('actual-model')
    expect(html).toContain('留出 10 条')
    expect(html).toContain('优化 0 条')
    expect(html).toContain('0 / 60')
    expect(html).not.toContain('¥0')
  })
  test.each(['failed', 'cancelled', 'interrupted'] as const)('Given %s 终态 When 查看 Then 保留原因和已用额度', (status) => {
    const html = render(experiment({ status, stopReason: '模型设置发生变化', runUnitsReserved: 7, roundsUsed: 1 }))
    expect(html).toContain('模型设置发生变化')
    expect(html).toContain('7 / 60')
    expect(html).toContain('1 / 3')
  })
  test('Given 标签不全且已有阶段质量 When 查看 Then 显示未知与不可采纳，不隐藏不完整配对', () => {
    const html = render(experiment({ samples: [{ caseId: 'a', split: 'validation', sourceGroupId: 'source', inputFingerprint: 'input', labelStatus: 'partial' }],
      heldOutExposure: 'unknown', stages: [{ split: 'validation', candidateId: 'B', candidateFingerprint: 'candidate',
        startedAt: 1, finishedAt: 2, pairs: [{ caseId: 'a', baselineRunId: 'base' }], quality: {
          planned: 10, paired: 1, unknown: 9, baselineMacroF1: 0.5, candidateMacroF1: 0.5, f1Delta: 0,
          baselineFailures: 0, candidateFailures: 0, baselineErrorBounds: [0, 0.9], candidateErrorBounds: [0, 0.9],
          validationEligible: false, adoptionEligible: false, reasons: ['主指标未改善'] } }] }))
    expect(html).toContain('完整标签 0 / 1')
    expect(html).toContain('未知 9 / 10')
    expect(html).toContain('主指标未改善')
    expect(html).toContain('不能作为采纳认证')
    expect(html).toContain('未完成')
    expect(html).toContain('候选 B')
    expect(html).toContain('仅作回归验证')
  })
})

test('Given 验证和留出候选不同 When 旧记录声称可采纳 Then 不显示认证成功', () => {
  /** 即便旧元数据带有通过标记，也必须先确认候选身份一致。 */
  const html = render(experiment({ status: 'completed', stages: [
    { split: 'validation', candidateId: 'A', candidateFingerprint: 'first', pairs: [], startedAt: 1, finishedAt: 2 },
    { split: 'held-out', candidateId: 'B', candidateFingerprint: 'second', pairs: [], startedAt: 3, finishedAt: 4,
      quality: { planned: 10, paired: 10, unknown: 0, baselineMacroF1: 0.5, candidateMacroF1: 0.6, f1Delta: 0.1,
        baselineFailures: 2, candidateFailures: 1, baselineErrorBounds: [0.2, 0.2], candidateErrorBounds: [0.1, 0.1],
        validationEligible: true, adoptionEligible: true, reasons: [] } },
  ] }))
  expect(html).toContain('候选身份无法确认一致')
  expect(html).toContain('不能作为采纳认证')
  expect(html).not.toContain('满足当前证据门槛')
})

test('Given 留出开始时未见且完成后查看材料 When 展示 Then 保留历史事实并提示后续退役', () => {
  /** 事后查看与评测前污染属于不同时间事实，不能混为一谈。 */
  const html = render(experiment({ status: 'completed', heldOutExposureAtStart: 'declared-unseen', heldOutExposure: 'exposed' }))
  expect(html).toContain('评测开始时声明未见')
  expect(html).toContain('后续调参实验必须将该集合退役')
  expect(html).not.toContain('仅作回归验证')
})
