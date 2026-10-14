import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Globe, Workflow } from 'lucide-react'
import { WorkspaceToolRail, filterWorkspaceTools, type WorkspaceToolRailItem } from './WorkspaceToolRail'

/** 最小工具夹具：验证可用入口与未就绪工具同时呈现。 */
const items: WorkspaceToolRailItem[] = [
  { id: 'browser', label: '新建浏览器标签', group: '工作区', icon: Globe, active: true, keywords: 'web 浏览网页' },
  { id: 'canvas', label: '画布', group: '专业工具', icon: Workflow, disabledReason: '请先选择项目' },
]

/** 仅渲染展示层，不访问真实会话、文件或 Electron API。 */
function renderRail(expanded: boolean): string {
  return renderToStaticMarkup(<WorkspaceToolRail expanded={expanded} items={items} onExpandedChange={() => {}} onSelect={() => {}} onAppearance={() => {}} />)
}

describe('统一工具菜单', () => {
  test('Given 收起状态 When 渲染 Then 保留工具名称和展开搜索入口且占用 78px', () => {
    const markup = renderRail(false)
    expect(markup).toContain('width:78px')
    expect(markup).toContain('aria-label="新建浏览器标签"')
    expect(markup).toContain('aria-label="展开并搜索工具"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('type="search"')
  })
  test('Given 展开状态 When 渲染 Then 显示分组与搜索并占用 208px', () => {
    const markup = renderRail(true)
    expect(markup).toContain('width:208px')
    expect(markup).toContain('type="search"')
    expect(markup).toContain('工作区')
    expect(markup).toContain('专业工具')
    expect(markup).toContain('aria-label="外观设置"')
  })
  test('Given 选中和禁用工具 When 渲染 Then 沿用主题选中态并明确禁用原因', () => {
    const markup = renderRail(false)
    expect(markup).toContain('bg-accent-foreground/[0.10]')
    expect(markup).toContain('text-accent-foreground')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('title="画布：请先选择项目"')
    expect(markup).toContain('disabled=""')
  })
  test('Given 查询 When 过滤 Then 按名称关键词和分组匹配、忽略大小写空白且无匹配为空', () => {
    expect(filterWorkspaceTools(items, ' WEB ')).toEqual([items[0]!])
    expect(filterWorkspaceTools(items, '专业')).toEqual([items[1]!])
    expect(filterWorkspaceTools(items, '不存在')).toEqual([])
    expect(filterWorkspaceTools(items, ' ')).toEqual(items)
  })
})
