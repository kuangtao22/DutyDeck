import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createEmptySceneDefinition, type CapabilityScene } from '@proma/shared'
import { CapabilityFactoryAcceptanceDialog, CapabilityFactoryAcceptanceForm } from './CapabilityFactoryAcceptanceDialog'

/** 构造带步骤级评审标准的场景，验证弹窗读取的是当前步骤而不是全局旧字段。 */
function scene(): CapabilityScene {
  return {
    id: 'scene-1', currentVersion: 2, createdAt: 1, updatedAt: 2, draft: null,
    definition: {
      ...createEmptySceneDefinition('角色识别'),
      steps: [{ id: 'scan', title: '识别角色', type: 'llm', modelSlot: 'main', prompt: '识别角色' }],
      acceptance: { criteria: ['旧版全局标准'], judgePrompt: '旧版提示词', metrics: [] },
      stepAcceptances: {
        scan: {
          criteria: ['每个角色都有原文证据'], judgePrompt: '只检查角色证据',
          metrics: [{ name: '证据覆盖率', weight: 1, direction: 'positive' }],
        },
      },
    },
  }
}

describe('步骤评审标准弹窗', () => {
  test('Given 弹窗打开 When 查看当前步骤 Then 展示可编辑的判据、提示词和指标', () => {
    const current = scene()
    const html = renderToStaticMarkup(<CapabilityFactoryAcceptanceForm
      scene={current} stepId="scan" acceptance={current.definition.stepAcceptances?.scan ?? null}
      saving={false} error={null} onSave={() => undefined} onClose={() => undefined}
    />)

    expect(html).toContain('每个角色都有原文证据')
    expect(html).toContain('只检查角色证据')
    expect(html).toContain('证据覆盖率')
    expect(html).toContain('保存')
    expect(html).toContain('保存并采纳仅让当前评审标准生效')
    expect(html).not.toContain('保存并采纳整份草案')
    expect(html).not.toContain('旧版全局标准')
  })

  test('Given 弹窗关闭 When 渲染 Then 不挂载编辑表单', () => {
    const html = renderToStaticMarkup(<CapabilityFactoryAcceptanceDialog
      open={false} sessionId="session-1" scene={scene()} stepId="scan"
      onSceneChanged={() => undefined} onOpenChange={() => undefined}
    />)

    expect(html).toBe('')
  })
})
