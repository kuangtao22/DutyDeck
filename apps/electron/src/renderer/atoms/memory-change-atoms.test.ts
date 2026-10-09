import { describe, expect, test } from 'bun:test'
import { matchesMemoryNavigation, type WorkspaceMemoryNavigationRequest } from './memory-change-atoms'

describe('记忆通知目标隔离', () => {
  test('Given 同项目的能力中心和多个会话都挂载 When 收到会话Diff请求 Then 只有目标会话消费', () => {
    const request: WorkspaceMemoryNavigationRequest = { workspaceSlug: 'project', sessionId: 'session-a', relativePath: 'notes.md', mode: 'change' }
    expect(matchesMemoryNavigation(request, 'project', 'session-a')).toBe(true)
    expect(matchesMemoryNavigation(request, 'project', 'session-b')).toBe(false)
    expect(matchesMemoryNavigation(request, 'project')).toBe(false)
    expect(matchesMemoryNavigation(request, 'other', 'session-a')).toBe(false)
  })

  test('Given 无会话身份的文件导航 When 能力中心消费 Then 不跳转后台会话且不接受无目标Diff', () => {
    const request: WorkspaceMemoryNavigationRequest = { workspaceSlug: 'project', relativePath: 'notes.md', mode: 'edit' }
    expect(matchesMemoryNavigation(request, 'project')).toBe(true)
    expect(matchesMemoryNavigation(request, 'project', 'session-a')).toBe(false)
    expect(matchesMemoryNavigation({ ...request, mode: 'change' }, 'project')).toBe(false)
    expect(matchesMemoryNavigation(null, 'project')).toBe(false)
  })
})
