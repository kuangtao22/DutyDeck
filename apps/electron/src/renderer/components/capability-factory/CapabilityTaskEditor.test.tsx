import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CapabilityTaskEditor } from './CapabilityTaskEditor'

/** 接收覆盖属性并返回静态标记，用于检查只读展示与提交默认行为。 */
function renderEditor(overrides: Partial<React.ComponentProps<typeof CapabilityTaskEditor>> = {}): string {
  return renderToStaticMarkup(
    <CapabilityTaskEditor
      id="result-output"
      value={'{\n  "characters": []\n}'}
      format="json"
      disabled={false}
      invalid={false}
      describedBy="result-output-hint"
      onChange={() => undefined}
      {...overrides}
    />,
  )
}

describe('任务编辑器只读输出模式', () => {
  test('Given 运行结果 When 只读展示 Then 文本可选择但不能编辑且不显示格式化操作', () => {
    const html = renderEditor({ readOnly: true, ariaLabel: '本次输出' })

    expect(html).toContain('aria-label="本次输出"')
    expect(html).toContain('readonly=""')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('格式化 JSON')
  })

  test('Given 详情栏 When 撑满展示 Then 编辑器占满剩余高度且移除弹窗固定高度', () => {
    const html = renderEditor({ readOnly: true, fillHeight: true })

    expect(html).toContain('min-h-0 flex-1')
    expect(html).not.toContain('h-80')
    expect(html).not.toContain('max-h-[50dvh]')
  })

  test('Given Markdown 运行结果 When 只读展示 Then 仍提供安全预览入口', () => {
    const html = renderEditor({
      readOnly: true,
      format: 'markdown',
      value: '# 输出',
      ariaLabel: 'Markdown 输出',
    })

    expect(html).toContain('预览 Markdown')
    expect(html).not.toContain('返回编辑')
  })
})
