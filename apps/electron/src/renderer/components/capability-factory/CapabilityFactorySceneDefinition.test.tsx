import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createEmptySceneDefinition } from '@proma/shared'
import type { CapabilityScene } from '@proma/shared'
import { CapabilityFactorySceneDefinition } from './CapabilityFactorySceneDefinition'

/** 生成当前定义与候选标准不同的场景，检查显示范围不混用版本。 */
function sceneFixture(): CapabilityScene {
  return {
    id: 'scene-1', currentVersion: 3, createdAt: 1, updatedAt: 2,
    definition: {
      ...createEmptySceneDefinition('角色识别'),
      steps: [{ id: 'scan', title: '提取角色', type: 'llm', modelSlot: 'main', prompt: '提取原文中的角色' }],
      acceptance: { criteria: ['人物必须有原文证据'], judgePrompt: '核对每个人物的出处', metrics: [{ name: '证据覆盖率', weight: 1, direction: 'positive' }] },
      stepAcceptances: { scan: { criteria: ['扫描结果必须有段落引用'], judgePrompt: '只评扫描结果的证据', metrics: [] } },
    },
    draft: { definition: { ...createEmptySceneDefinition('候选'), acceptance: { criteria: ['候选独有判据'], judgePrompt: '候选提示词', metrics: [] } }, source: 'agent', note: '', createdAt: 2 },
  }
}

describe('场景定义分区', () => {
  test('Given 草案只改提示词 When 展示 Then 仅业务卡标记新版本且保持评审卡摘要', () => {
    const scene = sceneFixture()
    const candidate = structuredClone(scene.definition)
    const step = candidate.steps[0]!
    if ('prompt' in step) step.prompt = '修改后的提示词'
    scene.draft = { definition: candidate, source: 'agent', note: '调整', createdAt: 3 }
    const html = renderToStaticMarkup(<CapabilityFactorySceneDefinition scene={scene} onSelectStep={() => undefined} onSelectAcceptance={() => undefined} />)
    expect(html.match(/新版本 v4/g)).toHaveLength(1)
    expect(html).toContain('待采纳')
    expect(html).not.toContain('修改后的提示词')
    expect(html).not.toContain('扫描结果必须有段落引用')
  })

  test('Given 已采纳场景与待采纳草案 When 展示 Then 流程和标准都来自同一当前版本', () => {
    const html = renderToStaticMarkup(<CapabilityFactorySceneDefinition scene={sceneFixture()} onSelectStep={() => undefined} onSelectAcceptance={() => undefined} />)
    for (const label of ['业务流程', '流程评审标准', '提取角色', '1 条判据 · 0 个指标', 'v3']) expect(html).toContain(label)
    expect(html).not.toContain('扫描结果必须有段落引用')
    expect(html).not.toContain('只评扫描结果的证据')
    expect(html).toContain('编辑提取角色评审标准')
    expect(html).not.toContain('候选独有判据')
    expect(html).not.toContain('候选提示词')
  })

  test('Given 尚未配置标准 When 展示 Then 明确待配置而不虚构评分或逐步骤评审', () => {
    const scene = sceneFixture()
    scene.definition = createEmptySceneDefinition('新场景')
    const html = renderToStaticMarkup(<CapabilityFactorySceneDefinition scene={scene} onSelectStep={() => undefined} onSelectAcceptance={() => undefined} />)
    expect(html).toContain('还没有步骤')
    expect(html).toContain('还没有可评审的流程步骤')
    expect(html).not.toContain('核对每个人物的出处')
  })

  test('Given 多个流程步骤 When 展示 Then 每个流程和自己的评审标准按行相邻', () => {
    const scene = sceneFixture()
    const firstStep = scene.definition.steps[0]
    if (!firstStep) throw new Error('测试夹具缺少第一个流程步骤')
    scene.definition = {
      ...scene.definition,
      steps: [
        firstStep,
        { id: 'format', title: '整理人物信息', type: 'llm', modelSlot: 'main', prompt: '整理人物信息' },
      ],
      stepAcceptances: {
        scan: scene.definition.stepAcceptances?.scan ?? { criteria: [], judgePrompt: '', metrics: [] },
        format: { criteria: ['结果必须保留人物关系'], judgePrompt: '核对人物关系', metrics: [] },
      },
    }
    const html = renderToStaticMarkup(<CapabilityFactorySceneDefinition scene={scene} onSelectStep={() => undefined} onSelectAcceptance={() => undefined} />)
    // 静态 DOM 顺序与 CSS 网格共同保证：第一个流程单元后紧跟第一个评审单元。
    expect(html.indexOf('提取角色')).toBeLessThan(html.indexOf('编辑提取角色评审标准'))
    expect(html.indexOf('编辑提取角色评审标准')).toBeLessThan(html.indexOf('整理人物信息'))
    expect(html.indexOf('整理人物信息')).toBeLessThan(html.indexOf('编辑整理人物信息评审标准'))
  })
})
