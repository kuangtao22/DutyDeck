import { describe, expect, test } from 'bun:test'
import { parseServerOpsReference, serializeServerOpsReference } from './server-ops-reference'

describe('运维资源引用协议', () => {
  test('保留服务器、数据库、库和表的稳定身份', () => {
    const references = [
      { scope: 'server' as const, projectId: 'project-1', hostId: 'host-1', label: '生产服务器' },
      { scope: 'connection' as const, projectId: 'project-1', sourceId: 'source-1', label: '订单库' },
      { scope: 'database' as const, projectId: 'project-1', sourceId: 'source-1', database: 'app', label: '订单库 · app' },
      { scope: 'table' as const, projectId: 'project-1', sourceId: 'source-1', database: 'app', table: 'users', label: 'app.users' },
    ]
    for (const reference of references) {
      expect(parseServerOpsReference(serializeServerOpsReference(reference))).toEqual(reference)
    }
  })

  test('拒绝缺少范围所需身份的伪造引用', () => {
    expect(parseServerOpsReference('&ops:%7B%22scope%22%3A%22table%22%2C%22projectId%22%3A%22p%22%7D::users')).toBeNull()
    expect(parseServerOpsReference('&ops:%7B%22scope%22%3A%22server%22%2C%22projectId%22%3A%22p%22%7D::生产机')).toBeNull()
  })

  test('协议正文不包含凭据字段', () => {
    const marker = serializeServerOpsReference({ scope: 'connection', projectId: 'p', sourceId: 's', label: '业务库' })
    expect(marker).not.toContain('password')
    expect(marker).not.toContain('连接串')
  })
})
