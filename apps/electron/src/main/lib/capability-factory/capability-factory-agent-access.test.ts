import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { createCapabilityFactoryAgentAccess } from './capability-factory-agent-access'

describe('工厂 Agent 准入与持续归属', () => {
  test('Given 普通前台会话 When 项目迁移或归档 Then 旧入口立即失效', () => {
    let session = { id: 's1', workspaceId: 'w1' } as AgentSessionMeta
    const access = createCapabilityFactoryAgentAccess({ sessionId: 's1', toolMode: 'standard', getSession: () => session,
      getRootDir: (id) => `/fixture/${id}`, assertWritable: () => {},
    })
    expect(access?.rootDir).toBe('/fixture/w1')
    access?.assertCurrent()
    session = { ...session, workspaceId: 'w2' }
    expect(() => access?.assertCurrent()).toThrow('归属')
  })
  test('Given 后台或受限来源 When 创建工厂入口 Then 不扩大操作权限', () => {
    const session = { id: 's1', workspaceId: 'w1' } as AgentSessionMeta
    const options = { sessionId: 's1', toolMode: 'standard', getSession: () => session, getRootDir: () => '/fixture', assertWritable: () => {} }
    for (const triggeredBy of ['automation', 'delegation', 'external'] as const) {
      expect(createCapabilityFactoryAgentAccess({ ...options, triggeredBy })).toBeNull()
    }
    expect(createCapabilityFactoryAgentAccess({ ...options, toolMode: 'server-ops-write' })).toBeNull()
    expect(createCapabilityFactoryAgentAccess({ ...options, automation: true })).toBeNull()
    expect(createCapabilityFactoryAgentAccess({ ...options, getSession: () => ({ ...session, archived: true }) })).toBeNull()
  })
})
