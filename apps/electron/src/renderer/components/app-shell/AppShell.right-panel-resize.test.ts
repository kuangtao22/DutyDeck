import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('AppShell 右侧面板拖拽入口', () => {
  test('Given 右侧面板已展开 When 渲染边界手柄 Then 提供可发现的拖拽区域和无障碍说明', () => {
    /** 读取布局接线，锁定拖拽入口不会再次退化为透明窄线。 */
    const source = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8')

    expect(source).toContain('className="group absolute left-0 top-0 bottom-0 z-20 w-3 -translate-x-1/2 cursor-col-resize titlebar-no-drag"')
    expect(source).toContain('role="separator"')
    expect(source).toContain('aria-label="调整右侧面板宽度"')
    expect(source).toContain('title="拖动调整右侧面板宽度"')
  })
})
