import { describe, expect, test } from 'bun:test'
import { describeDeliveryHint, suggestedPackageFileName } from './capability-factory-delivery-view'

describe('导出默认文件名', () => {
  test('场景名 + 版本，空格与危险字符换成连字符（它要变成一个普通文件名）', () => {
    expect(suggestedPackageFileName('小说角色提取', 4)).toBe('小说角色提取-v4.json')
    expect(suggestedPackageFileName('Account  Query', 1)).toBe('Account-Query-v1.json')
    expect(suggestedPackageFileName('a/b:c*d', 2)).toBe('a-b-c-d-v2.json')
  })

  test('场景名为空时给一个兜底名字，而不是造出 ".json" 这种隐藏文件', () => {
    expect(suggestedPackageFileName('   ', 3)).toBe('capability-package-v3.json')
  })
})

describe('导出前体检文案', () => {
  test('已验证时说清依据（当前版本、真实数据、未用占位桩）', () => {
    const hint = describeDeliveryHint({ verified: true, reason: null })

    expect(hint.tone).toBe('ok')
    expect(hint.text).toContain('当前版本在真实数据上跑通过')
  })

  test('未验证时不拦、但把风险与建议一次说清', () => {
    const hint = describeDeliveryHint({ verified: false, reason: 'v2 上的运行用的是占位桩' })

    expect(hint.tone).toBe('warn')
    expect(hint.text).toContain('v2 上的运行用的是占位桩')
    expect(hint.text).toContain('照样可以导出')
    expect(hint.text).toContain('建议先在「运行」页跑一次真实数据再导出')
  })
})
