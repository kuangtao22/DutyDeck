import { describe, expect, test } from 'bun:test'
import type { CapabilityEvaluation } from '@proma/shared'
import {
  describeCompliance, describeEvaluationComparison, describeQuality,
  describeJudgeResult, suggestedDatasetName,
} from './capability-factory-evaluation-view'

/** 造一条评测记录。 */
function evaluation(overrides: Partial<CapabilityEvaluation> = {}): CapabilityEvaluation {
  return {
    id: 'eval-1', sceneId: 'scene-1', sceneVersion: 5, datasetId: 'ds-1', datasetVersion: 3,
    status: 'succeeded', constraintCompliance: 0.8, validSamples: 16, totalSamples: 20,
    metrics: {}, judgeResults: [], baselineId: null, startedAt: 0, finishedAt: 100,
    ...overrides,
  }
}

describe('合规率展示', () => {
  test('百分比配分母：1/1 与 20/20 看起来必须不一样', () => {
    expect(describeCompliance(evaluation())).toEqual({ percent: '80%', detail: '有效样本 16/20' })
  })

  test('没有样本时不给百分比，避免出现"100%"这种假象', () => {
    expect(describeCompliance(evaluation({ validSamples: 0, totalSamples: 0 })).percent).toBe('—')
  })
})

describe('质量评审展示', () => {
  test('同时写清质量通过数与实际完成评审数，失败或缺失不能混进通过数', () => {
    expect(describeQuality(evaluation({
      totalSamples: 3, reviewedSamples: 2, passedReviewSamples: 1,
    }))).toEqual({ status: '部分通过', detail: '质量通过 1/3 · 已完成评审 2/3' })
  })

  test('旧记录没有自动评审数据时明确显示未评审', () => {
    expect(describeQuality(evaluation())).toEqual({ status: '未评审', detail: '这条历史记录没有内容评审结果' })
  })

  test('判据展示通过数除以已判断数，不把无法判断算进分母', () => {
    expect(describeJudgeResult({
      criterionId: 'criterion-1', criterion: '名称有原文证据', passed: 2, total: 3,
    })).toBe('2/3 已判断通过')
  })
})

describe('与上一次评测的对比', () => {
  test('同一数据集：算出百分点变化并写清两边的场景版本', () => {
    const text = describeEvaluationComparison(
      evaluation({ sceneVersion: 5, constraintCompliance: 0.9, validSamples: 18 }),
      evaluation({ id: 'eval-0', sceneVersion: 4, constraintCompliance: 0.7, validSamples: 14 }),
    )

    expect(text).toContain('提高 20 个百分点')
    expect(text).toContain('v4 是 70%')
    expect(text).toContain('v5 是 90%')
  })

  test('合规率没变时明说"没有变化"，而不是含糊其辞', () => {
    const text = describeEvaluationComparison(
      evaluation({ sceneVersion: 5, constraintCompliance: 0.8 }),
      evaluation({ id: 'eval-0', sceneVersion: 4, constraintCompliance: 0.8 }),
    )

    expect(text).toContain('合规率没有变化')
  })

  test('换了一批用例就不给数字结论：数据集版本不同时分数不可比', () => {
    const text = describeEvaluationComparison(
      evaluation({ datasetVersion: 4, constraintCompliance: 0.95 }),
      evaluation({ id: 'eval-0', datasetVersion: 3, constraintCompliance: 0.7 }),
    )

    expect(text).toContain('用例集不一样，分数不能直接比')
    expect(text).not.toContain('个百分点')
  })

  test('第一次评测时如实说没有基线', () => {
    expect(describeEvaluationComparison(evaluation(), null)).toContain('第一次评测')
  })
})

describe('数据集默认名', () => {
  test('带上场景名，便于区分这是哪一组输入', () => {
    expect(suggestedDatasetName('小说角色提取')).toBe('小说角色提取 · 真实输入集')
    expect(suggestedDatasetName('   ')).toBe('真实输入集')
  })
})
