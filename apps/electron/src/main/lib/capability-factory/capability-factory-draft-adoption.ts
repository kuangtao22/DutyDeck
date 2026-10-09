import {
  getReviewSteps, getStepAcceptance, stableCapabilityValueKey,
  type CapabilityDraftAdoptionScope, type CapabilityScene, type CapabilitySceneDefinition,
  type SceneAcceptance, type Step,
} from '@proma/shared'

/** 纯预览结果：生效快照、剩余完整目标草案与本次范围说明；不执行持久化。 */
interface CapabilityDraftAdoption {
  definition: CapabilitySceneDefinition
  remainingDefinition: CapabilitySceneDefinition | null
  note: string
}

/** 步骤身份包含祖先 ID 与序号，避免把同名节点或跨组移动误当局部内容更新。 */
interface LocatedStep {
  step: Step
  position: string
}

/** 输入完整场景和审核范围，返回只合入该范围的快照；无变化或结构关联时拒绝扩大批准。 */
export function resolveCapabilityDraftAdoption(
  scene: CapabilityScene,
  scope: CapabilityDraftAdoptionScope = { kind: 'all' },
): CapabilityDraftAdoption {
  /** 候选快照只克隆一次；调用方与存储对象均不被原地修改。 */
  const draft = scene.draft
  if (!draft) throw new Error('当前没有待采纳的草案')
  if (scope.kind === 'all') {
    return { definition: structuredClone(draft.definition), remainingDefinition: null, note: draft.note }
  }
  if ((scope.kind !== 'step' && scope.kind !== 'stepAcceptance') || !scope.stepId?.trim()) {
    throw new Error('采纳范围不合法')
  }

  /** 定位必须在两侧唯一存在；新增、删除和类型/位置变化需要整体审核。 */
  const before = locateStep(scene.definition.steps, scope.stepId)
  const after = locateStep(draft.definition.steps, scope.stepId)
  if (!before || !after || before.position !== after.position || before.step.type !== after.step.type) {
    throw structureError()
  }
  const definition = structuredClone(scene.definition)
  let remainingDefinition = structuredClone(draft.definition)
  if (scope.kind === 'step') {
    if (!equal(stepDependencies(before.step), stepDependencies(after.step))) throw structureError()
    if (equal(before.step, after.step)) throw new Error('当前步骤没有待采纳的改动')
    definition.steps = replaceStep(definition.steps, scope.stepId, after.step)
  } else {
    if (before.step.type !== 'llm' && before.step.type !== 'extract') throw structureError()
    if (equal(getStepAcceptance(scene.definition, scope.stepId), getStepAcceptance(draft.definition, scope.stepId))) {
      throw new Error('当前评审标准没有待采纳的改动')
    }
    /** 旧全局标准展开为逐步标准，确保采纳一个块不会切断其他块的兼容回退。 */
    definition.stepAcceptances = explicitAcceptances(scene.definition)
    const candidateAcceptances = explicitAcceptances(draft.definition)
    const candidate = candidateAcceptances[scope.stepId]
    if (candidate === undefined) delete definition.stepAcceptances[scope.stepId]
    else definition.stepAcceptances[scope.stepId] = structuredClone(candidate)
    if (draft.definition.stepAcceptances === undefined) {
      /** 剩余目标同步迁移表示；运行/导出已使用逐步标准，顶层旧值不再产生悬空差异。 */
      remainingDefinition = { ...remainingDefinition, acceptance: structuredClone(definition.acceptance), stepAcceptances: candidateAcceptances }
    }
  }
  return {
    definition,
    remainingDefinition: equal(comparableDefinition(definition), comparableDefinition(remainingDefinition)) ? null : remainingDefinition,
    note: `采纳${scope.kind === 'step' ? '步骤' : '评审标准'}「${after.step.title}」（${scope.stepId}）`,
  }
}

/** 输入步骤列表和 ID，返回唯一节点及路径；重复 ID 无法精确授权。 */
function locateStep(steps: readonly Step[], stepId: string): LocatedStep | null {
  const matches: LocatedStep[] = []
  /** 保留父级身份与序号，不只依赖可能重复的标题。 */
  const visit = (items: readonly Step[], path: Array<[string, number]>): void => {
    for (const [index, step] of items.entries()) {
      const position = [...path, [step.id, index] as [string, number]]
      if (step.id === stepId) matches.push({ step, position: JSON.stringify(position) })
      if (step.type === 'map') visit(step.body, position)
    }
  }
  visit(steps, [])
  if (matches.length > 1) throw structureError()
  return matches[0] ?? null
}

/** 依赖字段须保持不变；容器 body 也作为整体依赖，不能暗中采纳所有子块。 */
function stepDependencies(step: Step): unknown {
  const common = { type: step.type, id: step.id, inputs: step.inputs }
  if (step.type === 'llm' || step.type === 'extract') return { ...common, modelSlot: step.modelSlot }
  if (step.type === 'tool') return { ...common, capabilityId: step.capabilityId, bindings: step.bindings }
  return { ...common, over: step.over, body: step.body }
}

/** 输入当前步骤树及目标快照，只替换唯一节点，保留兄弟步骤和容器配置。 */
function replaceStep(steps: Step[], stepId: string, candidate: Step): Step[] {
  return steps.map((step) => step.id === stepId ? structuredClone(candidate)
    : step.type === 'map' ? { ...step, body: replaceStep(step.body, stepId, candidate) } : step)
}

/** 输入场景定义，返回显式标准表；旧格式只展开有效标准，新格式保留清空条目。 */
function explicitAcceptances(definition: CapabilitySceneDefinition): Record<string, SceneAcceptance> {
  if (definition.stepAcceptances !== undefined) return structuredClone(definition.stepAcceptances)
  const entries: Array<[string, SceneAcceptance]> = []
  for (const step of getReviewSteps(definition.steps)) {
    const acceptance = getStepAcceptance(definition, step.id)
    if (acceptance) entries.push([step.id, structuredClone(acceptance)])
  }
  return Object.fromEntries(entries)
}

/** 只在比较时忽略无效空标准条目；界面和运行均把空条目视作未配置，不能留下永久待审草案。 */
function comparableDefinition(definition: CapabilitySceneDefinition): CapabilitySceneDefinition {
  if (definition.stepAcceptances === undefined) return definition
  return {
    ...definition,
    stepAcceptances: Object.fromEntries(Object.entries(definition.stepAcceptances)
      .filter(([stepId]) => getStepAcceptance(definition, stepId) !== null)),
  }
}

/** 统一使用键顺序无关的完整值比较，避免格式差异制造重复采纳。 */
function equal(before: unknown, after: unknown): boolean {
  return stableCapabilityValueKey(before) === stableCapabilityValueKey(after)
}

/** 结构关联需整体审核，局部入口永远不会静默扩大批准范围。 */
function structureError(): Error {
  return new Error('涉及流程结构或依赖变化，请审核整份草案后采纳')
}
