import { describe, expect, test } from 'bun:test'
import { validateCapabilityEvaluationProtocol, validateCapabilityExperimentSamples } from './capability-factory-experiment'
import type { CapabilityEvaluationProtocol, CapabilityExperimentSample } from './capability-factory-experiment'

/** 冻结的通用集合协议，不包含业务特定字段。 */
const protocol: CapabilityEvaluationProtocol = {
  protocolVersion: 'v1', scorerVersion: 1, primaryMetric: 'f1', mode: 'tuple-set',
  outputPath: 'people', expectedPath: '', tupleFields: [],
  normalization: { trim: false, caseFold: false, arrayOrder: 'ordered' }, requireReview: false,
}
/** 生成独立来源样本，参数覆盖用于校验异常边界。 */
const sample = (overrides: Partial<CapabilityExperimentSample> = {}): CapabilityExperimentSample => ({
  caseId: 'a', split: 'optimization', sourceGroupId: 'book-a', inputFingerprint: 'input-a', labelStatus: 'complete', expected: [], ...overrides,
})
describe('Given 冻结评分协议 When 校验 Then 不接受隐式规范或污染分组', () => {
  test('接受明确配置及部分/未核对标签，但不自动升级旧标签', () => {
    expect(validateCapabilityEvaluationProtocol(protocol)).toEqual(protocol)
    expect(validateCapabilityExperimentSamples([sample(), sample({ caseId: 'b', sourceGroupId: 'b', inputFingerprint: 'b', labelStatus: 'partial' })])).toHaveLength(2)
    expect(() => validateCapabilityEvaluationProtocol({ ...protocol, normalization: undefined })).toThrow()
  })
  test('拒绝来源跨组、重复输入、缺少完整标签', () => {
    expect(() => validateCapabilityExperimentSamples([sample(), sample({ caseId: 'b', split: 'held-out', inputFingerprint: 'b' })])).toThrow('来源')
    expect(() => validateCapabilityExperimentSamples([sample(), sample({ caseId: 'b', sourceGroupId: 'b' })])).toThrow('重复输入')
    expect(() => validateCapabilityExperimentSamples([sample({ expected: undefined })])).toThrow('标签')
  })
  test('拒绝未知评分器和任意执行脚本', () => {
    expect(() => validateCapabilityEvaluationProtocol({ ...protocol, scorerVersion: 2 })).toThrow()
    expect(() => validateCapabilityEvaluationProtocol({ ...protocol, mode: 'javascript' })).toThrow()
  })
})

test('Given 外部协议 When 含未知字段或超限映射 Then 拒绝并避免保存无关内容', () => {
  expect(() => validateCapabilityEvaluationProtocol({ ...protocol, script: 'payload' })).toThrow()
  expect(() => validateCapabilityEvaluationProtocol({ ...protocol, normalization: { ...protocol.normalization, extra: true } })).toThrow()
  expect(() => validateCapabilityEvaluationProtocol({ ...protocol, protocolVersion: 'x'.repeat(129) })).toThrow()
  expect(() => validateCapabilityEvaluationProtocol({ ...protocol, tupleFields: Array.from({ length: 33 }, (_, index) => `field${index}`) })).toThrow()
  expect(validateCapabilityEvaluationProtocol({ ...protocol, protocolVersion: 'x'.repeat(128), tupleFields: Array.from({ length: 32 }, (_, index) => `field${index}`) }).tupleFields).toHaveLength(32)
})

test('Given 外部样本身份 When 来源或用例标识超限 Then 拒绝但保留历史长输入指纹兼容', () => {
  expect(() => validateCapabilityExperimentSamples([sample({ caseId: 'x'.repeat(129) })])).toThrow()
  expect(() => validateCapabilityExperimentSamples([sample({ sourceGroupId: 'x'.repeat(129) })])).toThrow()
  expect(validateCapabilityExperimentSamples([sample({ inputFingerprint: 'x'.repeat(4096) })])[0]?.inputFingerprint).toHaveLength(4096)
})
