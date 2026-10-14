import { describe, expect, test } from 'bun:test'

describe('右侧工作区顶部标签栏', () => {
  test('Given 全局工具菜单迁移后 When 检查顶部标签栏 Then 不再持有应用工具菜单或打开动作合同', async () => {
    const source = await Bun.file(new URL('./DiffPanelTabBar.tsx', import.meta.url)).text()

    expect(source).not.toContain('onOpenCanvas?:')
    expect(source).not.toContain('openCanvasDisabled?:')
    expect(source).not.toContain('WorkspaceMenuEntryInput')
    expect(source).not.toContain('showWorkspaceMenu')
    expect(source).not.toContain('添加右侧工作区标签')
  })
})
