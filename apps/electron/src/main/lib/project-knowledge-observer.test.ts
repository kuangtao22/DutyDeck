import { describe, expect, mock, test } from 'bun:test'
import type { ProjectKnowledgeObserverDependencies, ProjectKnowledgeWatcher } from './project-knowledge-observer'

/** Observer 行为通过依赖注入验证，模块加载时隔离无关 Electron 运行时。 */
mock.module('./agent-workspace-manager', () => ({ listAgentWorkspaces: () => [] }))
mock.module('./config-paths', () => ({ getConfigDir: () => '/config', resolveWorkspaceFilesDir: () => '/managed-project' }))
mock.module('./project-knowledge-runtime', () => ({
  getProjectKnowledgeBinding: () => '',
  getProjectKnowledgeService: () => ({}),
  recoverProjectKnowledge: async () => undefined,
}))
mock.module('./project-knowledge-memory-journal', () => ({ replayWorkspaceMemoryOperations: () => [] }))

const { createProjectKnowledgeObserver } = await import('./project-knowledge-observer')

/** 构造可观察 close 次数的 watcher。 */
function watcher(): ProjectKnowledgeWatcher & { closed: number } {
  return { closed: 0, close() { this.closed += 1 } }
}

/** 创建不访问真实文件系统和定时器的 observer 依赖。 */
function fixture(overrides: Partial<ProjectKnowledgeObserverDependencies> = {}) {
  const state = {
    binding: 'binding-1',
    recoverCalls: 0,
    replayCalls: 0,
    scanCalls: 0,
    waitCalls: 0,
    watchers: [] as Array<ProjectKnowledgeWatcher & { closed: number }>,
    watchChanges: [] as Array<(filename: string | Buffer | null) => void>,
    timers: [] as Array<{ callback: () => void; delay: number; cleared: boolean }>,
  }
  const dependencies: ProjectKnowledgeObserverDependencies = {
    listWorkspaces: () => [{ id: 'workspace-1', slug: 'workspace-1', projectRootPath: '/project' }],
    getConfigRoot: () => '/config',
    resolveWorkspaceFilesDir: () => '/managed-project',
    getBinding: () => state.binding,
    getService: () => ({
      getSnapshot: async () => ({ initialized: true, scan: { status: 'idle' } }),
      startScan: async () => { state.scanCalls += 1 },
      waitForScan: async () => { state.waitCalls += 1 },
    }),
    replayMemoryOperations: () => { state.replayCalls += 1 },
    recoverKnowledge: async () => { state.recoverCalls += 1 },
    watchRoot: (_root, onChange) => {
      const handle = watcher()
      state.watchers.push(handle)
      state.watchChanges.push(onChange)
      return handle
    },
    now: () => 1_000,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false }
      state.timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true },
    ...overrides,
  }
  return { state, dependencies, observer: createProjectKnowledgeObserver(dependencies) }
}

