import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunFileChangesSnapshot } from '@proma/shared'
import {
  createAgentRunFileChangesStore,
} from './agent-run-file-change-store'

/** 本文件独占的数据根，避免持久化测试污染真实 ~/.proma。 */
let temporaryRoot: string | undefined
/** 每个用例的存储实例使用临时消息路径，不读取进程默认数据根。 */
let store: ReturnType<typeof createAgentRunFileChangesStore>

/** 为测试配置进程级数据根，路径服务首次访问前必须完成此设置。 */
function prepareTemporaryDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-run-file-changes-'))
  temporaryRoot = root
  const sessionsDirectory = join(root, 'agent-sessions')
  store = createAgentRunFileChangesStore((sessionId) => {
    if (!sessionId || sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('\0')) {
      throw new Error('无效的会话 ID')
    }
    mkdirSync(sessionsDirectory, { recursive: true })
    return join(sessionsDirectory, `${sessionId}.jsonl`)
  })
  return root
}

/** 构造最小的主进程权威快照，调用方可覆盖特定边界字段。 */
function createSnapshot(overrides: Partial<AgentRunFileChangesSnapshot> = {}): AgentRunFileChangesSnapshot {
  const startedAt = overrides.startedAt ?? 1_700_000_000_000
  return {
    runId: String(startedAt),
    startedAt,
    files: [{
      path: '/workspace/src/example.ts',
      status: 'modified',
      statsState: 'complete',
      additions: 3,
      deletions: 1,
    }],
    ...overrides,
  }
}

/** 计算测试可直接写入的单轮文件位置，仅用于模拟磁盘损坏。 */
function snapshotPath(sessionId: string, runId: string): string {
  if (!temporaryRoot) throw new Error('测试数据根未初始化')
  return join(temporaryRoot, 'agent-sessions', '.run-file-changes', sessionId, `${runId}.json`)
}

afterEach(() => {
  if (temporaryRoot) {
    rmSync(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
})

describe('Agent 本轮文件统计持久化', () => {
  test('Given 历史会话尚未产生统计目录 When 读取 Then 兼容地返回空数组', () => {
    prepareTemporaryDataRoot()

    expect(store.readAgentRunFileChanges('session-without-history')).toEqual([])
  })

  test('Given 两轮权威快照 When 分别写入并读取 Then 保持每轮隔离且按开始时间排序', () => {
    prepareTemporaryDataRoot()
    const sessionId = 'session-persisted-runs'
    const later = createSnapshot({ startedAt: 1_700_000_000_200, runId: '1700000000200' })
    const earlier = createSnapshot({ startedAt: 1_700_000_000_100, runId: '1700000000100' })

    store.writeAgentRunFileChanges(sessionId, later)
    store.writeAgentRunFileChanges(sessionId, earlier)

    expect(store.readAgentRunFileChanges(sessionId)).toEqual([earlier, later])
  })

  test('Given 同一轮再次持久化 When 读取 Then 用新快照替换旧统计且不生成备份正文', () => {
    prepareTemporaryDataRoot()
    const sessionId = 'session-replace-run'
    const first = createSnapshot()
    const replacement = createSnapshot({
      endedAt: 1_700_000_000_050,
      files: [{ path: '/workspace/src/example.ts', status: 'deleted', statsState: 'complete', additions: 0, deletions: 4 }],
    })

    store.writeAgentRunFileChanges(sessionId, first)
    store.writeAgentRunFileChanges(sessionId, replacement)

    const filePath = snapshotPath(sessionId, first.runId)
    expect(store.readAgentRunFileChanges(sessionId)).toEqual([replacement])
    expect(existsSync(filePath + '.bak')).toBe(false)
  })

  test('Given 其中一轮文件损坏或超出读取预算 When 读取 Then 跳过异常轮并保留其它轮', () => {
    prepareTemporaryDataRoot()
    const sessionId = 'session-corrupted-file'
    const valid = createSnapshot({ startedAt: 1_700_000_000_100, runId: '1700000000100' })
    const corrupted = createSnapshot({ startedAt: 1_700_000_000_200, runId: '1700000000200' })
    const oversized = createSnapshot({ startedAt: 1_700_000_000_300, runId: '1700000000300' })

    store.writeAgentRunFileChanges(sessionId, valid)
    store.writeAgentRunFileChanges(sessionId, corrupted)
    store.writeAgentRunFileChanges(sessionId, oversized)
    writeFileSync(snapshotPath(sessionId, corrupted.runId), '{not-json', 'utf8')
    writeFileSync(snapshotPath(sessionId, oversized.runId), ' '.repeat(1_048_577), 'utf8')

    expect(store.readAgentRunFileChanges(sessionId)).toEqual([valid])
  })

  test('Given 路径穿越会话 ID 或伪造 runId When 读写 Then 在访问磁盘前拒绝', () => {
    prepareTemporaryDataRoot()

    expect(() => store.readAgentRunFileChanges('../outside')).toThrow('无效的会话 ID')
    expect(() => store.writeAgentRunFileChanges('safe-session', createSnapshot({ runId: '../outside' }))).toThrow('无效的本轮 ID')
    expect(() => store.writeAgentRunFileChanges('safe-session', createSnapshot({ revision: 0 }))).toThrow('无效的本轮文件统计快照')
  })

  test('Given 统计已落盘 When 工作区源文件随后改变 Then 读取仍返回原始数字', () => {
    prepareTemporaryDataRoot()
    const sourcePath = join(temporaryRoot!, 'workspace', 'example.ts')
    mkdirSync(join(temporaryRoot!, 'workspace'), { recursive: true })
    writeFileSync(sourcePath, 'before persistence\n', 'utf8')
    const snapshot = createSnapshot({ files: [{ path: sourcePath, status: 'modified', statsState: 'complete', additions: 3, deletions: 1 }] })
    store.writeAgentRunFileChanges('session-immutable-stats', snapshot)
    writeFileSync(sourcePath, 'changed after persistence\n', 'utf8')

    expect(store.readAgentRunFileChanges('session-immutable-stats')).toEqual([snapshot])
  })

  test('Given 会话被删除 When 清理本轮统计 Then 仅移除该会话的统计目录', () => {
    prepareTemporaryDataRoot()
    store.writeAgentRunFileChanges('session-remove-a', createSnapshot())
    store.writeAgentRunFileChanges('session-remove-b', createSnapshot())

    store.removeAgentRunFileChanges('session-remove-a')

    expect(store.readAgentRunFileChanges('session-remove-a')).toEqual([])
    expect(store.readAgentRunFileChanges('session-remove-b')).toHaveLength(1)
  })
})
