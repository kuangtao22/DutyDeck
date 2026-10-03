import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { ServerOpsAgentAccessStore } from './server-ops-agent-access-store'
import { ServerOpsAgentReadAccessPersistenceStore } from './server-ops-agent-read-access-persistence'

describe('服务器 Agent 只读授权持久化', () => {
  test('Given SSH/Redis 永久授权 When 一年后重启并显式撤销 Then 授权保留且撤销同步到其他实例', () => {
    /** 为授权文件创建独立临时配置目录，测试结束后只删除该目录。 */
    const configDir = mkdtempSync(join(tmpdir(), 'proma-agent-read-access-'))
    try {
      /** 测试以同步回调模拟生产配置事务，不依赖原生目录锁。 */
      const transaction = <T>(callback: () => T): T => callback()
      /** 用独立持久层实例模拟客户端重启或另一个运行实例。 */
      const createStore = (now: number): ServerOpsAgentAccessStore => new ServerOpsAgentAccessStore(
        { now: () => now },
        new ServerOpsAgentReadAccessPersistenceStore(configDir, { transaction }),
      )
      /** 首次授予同时覆盖 SSH 直连与 Redis 数据源授权。 */
      const firstInstance = createStore(1_000)
      const saved = firstInstance.grantRead({ sessionId: 'session-1', resources: [
        { kind: 'ssh', hostId: 'host-1' },
        { kind: 'redis', sourceId: 'redis-1' },
      ] }, [
        { key: 'ssh:host-1', fingerprint: 'a'.repeat(64), hostId: 'host-1' },
        { key: 'data:redis-1', fingerprint: 'b'.repeat(64) },
      ])

      /** 年后新 Store 必须从共享文件恢复授权，且新权限不含到期时间。 */
      const reopenedInstance = createStore(1_000 + 365 * 24 * 60 * 60 * 1_000)
      expect(saved?.expiresAt).toBeUndefined()
      expect(reopenedInstance.getReadAccess('session-1')?.resources).toEqual(saved?.resources)
      expect(reopenedInstance.getReadBinding('session-1', 'ssh:host-1')?.fingerprint).toBe('a'.repeat(64))

      /** 撤权由第二实例落盘后，第一实例 fresh-read 也必须立即失效。 */
      expect(reopenedInstance.revokeSession('session-1')).toBe(true)
      expect(firstInstance.getReadAccess('session-1')).toBeUndefined()
      expect(createStore(1_000 + 365 * 24 * 60 * 60 * 1_000).getReadAccess('session-1')).toBeUndefined()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
