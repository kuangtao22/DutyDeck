import { describe, expect, test } from 'bun:test'
import { createEmptySceneDefinition, diffSceneDefinition, getStepAcceptance } from './capability-factory'

describe('场景定义差异（审批卡与面板共用同一份措辞）', () => {
  test('Given 仅步骤标准修改 When 比较 Then 审批可见且新场景不会回退共用标准', () => {
    const before = createEmptySceneDefinition('场景')
    const acceptance = { criteria: ['原文证据'], judgePrompt: '核对', metrics: [] }
    const after = { ...before, acceptance, stepAcceptances: { scan: acceptance } }
    expect(getStepAcceptance(after, 'scan')).toEqual(acceptance)
    expect(getStepAcceptance(after, 'missing')).toBeNull()
    expect(getStepAcceptance({ ...after, stepAcceptances: undefined }, 'missing')).toEqual(acceptance)
    expect(diffSceneDefinition({ ...after, stepAcceptances: {} }, after)).toEqual([
      { kind: 'acceptance', detail: '评审（判据 / 评审提示词 / 指标权重）已修改' },
    ])
  })
  test('Given 两份完全相同的定义 When 计算差异 Then 返回空数组，界面据此说"没有差异"', () => {
    const base = createEmptySceneDefinition('小说角色提取')

    expect(diffSceneDefinition(base, createEmptySceneDefinition('小说角色提取'))).toEqual([])
  })

  test('Given 空模板与 Agent 的提案 When 计算差异 Then 逐条给出新增的步骤 / 输出 / 评审', () => {
    const before = createEmptySceneDefinition('小说角色提取')
    const after = {
      ...createEmptySceneDefinition('小说角色提取'),
      outputs: [{
        name: 'characters',
        from: { stepId: 'scan' },
        shape: 'structured' as const,
      }],
      steps: [{
        id: 'scan',
        title: '扫描本批人物候选',
        type: 'extract' as const,
        modelSlot: 'main',
        prompt: '按段落扫描',
        judgeFields: [{ name: 'name', type: 'string' as const }],
      }],
      acceptance: {
        criteria: ['每个角色都必须有段落引用'],
        judgePrompt: '逐条核对证据',
        metrics: [{ name: 'anchorRecall', weight: 1, direction: 'positive' as const }],
      },
    }

    const changes = diffSceneDefinition(before, after)
    const lines = changes.map((change) => change.detail)

    expect(lines).toContain('新增 步骤 1 项：scan')
    expect(lines).toContain('输出声明已修改（现为：characters）')
    expect(lines).toContain('评审（判据 / 评审提示词 / 指标权重）已修改')
    /** 输入契约没动就不该出现，否则清单会淹掉真正的改动。 */
    expect(lines.some((line) => line.includes('输入契约'))).toBe(false)
  })

  test('Given 同名但提示词改了 When 计算差异 Then 认成"修改步骤"而不是增删', () => {
    const step = {
      id: 'scan',
      title: '扫描本批人物候选',
      type: 'extract' as const,
      modelSlot: 'main',
      prompt: '旧提示词',
      judgeFields: [{ name: 'name', type: 'string' as const }],
    }
    const before = { ...createEmptySceneDefinition('小说角色提取'), steps: [step] }
    const after = {
      ...createEmptySceneDefinition('小说角色提取'),
      steps: [{ ...step, prompt: '新提示词' }],
    }

    expect(diffSceneDefinition(before, after).map((change) => change.detail)).toEqual(['修改 步骤 1 项：scan'])
  })
})
