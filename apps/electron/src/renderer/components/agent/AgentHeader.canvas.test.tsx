import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, AgentWorkspace } from '@proma/shared'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentSessionsAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { AgentHeader } from './AgentHeader'

/** 标题栏测试用的、明确归属项目的会话元数据。 */
const session: AgentSessionMeta = {
  id: 'session-1',
  title: '当前会话',
  workspaceId: 'workspace-1',
  createdAt: 1,
  updatedAt: 1,
}

/** 与测试会话匹配的项目索引项。 */
const workspace: AgentWorkspace = {
  id: 'workspace-1',
  name: 'TaokoPlay',
  slug: 'taokoplay',
  createdAt: 1,
  updatedAt: 1,
}

/** 用给定项目索引渲染标题栏，覆盖项目有效与失效两种边界。 */
function renderHeader(workspaces: AgentWorkspace[]): string {
  const store = createStore()
  store.set(agentSessionsAtom, [session])
  store.set(agentWorkspacesAtom, workspaces)
  return renderToStaticMarkup(
    <Provider store={store}>
      <AgentHeader sessionId={session.id} />
    </Provider>,
  )
}

describe('Agent 会话标题栏项目名称', () => {
  test('Given 会话归属有效项目 When 渲染标题栏 Then 在标题栏右侧显示项目名称', () => {
    const html = renderHeader([workspace])

    expect(html).toContain('TaokoPlay')
    expect(html).toContain('当前项目：TaokoPlay')
  })

  test('Given 会话项目已失效 When 渲染标题栏 Then 不显示误导性的项目占位名称', () => {
    const html = renderHeader([])

    expect(html).not.toContain('当前项目：')
    expect(html).not.toContain('TaokoPlay')
  })
})
