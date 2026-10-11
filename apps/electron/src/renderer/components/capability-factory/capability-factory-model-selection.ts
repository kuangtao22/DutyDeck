import type { CapabilityFactoryModelReference, CapabilityFactoryModelSelection } from '@proma/shared'

/** 选择目标明确区分槽位与评审，避免槽位名称与保留字冲突。 */
export type FactoryModelTarget = { slotId: string } | { review: true }

/** 输入原配置、目标与新引用（null 表示默认），返回保持其它槽位不变的新配置。 */
export function updateFactoryModelSelection(
  selection: CapabilityFactoryModelSelection | undefined,
  target: FactoryModelTarget,
  reference: CapabilityFactoryModelReference | null,
): CapabilityFactoryModelSelection {
  /** 复制映射，清除覆盖时不修改当前场景快照。 */
  const next: CapabilityFactoryModelSelection = { ...selection, slots: { ...selection?.slots } }
  if ('slotId' in target) {
    if (reference) next.slots[target.slotId] = { ...reference }
    else delete next.slots[target.slotId]
  } else if (reference) next.review = { ...reference }
  else delete next.review
  return next
}
