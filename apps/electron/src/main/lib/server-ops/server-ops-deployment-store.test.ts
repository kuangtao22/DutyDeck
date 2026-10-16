import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerOpsDeploymentRun, ServerOpsDeploymentTarget, ServerOpsDeploymentTargetSaveInput } from '@proma/shared'
import { ServerOpsDeploymentStore } from './server-ops-deployment-store'

const projectId = '10000000-0000-4000-8000-000000000001'
const hostId = '10000000-0000-4000-8000-000000000002'
const targetId = '10000000-0000-4000-8000-000000000003'
const writerId = '10000000-0000-4000-8000-000000000004'
const digest = `sha256:${'a'.repeat(64)}`

/** 构造一份不连接真实主机的已纳管目标。 */
function target(): ServerOpsDeploymentTarget {
  return { id: targetId, projectId, hostId, name: 'TaokoPlay', environment: 'production', composeProject: 'taokoplay', composeFile: '/vol1/docker/taokoplay/current/deploy/fnos/compose.yml', sourceUrl: 'https://gitee.com/kuangtao/taoko-play-website', registry: '', accessUrl: 'https://www.taokoplay.com', revision: 1, createdAt: 1, updatedAt: 1 }
}

/** 去掉由 Store 生成的 revision 与时间戳，构造严格的保存输入。 */
function targetInput(overrides: Partial<ServerOpsDeploymentTargetSaveInput['target']> = {}): ServerOpsDeploymentTargetSaveInput['target'] {
  const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = target()
  return { ...input, ...overrides }
}

/** 构造一份已经持久化执行意图的运行记录。 */
function run(status: ServerOpsDeploymentRun['status'] = 'running'): ServerOpsDeploymentRun {
  return { id: '10000000-0000-4000-8000-000000000005', targetId, targetRevision: 1, projectId, hostId, writerId, revision: 1, planHash: digest, bundleHash: digest, kind: 'release', status, startedAt: 1, updatedAt: 1, summary: '' }
}

describe('Given 独立部署 Store 使用隔离目录', () => {
  test('When 保存目标并追加运行 Then revision/CAS 和历史都持久化', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dutydeck-deployment-'))
    try {
      let now = 2
      const store = new ServerOpsDeploymentStore(directory, { now: () => now, transaction: <T>(callback: () => T): T => callback() })
      const saved = store.saveTarget({ target: targetInput(), expectedRevision: 0 })
      expect(saved.revision).toBe(1)
      now = 3
      const appended = store.appendRun(run())
      expect(store.listRuns({ projectId, hostId })[0]?.id).toBe(appended.id)
      expect(() => store.saveTarget({ target: targetInput({ name: 'changed' }), expectedRevision: 1 })).toThrow('TARGET_BUSY')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  test('When writer 或 revision 不匹配 Then 不能推进运行', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dutydeck-deployment-'))
    try {
      const store = new ServerOpsDeploymentStore(directory, { transaction: <T>(callback: () => T): T => callback() })
      store.saveTarget({ target: targetInput(), expectedRevision: 0 })
      store.appendRun(run())
      expect(() => store.transitionRun({ id: run().id, writerId: '10000000-0000-4000-8000-000000000006', expectedRevision: 1, status: 'verifying', summary: '' })).toThrow('CAS_CONFLICT')
      expect(() => store.transitionRun({ id: run().id, writerId, expectedRevision: 2, status: 'verifying', summary: '' })).toThrow('CAS_CONFLICT')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  test('When 运行结果未知 Then 只能保留占用并拒绝直接终结', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dutydeck-deployment-'))
    try {
      const store = new ServerOpsDeploymentStore(directory, { transaction: <T>(callback: () => T): T => callback() })
      store.saveTarget({ target: targetInput(), expectedRevision: 0 })
      store.appendRun(run())
      const unknown = store.markUnknown(run().id, writerId, 1, '连接中断，结果待核对')
      expect(unknown.status).toBe('unknown')
      expect(() => store.transitionRun({ id: run().id, writerId, expectedRevision: unknown.revision, status: 'succeeded', summary: '错误恢复', stoppedEvidenceHash: digest })).toThrow('IMMUTABLE')
      expect(() => store.saveTarget({ target: targetInput({ name: 'changed' }), expectedRevision: 1 })).toThrow('TARGET_BUSY')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
