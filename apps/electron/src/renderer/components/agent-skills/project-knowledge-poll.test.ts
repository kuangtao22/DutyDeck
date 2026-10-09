import { describe, expect, test } from 'bun:test'
import type { KnowledgeSnapshot } from '@proma/shared'
import { startKnowledgePolling, waitForKnowledgeScan } from './project-knowledge-poll'

/** 创建只包含轮询所需字段的固定快照。 */
function snapshot(status: KnowledgeSnapshot['scan']['status'], sourceCount = 0): KnowledgeSnapshot {
  return {
    projectId: 'workspace-1', initialized: true, revision: 1, entries: [], totalEntries: sourceCount,
    sourceCount, scan: { status, discovered: sourceCount, indexed: sourceCount, skipped: 0, changed: 0 },
    maintenance: { enabled: false, dailyJobLimit: 0, generation: 0 }, pendingTurns: 0,
  }
}

describe('知识面板轮询预算', () => {
  test('Given 请求尚未完成 When 到达后续间隔 Then 不排并发请求且卸载后不续排', async () => {
    /** 手动时钟只执行明确排入队列的回调。 */
    const callbacks: Array<() => void> = []
    let finish!: () => void
    let calls = 0
    const stop = startKnowledgePolling({ visible: () => true, intervalMs: 30_000,
      schedule: (callback) => { callbacks.push(callback); return 1 as unknown as ReturnType<typeof setTimeout> }, cancel: () => undefined,
      refresh: async () => { calls += 1; await new Promise<void>((resolve) => { finish = resolve }) },
    })
    callbacks.shift()!()
    expect(calls).toBe(1)
    expect(callbacks).toHaveLength(0)
    stop(); finish(); await Promise.resolve(); await Promise.resolve()
    expect(callbacks).toHaveLength(0)
  })

  test('Given 隐藏窗口 When 空闲轮询 Then 零 IPC 且使用30秒间隔', async () => {
    const callbacks: Array<() => void> = []
    const delays: number[] = []
    let calls = 0
    const stop = startKnowledgePolling({ visible: () => false, intervalMs: 30_000,
      schedule: (callback, delay) => { callbacks.push(callback); delays.push(delay); return 1 as unknown as ReturnType<typeof setTimeout> }, cancel: () => undefined,
      refresh: async () => { calls += 1 },
    })
    for (let minute = 0; minute < 120; minute += 1) { callbacks.shift()!(); await Promise.resolve() }
    stop()
    expect(calls).toBe(0)
    expect(delays.every((delay) => delay === 30_000)).toBe(true)
  })
})

describe('知识扫描完成后调度', () => {
  test('Given 扫描仍在运行 When 等待完成 Then 只在权威快照完成后返回', async () => {
    const states = [snapshot('running'), snapshot('completed', 3)]
    const seen: string[] = []
    const result = await waitForKnowledgeScan({
      initialSnapshot: snapshot('running'),
      getSnapshot: async () => states.shift()!,
      isCurrent: () => true,
      onSnapshot: (next) => { seen.push(next.scan.status) },
      delay: async () => undefined,
    })
    expect(result.scan.status).toBe('completed')
    expect(seen).toEqual(['running', 'completed'])
  })

  test('Given 扫描部分失败但已有来源 When 等待终态 Then 保留失败快照供 Agent 如实处理', async () => {
    const partial = snapshot('failed', 2)
    partial.scan.message = '部分文件不可读'
    const result = await waitForKnowledgeScan({
      initialSnapshot: partial,
      getSnapshot: async () => partial,
      isCurrent: () => true,
      onSnapshot: () => undefined,
    })
    expect(result.scan.message).toBe('部分文件不可读')
  })

  test('Given 项目切换或扫描取消 When 等待终态 Then 拒绝继续调度', async () => {
    await expect(waitForKnowledgeScan({
      initialSnapshot: snapshot('running'),
      getSnapshot: async () => snapshot('completed', 1),
      isCurrent: () => false,
      onSnapshot: () => undefined,
      delay: async () => undefined,
    })).rejects.toThrow('扫描已失效')
    await expect(waitForKnowledgeScan({
      initialSnapshot: snapshot('cancelled'),
      getSnapshot: async () => snapshot('cancelled'),
      isCurrent: () => true,
      onSnapshot: () => undefined,
    })).rejects.toThrow('扫描已取消')
  })
})
