import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsDataSource } from '@proma/shared'
import { ServerOpsAgentReadAccess } from './ServerOpsAgentReadAccess'
import type { ServerOpsConnection } from './server-ops-connections'

const connections: readonly ServerOpsConnection[] = [
  { id: 'ssh:host-1', kind: 'ssh', projectId: 'project-1', label: '生产服务器', detail: 'root@10.0.0.1:22', hostId: 'host-1', connected: true },
  { id: 'data:mysql-1', kind: 'database', projectId: 'project-1', label: '业务库', detail: '127.0.0.1:3306', sourceId: 'mysql-1' },
  { id: 'data:redis-1', kind: 'redis', projectId: 'project-2', label: '缓存', detail: '127.0.0.1:6379', sourceId: 'redis-1' },
]
const dataSources: readonly ServerOpsDataSource[] = [
  { id: 'mysql-1', projectId: 'project-1', transport: 'direct', engine: 'mysql', label: '业务库', address: '127.0.0.1', port: 3306, tlsMode: 'verify', hasPassword: true, createdAt: 1, updatedAt: 1 },
  { id: 'redis-1', projectId: 'project-2', transport: 'direct', engine: 'redis', label: '缓存', address: '127.0.0.1', port: 6379, tlsMode: 'verify', hasPassword: true, createdAt: 1, updatedAt: 1 },
]

describe('ServerOpsAgentReadAccess', () => {
  test('Given 数据库工具栏 When 渲染 Then 只显示禁用表入口且不展示板块授权', () => {
    const html = renderToStaticMarkup(<ServerOpsAgentReadAccess projectId="project-1" connectionId="data:mysql-1" allConnections={connections} dataSources={dataSources} policyApi={{ get: async () => ({ revision: 0, exclusions: [] }), set: async () => ({ revision: 1, exclusions: [] }) }} />)
    expect(html).toContain('aria-label="管理禁用表"')
    expect(html.match(/<button\b/g)?.length).toBe(1)
    expect(html).not.toContain('Agent 授权')
    expect(html).not.toContain('当前会话工具模式')
  })

  test('Given 无 Agent 会话但持久规则可用 When 渲染 Then 仍可管理禁用表', () => {
    const html = renderToStaticMarkup(<ServerOpsAgentReadAccess projectId="project-1" connectionId="data:mysql-1" allConnections={connections} dataSources={dataSources}
      policyApi={{ get: async () => ({ revision: 0, exclusions: [] }), set: async () => ({ revision: 1, exclusions: [] }) }} />)
    expect(html).toContain('aria-label="管理禁用表"')
    expect(html).not.toMatch(/aria-label="管理禁用表"[^>]*disabled=""/)
  })

  test('Given 从数据库连接进入禁用表编辑 When 渲染 Then 不显示会话授权控件或授权保存文案', () => {
    /** 数据库只维护持久禁用表；不应再出现服务器 Agent 授权模式切换。 */
    const html = renderToStaticMarkup(<ServerOpsAgentReadAccess projectId="project-1" connectionId="data:mysql-1"
      allConnections={connections} dataSources={dataSources} />)
    expect(html).toContain('aria-label="管理禁用表"')
    expect(html).not.toContain('当前会话工具模式')
    expect(html).not.toContain('运维读写')
    expect(html).not.toContain('保存授权')
  })
})
