import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import { productivityToolsAtom } from '@/atoms/ui-preferences'
import { WorkspaceTools } from './WorkspaceTools'

describe('常驻工具菜单', () => {
  test('Given 默认 Agent 未打开会话 When 渲染 Then 包含交互设计的 15 项入口可发现且资源入口说明不可用原因', () => {
    /** 独立 store 不触碰真实配置或 IPC。 */
    const store = createStore()
    const html = renderToStaticMarkup(<Provider store={store}><WorkspaceTools /></Provider>)
    expect((html.match(/data-tool-id=/g) ?? []).length).toBe(15)
    // 交互设计与其他项目工具一样保持可发现，无 Agent 会话时禁止进入。
    expect(html).toMatch(/<button\b[^>]*data-tool-id="interaction-design"[^>]*disabled=""/)
    expect(html).toContain('data-expanded="false"')
    expect(html).toContain('先打开 Agent 会话')
    expect(html).toContain('aria-label="外观设置"')
  })

  test('Given Chat 与关闭的效率工具 When 渲染 Then 保留可用整页入口并隐藏受限入口', () => {
    /** Chat 中不复用后台 Agent 会话的项目能力入口。 */
    const store = createStore()
    store.set(appModeAtom, 'chat')
    store.set(productivityToolsAtom, { todosEnabled: false, calendarEnabled: true, obsidianEnabled: false })
    const html = renderToStaticMarkup(<Provider store={store}><WorkspaceTools /></Provider>)
    expect(html).not.toContain('data-tool-id="todos"')
    expect(html).not.toContain('data-tool-id="vault"')
    expect(html).not.toContain('data-tool-id="skills"')
    // Chat 不借用后台 Agent 项目，交互设计入口显示但禁用。
    expect(html).toMatch(/<button\b[^>]*data-tool-id="interaction-design"[^>]*disabled=""/)
    expect(html).toContain('data-tool-id="automations"')
    expect(html).toContain('data-tool-id="calendar"')
  })
})
