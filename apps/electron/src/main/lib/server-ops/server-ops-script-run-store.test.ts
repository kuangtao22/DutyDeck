import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerOpsScriptRunStore } from './server-ops-script-run-store'
import type { ServerOpsScriptRun } from '@proma/shared'

/** 本次用例创建的临时配置根，统一在 afterEach 清理。 */
const temporaryRoots: string[] = []

/** 创建隔离的临时配置根。 */
function createConfigRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-script-run-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop()!, { recursive: true, force: true })
})

/** 构造一条运行中记录；序号用于制造稳定顺序。 */
function createRun(ordinal: number, overrides: Partial<ServerOpsScriptRun> = {}): ServerOpsScriptRun {
  return {
    id: `run-${ordinal}`, scriptId: 'script-1', projectId: 'project-1', status: 'running',
    startedAt: ordinal, parameters: [], ...overrides,
  }
}

describe('脚本运行记录持久化', () => {
  test('Given 追加运行记录 When 补写终态 Then 保留状态与时间', () => {
    const store = new ServerOpsScriptRunStore(createConfigRoot())
    store.append(createRun(1))
    const finished = store.finish('run-1', { status: 'succeeded', finishedAt: 10, durationMs: 9, affectedRows: 3 })
    expect(finished).toMatchObject({ status: 'succeeded', affectedRows: 3 })
    expect(store.list()).toHaveLength(1)
  })

  test('Given 重复 runId When 追加 Then 拒绝', () => {
    const store = new ServerOpsScriptRunStore(createConfigRoot())
    store.append(createRun(1))
    expect(() => store.append(createRun(1))).toThrow('SERVER_OPS_SCRIPT_RUN_EXISTS')
  })

  test('Given 已补写终态 When 再次补写或补写未知记录 Then 拒绝或返回空', () => {
    const store = new ServerOpsScriptRunStore(createConfigRoot())
    store.append(createRun(1))
    store.finish('run-1', { status: 'failed', errorCode: 'SERVER_OPS_SCRIPT_FAILED' })
    expect(() => store.finish('run-1', { status: 'succeeded' })).toThrow('SERVER_OPS_SCRIPT_RUN_ALREADY_FINISHED')
    expect(store.finish('run-404', { status: 'succeeded' })).toBeUndefined()
  })

  test('Given 同一脚本超过容量 When 追加终态 Then 按最旧淘汰且保留运行中记录', () => {
    const store = new ServerOpsScriptRunStore(createConfigRoot())
    /** 先放一条永久保留的运行中记录。 */
    store.append(createRun(0))
    for (let ordinal = 1; ordinal <= 120; ordinal += 1) {
      store.append(createRun(ordinal))
      store.finish(`run-${ordinal}`, { status: 'succeeded', finishedAt: ordinal })
    }
    const runs = store.list({ limit: 200 })
    expect(runs.filter((run) => run.scriptId === 'script-1' && run.status !== 'running')).toHaveLength(100)
    /** 最旧的运行中记录永远不被淘汰。 */
    expect(runs.some((run) => run.id === 'run-0' && run.status === 'running')).toBe(true)
    /** 最新的终态记录仍在。 */
    expect(runs.some((run) => run.id === 'run-120')).toBe(true)
    /** 最旧的终态记录已被淘汰。 */
    expect(runs.some((run) => run.id === 'run-1')).toBe(false)
  })

  test('Given 多条脚本 When 按脚本与条数筛选 Then 只返回匹配项', () => {
    const store = new ServerOpsScriptRunStore(createConfigRoot())
    store.append(createRun(1))
    store.append(createRun(2, { scriptId: 'script-2', projectId: 'project-2' }))
    expect(store.list({ scriptId: 'script-2' })).toHaveLength(1)
    expect(store.list({ projectId: 'project-1' })).toHaveLength(1)
    expect(store.list({ limit: 1 })).toHaveLength(1)
  })

  test('Given 上次进程遗留的运行中记录 When 启动对账 Then 改写成未知且不编造结束时间', () => {
    const root = createConfigRoot()
    const store = new ServerOpsScriptRunStore(root)
    store.append(createRun(1))
    store.append(createRun(2))
    store.finish('run-2', { status: 'succeeded', finishedAt: 20, durationMs: 18 })

    /** 模拟重启：新实例启动时对账，只有残留的运行中记录被改写。 */
    const restarted = new ServerOpsScriptRunStore(root)
    expect(restarted.reconcileInterruptedRuns()).toBe(1)
    const runs = restarted.list({ limit: 10 })
    const interrupted = runs.find((run) => run.id === 'run-1')
    expect(interrupted).toMatchObject({ status: 'unknown', errorCode: 'SERVER_OPS_SCRIPT_RUN_INTERRUPTED' })
    /** 结束时间不可知时必须留空，不能让用户以为它真的在那个时刻结束。 */
    expect(interrupted?.finishedAt).toBeUndefined()
    expect(interrupted?.durationMs).toBeUndefined()
    /** 已终结的记录不受影响。 */
    expect(runs.find((run) => run.id === 'run-2')?.status).toBe('succeeded')
    /** 再次对账是幂等的。 */
    expect(restarted.reconcileInterruptedRuns()).toBe(0)
  })

  test('Given 坏运行记录文件 When 读取 Then 抛错而不是当成空库', () => {
    const root = createConfigRoot()
    const store = new ServerOpsScriptRunStore(root)
    store.append(createRun(1))
    writeFileSync(join(root, 'server-ops', 'script-runs.json'), '{"version":1,"runs":[{"id":"x"}]}', 'utf8')
    expect(() => new ServerOpsScriptRunStore(root).list()).toThrow()
  })
})
