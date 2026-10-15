import { describe, expect, test } from 'bun:test'
import { validateCapabilityFactoryRunLimits } from './capability-factory-call-ledger'

describe('普通工厂整链限额', () => {
  test('Given 合法限额 When 解析 Then 返回独立快照且不判断当前时钟', () => {
    /** 过去时间仍可解析，实际过期由运行时拒绝。 */
    const limits = { maxCalls: 1000, maxTransportAttempts: 2000, deadlineAt: 1 }
    expect(validateCapabilityFactoryRunLimits(limits)).toEqual(limits)
    expect(validateCapabilityFactoryRunLimits(limits)).not.toBe(limits)
  })
  test('Given 非完整白名单或非正安全整数 When 解析 Then 拒绝', () => {
    /** 同时覆盖零、分数、上限、伪造字段和缺项。 */
    const limits = { maxCalls: 3, maxTransportAttempts: 3, deadlineAt: 123 }
    for (const invalid of [null, [], {}, { ...limits, extra: true }, { ...limits, maxCalls: 1001 },
      { ...limits, maxTransportAttempts: 2001 }, ...['maxCalls', 'maxTransportAttempts', 'deadlineAt'].flatMap((key) =>
        [0, -1, 1.5, '3', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ ...limits, [key]: value })))]) {
      expect(() => validateCapabilityFactoryRunLimits(invalid)).toThrow('CAPABILITY_FACTORY_INVALID')
    }
  })
})