describe('项目知识观察器', () => {
  test('Given 自定义资料库目录 When 连续保存正文与索引 Then 只刷新快照不重复扫描来源', async () => {
    const f = fixture({
      getService: () => ({
        getSnapshot: async () => ({ initialized: true, scan: { status: 'idle' }, workflow: {
          paused: false, approved: { id: 'plan', revision: 1, title: '项目知识', rootRelativePath: '资料/知识', groups: [], createdAt: 1 },
        } }),
        startScan: async () => { f.state.scanCalls += 1 },
        waitForScan: async () => { f.state.waitCalls += 1 },
      }),
    })
    await f.observer.tick()
    expect(f.state.scanCalls).toBe(1)
    f.state.watchChanges[0]?.('资料/知识/业务/规则.md')
    f.state.watchChanges[0]?.('资料/知识/索引.md')
    await f.observer.tick()
    expect(f.state.scanCalls).toBe(1)
    f.state.watchChanges[0]?.('docs/需求.md')
    await f.observer.tick()
    expect(f.state.scanCalls).toBe(2)
    f.observer.dispose()
  })

  test('Given 首次恢复失败 When 下一 tick 重试 Then 不发布半初始化状态并最终建立 watcher', async () => {
    let failRecovery = true
    const f = fixture({
      recoverKnowledge: async () => {
        f.state.recoverCalls += 1
        if (failRecovery) throw new Error('恢复失败')
      },
    })

    await f.observer.tick()
    expect(f.state.watchers).toHaveLength(0)
    expect(f.state.scanCalls).toBe(0)

    failRecovery = false
    await f.observer.tick()
    expect(f.state.recoverCalls).toBe(2)
    expect(f.state.replayCalls).toBe(2)
    expect(f.state.watchers).toHaveLength(2)
    expect(f.state.scanCalls).toBe(1)
  })

  test('Given 扫描启动失败 When 下一 tick 到达 Then 保留 dirty 并立即补偿扫描', async () => {
    let failScan = true
    const f = fixture({
      getService: () => ({
        getSnapshot: async () => ({ initialized: true, scan: { status: 'idle' } }),
        startScan: async () => {
          f.state.scanCalls += 1
          if (failScan) throw new Error('扫描失败')
        },
        waitForScan: async () => { f.state.waitCalls += 1 },
      }),
    })

    await f.observer.tick()
    failScan = false
    await f.observer.tick()

    expect(f.state.scanCalls).toBe(2)
    expect(f.state.waitCalls).toBe(1)
  })

  test('Given 项目绑定变化和 observer dispose When 重建 Then 关闭每一代 watcher', async () => {
    const f = fixture({
      getService: () => ({
        getSnapshot: async () => ({ initialized: true, scan: { status: 'running' } }),
        startScan: async () => { f.state.scanCalls += 1 },
        waitForScan: async () => { f.state.waitCalls += 1 },
      }),
    })
    await f.observer.tick()
    const firstGeneration = [...f.state.watchers]

    f.state.binding = 'binding-2'
    await f.observer.tick()
    const secondGeneration = f.state.watchers.slice(2)

    expect(firstGeneration.map((item) => item.closed)).toEqual([1, 1])
    expect(secondGeneration.map((item) => item.closed)).toEqual([0, 0])
    f.observer.dispose()
    expect(secondGeneration.map((item) => item.closed)).toEqual([1, 1])
  })

  test('Given tick 等待快照时 dispose When 快照迟到 Then 不恢复、不建 watcher且不扫描', async () => {
    let resolveSnapshot!: (snapshot: { initialized: boolean; scan: { status: string } }) => void
    const snapshot = new Promise<{ initialized: boolean; scan: { status: string } }>((resolve) => { resolveSnapshot = resolve })
    const f = fixture({
      getService: () => ({
        getSnapshot: async () => snapshot,
        startScan: async () => { f.state.scanCalls += 1 },
        waitForScan: async () => { f.state.waitCalls += 1 },
      }),
    })

    const pending = f.observer.tick()
    f.observer.dispose()
    resolveSnapshot({ initialized: true, scan: { status: 'idle' } })
    await pending

    expect(f.state.recoverCalls).toBe(0)
    expect(f.state.watchers).toHaveLength(0)
    expect(f.state.scanCalls).toBe(0)
  })

  test('Given 连续文件事件 When 触发观察 Then 只保留一个 500ms 去抖 tick', async () => {
    const f = fixture({
      getService: () => ({
        getSnapshot: async () => ({ initialized: true, scan: { status: 'running' } }),
        startScan: async () => { f.state.scanCalls += 1 },
        waitForScan: async () => { f.state.waitCalls += 1 },
      }),
    })
    await f.observer.tick()

    f.state.watchChanges[0]?.('docs/a.md')
    f.state.watchChanges[0]?.('docs/b.md')

    expect(f.state.timers.map((timer) => timer.delay)).toEqual([500, 500])
    expect(f.state.timers.map((timer) => timer.cleared)).toEqual([true, false])
  })
})
