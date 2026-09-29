/**
 * 提交弹窗的测试落在**表单**上：Radix 弹窗走 Portal，SSR 取不到内容
 * （与 SceneDialog / ConfirmDialog 同样的取舍）。
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createEmptySceneDefinition } from '@proma/shared'
import { CapabilityFactorySubmitDialog, CapabilityFactorySubmitForm } from './CapabilityFactorySubmitDialog'

/** 一个带四类输入的场景：在同一编辑框内保留各字段的类型。 */
const definition = {
  ...createEmptySceneDefinition('小说角色提取'),
  inputs: [
    { name: 'chapterText', type: 'string' as const, description: '一章正文' },
    { name: 'catalogIndex', type: 'number' as const },
    { name: 'existingSnapshot', type: 'object' as const },
    { name: 'knownCharacters', type: 'array' as const },
  ],
}

/** 渲染表单；不参与断言的交互回调用空实现。 */
function renderForm(overrides: Partial<React.ComponentProps<typeof CapabilityFactorySubmitForm>> = {}): string {
  return renderToStaticMarkup(
    <CapabilityFactorySubmitForm
      definition={definition}
      submitting={false}
      error={null}
      onSubmit={() => undefined}
      onClose={() => undefined}
      {...overrides}
    />,
  )
}

describe('提交任务弹窗', () => {
  test('Given 已保存任务 When 下次打开 Then 自动回填最近输入并可直接运行', () => {
    const html = renderForm({ savedTasks: [{
      id: 'task-1', sceneId: 'scene-1', createdAt: 1, updatedAt: 2,
      input: { chapterText: '小林走进书店。', catalogIndex: 0, existingSnapshot: { count: 2 }, knownCharacters: ['小林'] },
    }] })

    expect(html).toContain('已保存任务')
    expect(html).toContain('小林走进书店。')
    expect(html).toContain('&quot;catalogIndex&quot;: 0')
    expect(html).toContain('&quot;count&quot;: 2')
    expect(html).toContain('&quot;小林&quot;')
    expect(html).toContain('开始运行')
    expect(html).toContain('当前提示词和评审标准')
  })

  test('Given 无已保存任务 When 首次打开 Then 说明提交自动保存且不增加空选择器', () => {
    const html = renderForm()
    expect(html).toContain('提交后自动保存')
    expect(html).not.toContain('已保存任务')
  })

  test('Given 弹窗关闭 When 渲染 Then 不产生任何节点', () => {
    const html = renderToStaticMarkup(
      <CapabilityFactorySubmitDialog
        open={false}
        definition={definition}
        submitting={false}
        error={null}
        onOpenChange={() => undefined}
        onSubmit={() => undefined}
      />,
    )

    expect(html).toBe('')
  })

  test('Given 多字段场景 When 渲染 Then 只有一个输入框，字段说明收起', () => {
    const html = renderForm()

    expect(html.match(/<textarea/g)).toHaveLength(1)
    expect(html).not.toContain('<input')
    expect(html).toContain('完整输入 · JSON')
    expect(html).toContain('data-task-editor="json"')
    expect(html).toContain('格式化 JSON')
    expect(html).toContain('<details')
    expect(html).toContain('一章正文')
    expect(html).toContain('开始运行')
    /** 对象与数组的初始值是空数组 / 空对象，比空输入框更接近真实形状。 */
    expect(html).toContain('[]')
    expect(html).toContain('{}')
  })

  test('Given 一个正文及可选上下文 When 新建 Then 默认直接粘贴内容', () => {
    const html = renderForm({ definition: { ...definition, inputs: [definition.inputs[0]!, { ...definition.inputs[3]!, required: false }] } })
    expect(html.match(/<textarea/g)).toHaveLength(1)
    expect(html).toContain('粘贴本次需要处理的内容')
    expect(html).toContain('补充其他输入')
    expect(html).not.toContain('完整输入 · JSON')
    expect(html).toContain('自动识别')
    expect(html).toContain('待识别')
    expect(html).toContain('data-task-editor="text"')
    expect(html).not.toContain('格式化 JSON')
  })

  test('Given 已保存的 Markdown 正文 When 回填 Then 显示格式且保留单框与正文用途', () => {
    const html = renderForm({
      definition: { ...definition, inputs: [definition.inputs[0]!] },
      savedTasks: [{ id: 'markdown', sceneId: 'scene-1', createdAt: 1, updatedAt: 2, input: { chapterText: '# 第一章\n\n林舟走进书店。' } }],
    })
    expect(html).toContain('role="status"')
    expect(html).toContain('Markdown')
    expect(html).toContain('作为正文')
    expect(html).toContain('预览 Markdown')
    expect(html).toContain('data-task-editor="markdown"')
    expect(html.match(/<textarea/g)).toHaveLength(1)
    expect(html).toContain('# 第一章\n\n林舟走进书店。')
  })

  test('Given 上一次运行失败 When 渲染 Then 原因显示在弹窗里，输入不丢', () => {
    const html = renderForm({ error: '模型槽位 main 声明的模型「gpt-5.4」在本机渠道里找不到' })

    expect(html).toContain('找不到')
    expect(html).toContain('role="alert"')
  })

  test('Given 正在运行 When 渲染 Then 提交按钮与输入都锁住，避免重复提交', () => {
    const html = renderForm({ submitting: true })

    expect(html).toContain('animate-spin')
    expect(html.match(/ disabled=""/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
