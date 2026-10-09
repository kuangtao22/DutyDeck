/** 步骤定义只负责编辑；测试内容、执行与记录统一由运行页承载。 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createEmptySceneDefinition } from '@proma/shared'
import type { CapabilityScene, Step } from '@proma/shared'
import { CapabilityFactoryStepForm } from './CapabilityFactoryStepDialog'

/** 覆盖用户输入和前序步骤输出两种变量关系。 */
const extractStep: Step = {
  id: 'scan', title: '扫描人物候选', type: 'extract', modelSlot: 'main',
  prompt: '从 {{corpus}} 里找出人物，并与 {{known}} 去重',
  inputs: { corpus: { from: 'step-output', stepId: 'build' }, known: { from: 'workflow-input', field: 'knownCharacters' } },
  judgeFields: [{ name: 'characters', type: 'array' }],
}
/** 工具步骤没有提示词，仍能查看来源关系。 */
const toolStep: Step = {
  id: 'build', title: '构建批次正文', type: 'tool', capabilityId: 'corpus.build',
  bindings: { text: { from: 'workflow-input', field: 'chapterText' } },
}
/** 场景仅用于定义编辑，不装载运行数据。 */
const scene: CapabilityScene = {
  id: 'scene-1', definition: { ...createEmptySceneDefinition('小说角色提取'), steps: [toolStep, extractStep] },
  currentVersion: 2, draft: null, createdAt: 1, updatedAt: 2,
}
/** SSR 验证内容层，弹窗 Portal 的真实交互由预览验收。 */
function render(overrides: Partial<React.ComponentProps<typeof CapabilityFactoryStepForm>> = {}): string {
  return renderToStaticMarkup(<CapabilityFactoryStepForm scene={scene} step={extractStep} saving={false} error={null}
    onSave={() => undefined} onClose={() => undefined} {...overrides} />)
}

describe('步骤定义编辑', () => {
  test('Given 未采纳提示词草案 When 打开步骤 Then 默认显示版本对比及当前步骤采纳范围', () => {
    /** 基线与候选都保留，不能把草案当成已经生效的提示词。 */
    const candidate = structuredClone(scene)
    candidate.draft = { source: 'agent', createdAt: 3, note: '改提示词', definition: {
      ...candidate.definition, steps: [toolStep, { ...extractStep, prompt: '新提示词' }],
    } }
    const html = render({ scene: candidate, onAdoptDraft: () => undefined })
    expect(html).toContain('版本对比')
    expect(html).toContain('编辑草案')
    expect(html).toContain('草案 v3')
    expect(html).toContain('当前运行 v2')
    expect(html).toContain('仅当前步骤生效')
    expect(html).toContain('采纳当前步骤')
    expect(html).not.toContain('采纳整份草案')
    expect(html).not.toContain('<textarea')
  })

  test('Given 草案只修改其它步骤 When 打开当前步骤 Then 不显示当前步骤采纳按钮', () => {
    const candidate = structuredClone(scene)
    candidate.draft = { source: 'agent', createdAt: 3, note: '改其它步骤', definition: {
      ...candidate.definition, steps: [{ ...toolStep, title: '新标题' }, extractStep],
    } }
    const html = render({ scene: candidate, onAdoptDraft: () => undefined })
    expect(html).not.toContain('采纳当前步骤')
  })

  test('Given 模型步骤 When 打开 Then 只编辑提示词并保存，不包含另一套运行界面', () => {
    const html = render()
    expect(html).toContain('从 {{corpus}} 里找出人物')
    expect(html.match(/<textarea/g)).toHaveLength(1)
    expect(html).toContain('保存')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).not.toContain('role="tablist"')
    expect(html).not.toContain('试跑')
    expect(html).not.toContain('历史')
    expect(html).not.toContain('输入」中的内容')
    expect(html).toContain('运行')
  })
  test('Given 变量来自不同位置 When 查看定义 Then 来源折叠保留且没有测试输入框', () => {
    const html = render()
    expect(html).toContain('<details')
    expect(html).toContain('变量来源')
    expect(html).toContain('上一步输出 · build')
    expect(html).toContain('工作流输入 · knownCharacters')
    expect(html.match(/<textarea/g)).toHaveLength(1)
  })
  test('Given 工具步骤 When 打开 Then 保留能力和绑定说明而不提供提示词保存', () => {
    const html = render({ step: toolStep })
    expect(html).toContain('这一步没有提示词')
    expect(html).toContain('corpus.build')
    expect(html).toContain('chapterText')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('试跑')
  })
  test('Given 保存中或提示词为空 When 渲染 Then 阻止重复或空白保存', () => {
    expect(render({ saving: true })).toContain('保存中…')
    expect(render({ saving: true }).match(/ disabled=""/g)?.length).toBeGreaterThanOrEqual(2)
    expect(render({ step: { ...extractStep, prompt: '  ' } as Step })).toContain('disabled=""')
  })
  test('Given 保存失败 When 渲染 Then 提示词保留且显示错误', () => {
    const html = render({ error: '场景版本发生变化' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('场景版本发生变化')
    expect(html).toContain('从 {{corpus}} 里找出人物')
  })
})
