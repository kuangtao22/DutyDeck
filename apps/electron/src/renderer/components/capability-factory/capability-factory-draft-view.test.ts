import { describe, expect, test } from 'bun:test'
import { createEmptySceneDefinition, diffSceneDefinition, type CapabilityScene } from '@proma/shared'
import { buildSceneStepRows, findSceneStep, getStepDraftChange, updateStepPrompt } from './capability-factory-draft-view'

/** 当前版与草案同时修改提示词及评审，用于验证编辑不会丢其他改动。 */
function fixture(): CapabilityScene {
  const definition = { ...createEmptySceneDefinition('场景'), steps: [
    { id: 'scan', type: 'llm' as const, title: '扫描', modelSlot: 'main', prompt: '旧提示词' },
    { id: 'same', type: 'llm' as const, title: '整理', modelSlot: 'main', prompt: '不变' },
  ] }
  return { id: 'scene', definition, currentVersion: 2, createdAt: 1, updatedAt: 2,
    draft: { source: 'agent', note: '修订', createdAt: 2, definition: {
      ...definition, steps: [{ ...definition.steps[0]!, prompt: '新提示词' }, definition.steps[1]!],
      stepAcceptances: { scan: { criteria: ['新标准'], judgePrompt: '新评审', metrics: [] } },
    } } }
}

describe('步骤草案视图', () => {
  test('Given 提示词相同但顺序改变 When 比较 Then 标记位置及执行顺序差异', () => {
    const scene = fixture()
    scene.draft!.definition = structuredClone(scene.definition)
    scene.draft!.definition.steps.reverse()
    expect(buildSceneStepRows(scene).map((row) => row.change)).toEqual(['modified', 'modified'])
    expect(getStepDraftChange(scene, 'scan')).toMatchObject({ beforePosition: '1', afterPosition: '2', stepChanged: true })
    expect(diffSceneDefinition(scene.definition, scene.draft!.definition)).toEqual([
      { kind: 'steps', detail: '步骤顺序已调整：same → scan' },
    ])
  })

  test('Given 只有一个步骤改变 When 展示 Then 不给未修改步骤标记新版本', () => {
    const scene = fixture()
    expect(getStepDraftChange(scene, 'scan').stepChanged).toBe(true)
    expect(getStepDraftChange(scene, 'scan').acceptanceChanged).toBe(true)
    expect(getStepDraftChange(scene, 'same').stepChanged).toBe(false)
    expect(buildSceneStepRows(scene).map((row) => row.change)).toEqual(['modified', null])
    scene.draft = null
    expect(getStepDraftChange(scene, 'scan').stepChanged).toBe(false)
  })

  test('Given 草案新增和删除步骤 When 展示 Then 两者都可查看差异', () => {
    const scene = fixture()
    scene.draft!.definition.steps = [{ id: 'new', type: 'llm', title: '新增', modelSlot: 'main', prompt: '新步骤' }]
    expect(buildSceneStepRows(scene).map((row) => [row.step.id, row.change])).toEqual([
      ['scan', 'removed'], ['same', 'removed'], ['new', 'added'],
    ])
    expect(getStepDraftChange(scene, 'scan').after).toBeNull()
    expect(getStepDraftChange(scene, 'new').before).toBeNull()
  })

  test('Given 草案含并行子步骤和新标准 When 编辑子提示词 Then 保留其它改动且不改变原对象', () => {
    const scene = fixture()
    const definition = scene.draft!.definition
    definition.steps = [{ id: 'group', type: 'map', title: '并行', over: { from: 'workflow-input', field: 'items' }, body: definition.steps }]
    const edited = updateStepPrompt(definition, 'scan', '手动修订')
    expect(findSceneStep(edited, 'scan')).toMatchObject({ prompt: '手动修订' })
    expect(findSceneStep(definition, 'scan')).toMatchObject({ prompt: '新提示词' })
    expect(findSceneStep(edited, 'same')).toMatchObject({ prompt: '不变' })
    expect(edited.stepAcceptances).toEqual(definition.stepAcceptances)
    expect(() => updateStepPrompt(edited, 'missing', 'x')).toThrow()
  })
})
