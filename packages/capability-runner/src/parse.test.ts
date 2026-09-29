import { describe, expect, test } from 'bun:test'
import { parseCapabilityPackage, parseCapabilityPackageValue } from './parse'

/** 构造一份最小合法能力包；各用例只覆盖自己关心的字段。 */
function packageValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'proma-ai-capability-package',
    specVersion: 1,
    packageVersion: '1.0.0',
    name: 'demo',
    exportedAt: 1790000000000,
    inputs: [{ name: 'text', type: 'string' }],
    outputs: [{ name: 'answer', from: { stepId: 'answer' }, shape: 'text' }],
    steps: [{ type: 'llm', id: 'answer', title: '生成回答', modelSlot: 'main', prompt: '回答：{{text}}' }],
    capabilities: [],
    modelSlots: [{ id: 'main', model: 'test-model' }],
    acceptance: { criteria: ['必须给出结论'] },
    ...overrides,
  }
}

describe('能力包严格解析', () => {
  test('合法包通过，并保留声明的字段', () => {
    const pkg = parseCapabilityPackageValue(packageValue())
    expect(pkg.kind).toBe('proma-ai-capability-package')
    expect(pkg.steps).toHaveLength(1)
    expect(pkg.acceptance.criteria).toEqual(['必须给出结论'])
  })

  test('kind 不匹配即拒绝', () => {
    expect(() => parseCapabilityPackageValue(packageValue({ kind: 'something-else' })))
      .toThrow(/kind 必须是/)
  })

  test('specVersion 不匹配即拒绝，不做降级', () => {
    expect(() => parseCapabilityPackageValue(packageValue({ specVersion: 2 })))
      .toThrow(/不做降级/)
  })

  test('出现未知字段即拒绝 —— 避免旧 runner 静默忽略新语义', () => {
    expect(() => parseCapabilityPackageValue(packageValue({ somethingNew: 1 })))
      .toThrow(/未知字段：somethingNew/)
  })

  test('步骤 id 重复即拒绝', () => {
    const steps = [
      { type: 'llm', id: 'dup', title: 'A', modelSlot: 'main', prompt: 'x' },
      { type: 'llm', id: 'dup', title: 'B', modelSlot: 'main', prompt: 'y' },
    ]
    expect(() => parseCapabilityPackageValue(packageValue({ steps }))).toThrow(/步骤 id 重复/)
  })

  test('引用不存在的 stepId 即拒绝', () => {
    const steps = [
      { type: 'llm', id: 'a', title: 'A', modelSlot: 'main', prompt: 'x',
        inputs: { prev: { from: 'step-output', stepId: 'missing' } } },
    ]
    expect(() => parseCapabilityPackageValue(packageValue({ steps }))).toThrow(/不存在的 stepId/)
  })

  test('引用不存在的 modelSlot 即拒绝', () => {
    const steps = [{ type: 'llm', id: 'a', title: 'A', modelSlot: 'nope', prompt: 'x' }]
    expect(() => parseCapabilityPackageValue(packageValue({ steps }))).toThrow(/不存在的 modelSlot/)
  })

  test('引用不存在的 capabilityId 即拒绝', () => {
    const steps = [{ type: 'tool', id: 't', title: 'T', capabilityId: 'nope', bindings: {} }]
    expect(() => parseCapabilityPackageValue(packageValue({
      steps, outputs: [{ name: 'a', from: { stepId: 't' }, shape: 'text' }],
    }))).toThrow(/不存在的 capabilityId/)
  })

  test('outputs 引用不存在的步骤即拒绝', () => {
    expect(() => parseCapabilityPackageValue(packageValue({
      outputs: [{ name: 'a', from: { stepId: 'ghost' }, shape: 'text' }],
    }))).toThrow(/outputs\[0\] 引用了不存在的 stepId/)
  })

  test('并行组：body 为空即拒绝，over 必填', () => {
    const empty = [{ type: 'map', id: 'm', title: 'M', over: { from: 'workflow-input', field: 'text' }, body: [] }]
    expect(() => parseCapabilityPackageValue(packageValue({
      steps: empty, outputs: [{ name: 'a', from: { stepId: 'm' }, shape: 'text' }],
    }))).toThrow(/body 必须是非空数组/)

    const missingOver = [{ type: 'map', id: 'm', title: 'M', body: [
      { type: 'llm', id: 'inner', title: 'I', modelSlot: 'main', prompt: 'x' },
    ] }]
    expect(() => parseCapabilityPackageValue(packageValue({
      steps: missingOver, outputs: [{ name: 'a', from: { stepId: 'm' }, shape: 'text' }],
    }))).toThrow(/over 必须是对象/)
  })

  test('acceptance.criteria 为空即拒绝', () => {
    expect(() => parseCapabilityPackageValue(packageValue({ acceptance: { criteria: [] } })))
      .toThrow(/criteria 必须是非空/)
  })

  test('非 JSON 文本给出稳定错误码', () => {
    expect(() => parseCapabilityPackage('{ not json')).toThrow(/^CAPABILITY_PACKAGE_INVALID: 不是合法的 JSON$/)
  })
})
