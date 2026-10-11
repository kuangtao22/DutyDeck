import { describe, expect, test } from 'bun:test'
import { updateFactoryModelSelection } from './capability-factory-model-selection'

describe('工厂模型选择', () => {
  test('Given 未配置场景 When 选择跨渠道槽位模型 Then 保存完整渠道引用', () => {
    expect(updateFactoryModelSelection(undefined, { slotId: 'main' }, { channelId: 'other', modelId: 'same-id' }))
      .toEqual({ slots: { main: { channelId: 'other', modelId: 'same-id' } } })
  })
  test('Given 多槽位与独立评审 When 重置一个槽位 Then 保留其它设置且不修改原值', () => {
    /** 原始配置用于验证重置不影响其它槽位。 */
    const original = { slots: { main: { channelId: 'a', modelId: 'm' }, extra: { channelId: 'b', modelId: 'n' } }, review: { channelId: 'c', modelId: 'r' } }
    expect(updateFactoryModelSelection(original, { slotId: 'main' }, null))
      .toEqual({ slots: { extra: original.slots.extra }, review: original.review })
    expect(original.slots.main.modelId).toBe('m')
  })
  test('Given 独立评审模型 When 恢复跟随 Then 仅清除评审覆盖', () => {
    /** 原始配置与目标配置应共享业务语义而非可变状态。 */
    const original = { slots: { main: { channelId: 'a', modelId: 'm' } }, review: { channelId: 'b', modelId: 'r' } }
    expect(updateFactoryModelSelection(original, { review: true }, null)).toEqual({ slots: original.slots })
    expect(updateFactoryModelSelection(original, { review: true }, { channelId: 'c', modelId: 'judge' }).review)
      .toEqual({ channelId: 'c', modelId: 'judge' })
  })
})
