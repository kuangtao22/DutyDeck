/** 当前版与待采纳草案的步骤定位、比较及局部修改；不改变保存的版本语义。 */
import { getStepAcceptance, type CapabilityScene, type CapabilitySceneDefinition, type Step } from '@proma/shared'

/** 稳定排序对象键，避免 JSON 键顺序变化被当作业务修改。 */
function orderedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedValue)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, orderedValue(item)]),
  )
  return value
}

/** 序列化对比材料；缺失的一侧为空，差异视图会显示完整新增或删除。 */
export function serializeDraftValue(value: unknown): string {
  return value === undefined || value === null ? '' : JSON.stringify(orderedValue(value), null, 2)
}

/** 按内容比较，忽略对象键顺序，保留数组顺序。 */
export function isDraftValueEqual(before: unknown, after: unknown): boolean {
  return serializeDraftValue(before) === serializeDraftValue(after)
}

/** 递归查找并行组内外的步骤，不把草案新增步骤误当成不存在。 */
export function findSceneStep(definition: CapabilitySceneDefinition, stepId: string): Step | null {
  /** 深度优先查找，步骤 ID 由场景校验保证唯一。 */
  const find = (steps: readonly Step[]): Step | null => {
    for (const step of steps) {
      if (step.id === stepId) return step
      if (step.type === 'map') {
        const child = find(step.body)
        if (child) return child
      }
    }
    return null
  }
  return find(definition.steps)
}

/** 用层级序号记录执行位置，识别纯重排和跨并行组移动。 */
function stepPosition(definition: CapabilitySceneDefinition, stepId: string): string | null {
  const find = (steps: readonly Step[], prefix: string): string | null => {
    for (const [index, step] of steps.entries()) {
      const position = prefix ? `${prefix}.${index + 1}` : `${index + 1}`
      if (step.id === stepId) return position
      const child = step.type === 'map' ? find(step.body, position) : null
      if (child) return child
    }
    return null
  }
  return find(definition.steps, '')
}

/** 当前步骤两侧材料；提示词流程与评审标准独立标记。 */
export function getStepDraftChange(scene: CapabilityScene, stepId: string) {
  const before = findSceneStep(scene.definition, stepId)
  const after = scene.draft ? findSceneStep(scene.draft.definition, stepId) : before
  const beforePosition = stepPosition(scene.definition, stepId)
  const afterPosition = scene.draft ? stepPosition(scene.draft.definition, stepId) : beforePosition
  return {
    before, after, beforePosition, afterPosition,
    stepChanged: Boolean(scene.draft) && (!isDraftValueEqual(before, after) || beforePosition !== afterPosition),
    acceptanceChanged: Boolean(scene.draft) && !isDraftValueEqual(
      before ? getStepAcceptance(scene.definition, stepId) : null,
      after && scene.draft ? getStepAcceptance(scene.draft.definition, stepId) : null,
    ),
  }
}

/** 场景行保留当前顺序，末尾补上草案新增项，删除项仍可点击比较。 */
export function buildSceneStepRows(scene: CapabilityScene): Array<{ step: Step; change: 'added' | 'removed' | 'modified' | null }> {
  const currentIds = new Set(scene.definition.steps.map((step) => step.id))
  const steps = [...scene.definition.steps, ...(scene.draft?.definition.steps.filter((step) => !currentIds.has(step.id)) ?? [])]
  return steps.map((step) => {
    const change = getStepDraftChange(scene, step.id)
    return { step, change: !change.stepChanged ? null : !change.before ? 'added' : !change.after ? 'removed' : 'modified' }
  })
}

/** 仅修改目标提示词，保留草案所有其它步骤、模型、输入输出与评审标准。 */
export function updateStepPrompt(definition: CapabilitySceneDefinition, stepId: string, prompt: string): CapabilitySceneDefinition {
  const target = findSceneStep(definition, stepId)
  if (!target || !('prompt' in target)) throw new Error('草案中的目标步骤不存在或不能编辑提示词，请重新打开后比较。')
  /** 不修改原对象，嵌套并行组同样只替换目标节点。 */
  const update = (steps: readonly Step[]): Step[] => steps.map((step) => step.id === stepId && 'prompt' in step
    ? { ...step, prompt } : step.type === 'map' ? { ...step, body: update(step.body) } : step)
  return { ...definition, steps: update(definition.steps) }
}
