/**
 * 新建场景弹窗的测试。
 *
 * 断言集中在**表单**上而不是弹窗上：Radix 弹窗走 Portal，`renderToStaticMarkup` 取不到内容，
 * 所以这里只对弹窗断言"关闭时不产生节点"，其余走 `CapabilityFactorySceneForm`
 * （与仓库里 `ConfirmDialog` 的测试同样的取舍）。
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CapabilityFactorySceneDialog, CapabilityFactorySceneForm } from './CapabilityFactorySceneDialog'

/** 渲染表单；不参与断言的交互回调用空实现。 */
function renderForm(overrides: Partial<React.ComponentProps<typeof CapabilityFactorySceneForm>> = {}): string {
  return renderToStaticMarkup(
    <CapabilityFactorySceneForm
      submitting={false}
      error={null}
      onSubmit={() => undefined}
      onClose={() => undefined}
      {...overrides}
    />,
  )
}

describe('新建场景弹窗', () => {
  test('Given 弹窗关闭 When 渲染 Then 不产生任何节点', () => {
    const html = renderToStaticMarkup(
      <CapabilityFactorySceneDialog
        open={false}
        submitting={false}
        error={null}
        onOpenChange={() => undefined}
        onSubmit={() => undefined}
      />,
    )

    expect(html).toBe('')
  })

  test('Given 表单展开 When 渲染 Then 只有一个名称输入与取消 / 创建两个按钮', () => {
    const html = renderForm()

    expect(html).toContain('场景名称')
    expect(html).toContain('取消')
    expect(html).toContain('创建场景')
    /** 抽屉底部的旧输入行必须已经不存在，否则会出现两个填名字的地方。 */
    expect(html).not.toContain('新场景名称')
  })

  test('Given 名称还是空的 When 渲染 Then 创建按钮不可用（空名字不发出请求）', () => {
    /** 输入框初值为空，所以这里断言的就是"刚打开"的状态。 */
    const html = renderForm()
    /** 取「创建场景」前面那个 button 标签本身，确认它带 disabled。 */
    const submitTag = html.slice(html.lastIndexOf('<button', html.indexOf('创建场景')), html.indexOf('创建场景'))

    expect(submitTag).toContain('disabled')
    expect(html).toContain('maxLength="60"')
  })

  test('Given 提交失败 When 渲染 Then 原因写在弹窗里，并标在输入框上', () => {
    const html = renderForm({ error: '场景名称不能为空' })

    expect(html).toContain('场景名称不能为空')
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-invalid="true"')
  })

  test('Given 提交进行中 When 渲染 Then 输入与两个按钮都锁住', () => {
    const html = renderForm({ submitting: true })

    /** 只数属性本身：Tailwind 的 `disabled:` 变体写在 class 里，不能算进去。 */
    expect(html.match(/ disabled=""/g)?.length).toBe(3)
    expect(html).toContain('animate-spin')
  })
})
