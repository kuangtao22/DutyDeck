import { describe, expect, test } from 'bun:test'
import { createCapabilityFactoryCallLedger } from './capability-factory-budget'

/** 合成调用身份，不涉及真实模型。 */
const request = { purpose: 'execution' as const, stepId: 'extract', channelId: 'test', modelId: 'test' }
describe('工厂调用账本', () => {
  test('Given 仅剩一个额度 When 并发预留 Then 仅一个请求获准且失败不返还', async () => {
    const ledger = createCapabilityFactoryCallLedger({ maxCalls: 1 })
    const outcomes = await Promise.allSettled([Promise.resolve().then(() => ledger.reserve(request)), Promise.resolve().then(() => ledger.reserve(request))])
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const id = ledger.snapshot()[0]!.id
    ledger.markSent(id)
    ledger.settle(id, { status: 'failed' })
    expect(() => ledger.reserve(request)).toThrow('调用额度')
    expect(ledger.snapshot()[0]).toMatchObject({ status: 'failed', billing: 'unknown', usage: null })
  })
  test('Given 取消或超时 When 预留 Then 不增加账本', () => {
    const ledger = createCapabilityFactoryCallLedger({ maxCalls: 2, deadlineAt: 1, now: () => 2 })
    expect(() => ledger.reserve(request)).toThrow('截止时间')
    expect(ledger.snapshot()).toEqual([])
    const active = createCapabilityFactoryCallLedger({ maxCalls: 2 })
    expect(() => active.reserve({ ...request, signal: AbortSignal.abort() })).toThrow()
    expect(active.snapshot()).toEqual([])
  })
  test('Given 持久记录 When 新建账本 Then 不重置额度且未知价格不是免费', () => {
    const ledger = createCapabilityFactoryCallLedger({ maxCalls: 1 })
    ledger.reserve(request)
    const restored = createCapabilityFactoryCallLedger({ maxCalls: 1, initialRecords: ledger.snapshot() })
    expect(() => restored.reserve(request)).toThrow('调用额度')
    expect(() => createCapabilityFactoryCallLedger({ maxCalls: 1, hardCurrencyLimit: 3 })).toThrow('可靠')
  })
  test('Given 传输次数上限 When SSE 重试 Then 发送前计数并拒绝超额', () => {
    const ledger = createCapabilityFactoryCallLedger({ maxCalls: 2, maxTransportAttempts: 1 })
    const id = ledger.reserve(request)
    ledger.markSent(id)
    expect(() => ledger.markSent(id)).toThrow('传输额度')
    expect(ledger.snapshot()[0]!.transportAttempts).toBe(1)
  })
  test('Given 持久化失败 When 预留 Then 不放行且额度保守保留', () => {
    const ledger = createCapabilityFactoryCallLedger({ maxCalls: 1, onChange: () => { throw new Error('磁盘失败') } })
    expect(() => ledger.reserve(request)).toThrow('磁盘失败')
    expect(ledger.snapshot()).toHaveLength(1)
    expect(ledger.snapshot()[0]!.sent).toBe(false)
  })
})

test.each([undefined, -1, NaN, Infinity, 0.5, '1', Number.MAX_SAFE_INTEGER + 1])(
  'Given 持久传输计数损坏 %s When 恢复 Then 拒绝发送而不是产生 NaN 总额', (transportAttempts) => {
    /** 先构造合法记录，再模拟磁盘 JSON 被损坏；类型断言只存在于边界测试。 */
    const ledger = createCapabilityFactoryCallLedger({ maxCalls: 2 })
    ledger.reserve(request)
    const records = ledger.snapshot()
    Object.assign(records[0]!, { transportAttempts })
    expect(() => createCapabilityFactoryCallLedger({ maxCalls: 2, initialRecords: records })).toThrow('持久调用记录')
  })

test.each([
  { status: 'unexpected' }, { purpose: 'unknown' }, { id: '' }, { sent: 'yes' }, { billing: 'free' },
  { usage: { inputTokens: -1, outputTokens: 1 } }, { usage: { inputTokens: 1, outputTokens: Infinity } },
  { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: NaN } },
  { amount: Infinity }, { finishedAt: NaN }, { durationMs: -1 },
])('Given 持久身份或用量损坏 %j When 恢复 Then 失败关闭', (corruption) => {
  const ledger = createCapabilityFactoryCallLedger({ maxCalls: 2 })
  ledger.reserve(request)
  const records = ledger.snapshot()
  Object.assign(records[0]!, corruption)
  expect(() => createCapabilityFactoryCallLedger({ maxCalls: 2, initialRecords: records })).toThrow('持久调用记录')
})

test('Given 重复 ID、历史超额或累计次数溢出 When 恢复 Then 保留原证据并拒绝新账本', () => {
  const ledger = createCapabilityFactoryCallLedger({ maxCalls: 2 })
  const id = ledger.reserve(request)
  ledger.markSent(id)
  const records = ledger.snapshot()
  expect(() => createCapabilityFactoryCallLedger({ maxCalls: 2, initialRecords: [...records, ...records] })).toThrow('持久调用记录')
  expect(() => createCapabilityFactoryCallLedger({ maxCalls: 0, initialRecords: records })).toThrow('调用额度')
  expect(() => createCapabilityFactoryCallLedger({ maxCalls: 2, maxTransportAttempts: 0, initialRecords: records })).toThrow('传输额度')
  expect(() => createCapabilityFactoryCallLedger({ maxCalls: 2, initialRecords: [
    { ...records[0]!, transportAttempts: Number.MAX_SAFE_INTEGER }, { ...records[0]!, id: 'another', transportAttempts: 1 },
  ] })).toThrow('持久调用记录')
  expect(records[0]!.transportAttempts).toBe(1)
})

test.each(['reserve', 'markSent'] as const)('Given %s 持久化失败 When 磁盘随后恢复 Then 同一账本仍永久禁止发送', (boundary) => {
  /** 仅在指定发送前边界制造一次落盘失败。 */
  let fail = boundary === 'reserve'
  const ledger = createCapabilityFactoryCallLedger({ maxCalls: 3, onChange: () => { if (fail) throw new Error('磁盘失败') } })
  if (boundary === 'reserve') expect(() => ledger.reserve(request)).toThrow('磁盘失败')
  else {
    const id = ledger.reserve(request)
    fail = true
    expect(() => ledger.markSent(id)).toThrow('磁盘失败')
  }
  /** 失败记录不能被回滚，即使后续持久化成功也不自动恢复新调用权限。 */
  const id = ledger.snapshot()[0]!.id
  fail = false
  expect(() => ledger.reserve(request)).toThrow('持久化失败')
  expect(() => ledger.markSent(id)).toThrow('持久化失败')
  ledger.settle(id, { status: 'failed' })
  expect(() => ledger.reserve(request)).toThrow('持久化失败')
  expect(ledger.snapshot()).toHaveLength(1)
  expect(ledger.snapshot()[0]).toMatchObject({ status: 'failed', sent: boundary === 'markSent', usage: null, amount: null })
})
