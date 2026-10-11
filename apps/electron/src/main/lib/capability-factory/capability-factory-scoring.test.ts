import { describe, expect, test } from 'bun:test'
import type { CapabilityEvaluationProtocol, CapabilityExperimentSample, CapabilityRun } from '@proma/shared'
import { assertCapabilityScoringLabels, scoreCapabilityCase, summarizeCapabilityScores } from './capability-factory-scoring'

/** 测试用冻结集合匹配规范。 */
const protocol: CapabilityEvaluationProtocol = {
  protocolVersion: 'v1', scorerVersion: 1, primaryMetric: 'f1', mode: 'tuple-set', outputPath: 'items', expectedPath: '', tupleFields: [],
  normalization: { trim: false, caseFold: false, arrayOrder: 'ordered' }, requireReview: false,
}
/** 完整标注与已完成运行使用一致输入身份。 */
const sample: CapabilityExperimentSample = { caseId: 'case-1', sourceGroupId: 'book-1', split: 'validation', inputFingerprint: 'input-1', labelStatus: 'complete', expected: ['A', 'B'] }
/** 创建具有给定输出的整链记录。 */
const run = (items: unknown, changes: Partial<CapabilityRun> = {}): CapabilityRun => ({
  id: 'run-1', sceneId: 'scene', sceneVersion: 2, input: {}, outputs: { items }, steps: [], status: 'succeeded', valid: true, startedAt: 1, finishedAt: 2, ...changes,
})
describe('Given 可复核标签 When 评分 Then 质量与完整性分列', () => {
  test('A/B 对 A/C 得到 0.5 F1 且保留运行身份', () => {
    expect(scoreCapabilityCase(protocol, sample, run(['A', 'C']))).toMatchObject({ tp: 1, fp: 1, fn: 1, precision: .5, recall: .5, f1: .5, outcome: 'failed', runId: 'run-1', protocolVersion: 'v1' })
  })
  test('双空不适用 F1，重复项不被隐藏', () => {
    expect(scoreCapabilityCase(protocol, { ...sample, expected: [] }, run([]))).toMatchObject({ f1: null, correctEmpty: true })
    expect(scoreCapabilityCase(protocol, sample, run(['A', 'B', 'B']))).toMatchObject({ duplicatePredictions: 1, outcome: 'failed' })
  })
  test('部分标签不能将未标注预测误判为假阳性，不能计算召回/F1', () => {
    expect(scoreCapabilityCase(protocol, { ...sample, labelStatus: 'partial' }, run(['A', 'B', 'C']))).toMatchObject({ tp: 2, fp: null, fn: null, precision: null, recall: null, f1: null, outcome: 'unknown' })
  })
  test('普通对象键序无影响，数组顺序只有协议指定集合时才忽略', () => {
    const exact = { ...protocol, mode: 'exact-value' as const }
    expect(scoreCapabilityCase(exact, { ...sample, expected: { a: 1, b: 2 } }, run({ b: 2, a: 1 })).outcome).toBe('passed')
    expect(scoreCapabilityCase(exact, { ...sample, expected: [1, 2] }, run([2, 1])).outcome).toBe('failed')
    expect(scoreCapabilityCase({ ...exact, normalization: { ...exact.normalization, arrayOrder: 'set' } }, { ...sample, expected: [1, 2] }, run([2, 1])).outcome).toBe('passed')
  })
  test('格式错误计业务失败，基础设施/评审失败计未知', () => {
    expect(scoreCapabilityCase(protocol, sample, run(null, { valid: false })).outcome).toBe('failed')
    expect(scoreCapabilityCase(protocol, sample, run([], { status: 'failed' })).outcome).toBe('unknown')
    expect(scoreCapabilityCase({ ...protocol, requireReview: true }, sample, run(['A', 'B'])).outcome).toBe('unknown')
  })
  test('未完成计划项仍在分母，未知阻止报告完整宏平均', () => {
    const score = scoreCapabilityCase(protocol, sample, run(['A', 'C']))
    expect(summarizeCapabilityScores(['case-1', 'case-2'], [score])).toMatchObject({ planned: 2, failed: 1, unknown: 1, errorRateLower: .5, errorRateUpper: 1, macroF1: null })
  })
})

