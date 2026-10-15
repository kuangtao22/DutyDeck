import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { createInteractionDesignAgentAccess } from './agent-access'

/** 构造只记录准入边界的会话，实际命令行为由 access/store 测试覆盖。 */
function fixture() {
  const state = { session: { id: 'session-1', workspaceId: 'project-1' } as AgentSessionMeta, active: true, writable: true }
  const options = {
    sessionId: 'session-1', toolMode: 'standard', automation: false,
    getSession: () => state.session,
    assertRunActive: () => { if (!state.active) throw new Error('运行已取消') },
    canWrite: () => state.writable,
    createAccess: (_id: string, dependencies: { assertCaller(): void; canWrite(): boolean }) => ({
      workspaceId: 'project-1', assertCurrent: dependencies.assertCaller,
      execute: async () => { throw new Error('本测试不执行领域命令') },
    }),
  }
  return { state, options }
}

describe('交互设计 Agent 准入', () => {
  test('Given 非普通前台来源 When 构建工具 Then 不获得能力', () => {
    const { options, state } = fixture()
    for (const triggeredBy of ['automation', 'delegation', 'external']) expect(createInteractionDesignAgentAccess({ ...options, triggeredBy })).toBeNull()
    expect(createInteractionDesignAgentAccess({ ...options, automation: true })).toBeNull()
    expect(createInteractionDesignAgentAccess({ ...options, toolMode: 'server-ops-write' })).toBeNull()
    for (const fields of [{ archived: true }, { parentSessionId: 'parent' }, { sourceAutomationId: 'automation' }, { automationGraduated: true }, { explorationParentSessionId: 'parent' }, { sourceDesignProjectId: 'project-1' }]) {
      state.session = { id: 'session-1', workspaceId: 'project-1', ...fields } as AgentSessionMeta
      expect(createInteractionDesignAgentAccess(options)).toBeNull()
    }
  })
  test('Given 已注册普通会话 When 取消或变更归属 Then 旧工具立即失效', () => {
    const { options, state } = fixture()
    const access = createInteractionDesignAgentAccess(options)!
    access.assertCurrent()
    state.active = false
    expect(() => access.assertCurrent()).toThrow('运行已取消')
    state.active = true; state.session.workspaceId = 'project-2'
    expect(() => access.assertCurrent()).toThrow('归属')
  })
})