test('Given 元组映射与字符串规范 When 输出含重复匹配项 Then 显式报告重复且不通过', () => {
  /** 匹配键只从冻结字段取得，非匹配字段不参与身份判断。 */
  const tupleProtocol = { ...protocol, tupleFields: ['name'], normalization: { ...protocol.normalization, trim: true, caseFold: true } }
  const result = scoreCapabilityCase(tupleProtocol, { ...sample, expected: [{ name: 'A' }] }, run([{ name: ' a ' }, { name: 'A', extra: true }]))
  expect(result).toMatchObject({ tp: 1, fp: 0, fn: 0, duplicatePredictions: 1, outcome: 'failed' })
  expect(scoreCapabilityCase(tupleProtocol, { ...sample, expected: [{ name: 'A' }] }, run([{}])).outcome).toBe('failed')
})

test('Given 重复标签或混用协议 When 汇总 Then 不伪装为可靠满分', () => {
  expect(scoreCapabilityCase(protocol, { ...sample, expected: ['A', 'A'] }, run(['A'])).outcome).toBe('unknown')
  /** 协议名称相同但规范不同的评分也不能直接混算。 */
  const first = scoreCapabilityCase(protocol, sample, run(['A', 'B']))
  const second = scoreCapabilityCase({ ...protocol, requireReview: true }, { ...sample, caseId: 'case-2' }, run(['A', 'B']))
  expect(summarizeCapabilityScores(['case-1', 'case-2'], [first, second])).toMatchObject({ unknown: 2, macroF1: null })
})

test('Given 完整标注预检 When 任一样本无法评分 Then 在模型调用前拒绝', () => {
  expect(() => assertCapabilityScoringLabels(protocol, [sample, { ...sample, caseId: 'missing', expected: undefined }])).toThrow('标签')
  expect(() => assertCapabilityScoringLabels(protocol, [{ ...sample, labelStatus: 'partial' }])).toThrow('完整')
  expect(() => assertCapabilityScoringLabels({ ...protocol, expectedPath: 'missing' }, [sample])).toThrow('标签')
  expect(() => assertCapabilityScoringLabels({ ...protocol, tupleFields: ['name'] }, [{ ...sample, expected: [{ other: 'A' }] }])).toThrow('标签')
  expect(() => assertCapabilityScoringLabels(protocol, [{ ...sample, expected: ['A', 'A'] }])).toThrow('重复')
  expect(() => assertCapabilityScoringLabels({ ...protocol, normalization: { ...protocol.normalization, trim: true } }, [{ ...sample, expected: ['A', ' A '] }])).toThrow('重复')
})

test('Given 完整空标签或精确值 When 预检 Then 接受而不擅自要求非空集合', () => {
  expect(() => assertCapabilityScoringLabels(protocol, [{ ...sample, expected: [] }])).not.toThrow()
  expect(() => assertCapabilityScoringLabels({ ...protocol, mode: 'exact-value' }, [{ ...sample, expected: null }])).not.toThrow()
  expect(() => assertCapabilityScoringLabels(protocol, [{ ...sample, caseId: ' '.repeat(3) }])).toThrow()
  expect(() => assertCapabilityScoringLabels(protocol, [{ ...sample, sourceGroupId: 'x'.repeat(129) }])).toThrow()
})

test('Given 数组按集合匹配 When 元组关系方向相反 Then 不得交换字段位置取得满分', () => {
  /** 用户数组可以忽略顺序，但 subject/object 的协议位置必须保持。 */
  const relationProtocol = { ...protocol, tupleFields: ['subject', 'object'], normalization: { ...protocol.normalization, arrayOrder: 'set' as const } }
  const relationSample = { ...sample, expected: [{ subject: 'Alice', object: 'Bob' }] }
  expect(scoreCapabilityCase(relationProtocol, relationSample, run([{ subject: 'Bob', object: 'Alice' }]))).toMatchObject({ tp: 0, fp: 1, fn: 1, f1: 0, outcome: 'failed' })
  expect(() => assertCapabilityScoringLabels(relationProtocol, [
    { ...relationSample, expected: [{ subject: 'Alice', object: 'Bob' }, { subject: 'Bob', object: 'Alice' }] },
  ])).not.toThrow()
})

test('Given 固定元组字段位置 When 字段内部数组仅顺序不同 Then 仍按集合规则相等', () => {
  /** 集合归一化仅作用于原始字段值，包括字段值内部嵌套数组。 */
  const nestedProtocol = { ...protocol, tupleFields: ['subject', 'object'], normalization: { ...protocol.normalization, arrayOrder: 'set' as const } }
  const nestedSample = { ...sample, expected: [{ subject: ['Alice', 'Ann'], object: { aliases: ['Bob', 'Ben'] } }] }
  expect(scoreCapabilityCase(nestedProtocol, nestedSample, run([{ subject: ['Ann', 'Alice'], object: { aliases: ['Ben', 'Bob'] } }]))).toMatchObject({ tp: 1, fp: 0, fn: 0, f1: 1, outcome: 'passed' })
})
