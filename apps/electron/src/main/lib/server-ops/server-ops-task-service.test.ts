import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, ServerOpsAuditAppendInput, ServerOpsTaskIdentity } from '@proma/shared'
import { ServerOpsTaskService } from './server-ops-task-service'
import type { ServerOpsTaskServiceDependencies } from './server-ops-task-service'

/** 构造无真实 SSH、无磁盘副作用的生命周期夹具。 */
function fixture() {
  const audit: ServerOpsAuditAppendInput[] = []
  const acks: number[] = []
  const stopped: string[] = []
  const writes: string[] = []
  let output: Parameters<ServerOpsTaskServiceDependencies['connection']['onTaskOutput']>[0] = () => {}
  let exit: Parameters<ServerOpsTaskServiceDependencies['connection']['onTaskExit']>[0] = () => {}
  let state: Parameters<ServerOpsTaskServiceDependencies['connection']['onState']>[0] = () => {}
  let generation = 1
  let count = 0
  let session: AgentSessionMeta = { id: 'session', title: '任务', createdAt: 1, updatedAt: 1 }
  const connection: ServerOpsTaskServiceDependencies['connection'] = {
    getActiveIdentity: (hostId) => ({ hostId, connectionId: 'connection', generation }),
    startTask: async (identity, taskId) => ({ taskId, hostId: identity.hostId, connectionId: identity.connectionId }),
    stopTask: async (identity) => { stopped.push(identity.taskId) },
    writeTask: (input) => { writes.push(input.data) }, resizeTask: () => {},
    acknowledgeTask: (input) => { acks.push(input.sequence) },
    onTaskOutput: (listener) => { output = listener; return () => {} },
    onTaskExit: (listener) => { exit = listener; return () => {} },
    onState: (listener) => { state = listener; return () => {} },
  }
  const dependencies: ServerOpsTaskServiceDependencies = { connection,
    audit: { append: (input) => { audit.push(input); return { ...input, id: 'audit', timestamp: Date.now() } } },
    getSession: () => session, uuid: () => `task-${++count}` }
  const service = new ServerOpsTaskService(dependencies)
  const start = (signal?: AbortSignal) => service.start('session', { hostId: 'host', connectionId: 'connection', command: 'sudo deploy' }, () => {}, signal)
  const identity = (taskId: string): ServerOpsTaskIdentity => ({ taskId, hostId: 'host', connectionId: 'connection' })
  return { service, dependencies, connection, audit, acks, stopped, writes, start,
    target: (taskId: string) => ({ sessionId: 'session', taskId }),
    output: (taskId: string, data: string, sequence = 1) => output({ ...identity(taskId), generation, data, sequence }),
    exit: (taskId: string, exitCode?: number, signal?: string) => exit({ ...identity(taskId), generation, message: 'closed', ...(exitCode === undefined ? {} : { exitCode }), ...(signal === undefined ? {} : { signal }) }),
    disconnect: () => { generation++; state({ hostId: 'host', phase: 'disconnected' }) },
    archive: () => { session = { ...session, archived: true } },
  }
}

describe('远程交互任务', () => {
  test('Given 运行任务 When 输出和真实退出 Then 主进程 ACK 且审计仅终态写结果', async () => {
    const f = fixture(); const task = await f.start()
    expect(f.audit.map((item) => item.phase)).toEqual(['start'])
    f.output(task.taskId, 'password: '); f.output(task.taskId, 'password: ')
    f.service.write({ ...f.target(task.taskId), data: 'secret\n' })
    expect((await f.service.read(f.target(task.taskId))).output).toBe('password: ')
    expect(f.acks).toEqual([1, 1]); expect(JSON.stringify(f.audit)).not.toContain('secret')
    f.exit(task.taskId, 7)
    expect(f.audit[1]).toMatchObject({ phase: 'result', outcome: 'error', exitCode: 7 })
  })
  test('Given 大量输出 When 分页 Then 缓冲与原始偏移有界', async () => {
    const f = fixture(); const task = await f.start(); f.output(task.taskId, 'x'.repeat(150_000))
    const result = await f.service.read(f.target(task.taskId))
    expect(result.output.length).toBe(12_000); expect(result.availableStartOffset).toBe(150_000 - 131_072)
    expect(result.truncatedBefore).toBe(true); expect(result.truncatedAfter).toBe(true)
  })
  test('Given 长等待 When 输出或读取消 Then 事件唤醒且读取消不停止任务', async () => {
    const f = fixture(); const task = await f.start(); const controller = new AbortController()
    const pending = f.service.read({ ...f.target(task.taskId), waitMs: 30_000 }, controller.signal)
    controller.abort(); await expect(pending).rejects.toThrow(); expect(f.stopped).toEqual([])
    const read = f.service.read({ ...f.target(task.taskId), waitMs: 30_000 }); f.output(task.taskId, 'ready')
    expect((await read).output).toBe('ready')
  })
  test('Given 启动中快速退出 When 启动 Promise 返回 Then 不复活已退出任务', async () => {
    const f = fixture(); f.connection.startTask = async (identity, taskId) => {
      f.exit(taskId, 0); return { ...identity, taskId }
    }
    expect((await f.start()).state).toBe('exited'); expect(f.audit[1]?.outcome).toBe('success')
  })
  test('Given 启动未返回 When 中断 Then 晚到启动仍被关闭且不复活', async () => {
    const f = fixture(); let finish!: (identity: ServerOpsTaskIdentity) => void
    f.connection.startTask = () => new Promise((resolve) => { finish = resolve })
    const pending = f.start(); await f.service.interrupt(f.target('task-1'))
    finish({ taskId: 'task-1', hostId: 'host', connectionId: 'connection' })
    expect((await pending).state).toBe('interrupted'); expect(f.stopped.length).toBeGreaterThanOrEqual(2)
    expect(f.audit.filter((item) => item.phase === 'result')).toHaveLength(1)
  })
  test('Given 断连或缺失退出码 When 读取终态 Then 未知且保留输出', async () => {
    const f = fixture(); const task = await f.start(); f.output(task.taskId, 'retained'); f.disconnect()
    expect((await f.service.read(f.target(task.taskId))).task.state).toBe('unknown')
    expect((await f.service.read(f.target(task.taskId))).output).toBe('retained')
    expect(() => f.service.write({ ...f.target(task.taskId), data: 'x' })).toThrow()
    expect(f.audit[1]?.outcome).toBe('unknown')
    const g = fixture(); const next = await g.start(); g.exit(next.taskId)
    expect(g.service.list('session')[0]?.state).toBe('unknown')
  })
  test('Given 审计失败 When 开始或退出 Then 阻断开始或报告结果警告', async () => {
    const f = fixture(); f.dependencies.audit.append = () => { throw new Error('disk') }
    await expect(f.start()).rejects.toThrow('SERVER_OPS_AUDIT_START_WRITE_FAILED')
    expect(f.service.list('session')).toEqual([])
    const g = fixture(); const task = await g.start(); g.dependencies.audit.append = () => { throw new Error('disk') }; g.exit(task.taskId, 0)
    expect(g.service.list('session')[0]?.warnings).toContain('SERVER_OPS_AUDIT_RESULT_WRITE_FAILED')
  })
  test('Given 非法会话或跨会话读取 When 调用 Then 拒绝而不泄露输出', async () => {
    const f = fixture(); const task = await f.start()
    await expect(f.service.read({ sessionId: 'other', taskId: task.taskId })).rejects.toThrow()
    f.archive(); await expect(f.start()).rejects.toThrow()
    await expect(f.service.read(f.target(task.taskId))).rejects.toThrow()
  })
  test('Given 运行取消 When signal abort Then 中断独立任务', async () => {
    const f = fixture(); const controller = new AbortController(); const task = await f.start(controller.signal)
    controller.abort(); await Promise.resolve()
    expect(f.service.list('session')[0]?.state).toBe('interrupted'); expect(f.stopped).toContain(task.taskId)
  })
})

test('Given 只有退出信号没有退出码 When 任务结束 Then 公开未知且不伪造终态退出码字段', async () => {
  const f = fixture(); const task = await f.start(); f.exit(task.taskId, undefined, 'SIGTERM')
  expect(f.service.list('session')[0]).toMatchObject({ state: 'unknown' })
  expect(f.service.list('session')[0]?.signal).toBeUndefined()
  expect(f.audit[1]).toMatchObject({ outcome: 'unknown', signal: 'SIGTERM' })
})

test('Given 超过公开合同上限的命令 When 开始 Then 拒绝并不记录审计', async () => {
  const f = fixture()
  await expect(f.service.start('session', { hostId: 'host', connectionId: 'connection', command: 'x'.repeat(8193) }, () => {})).rejects.toThrow()
  expect(f.audit).toHaveLength(0)
})

describe('远程任务资源与权限边界', () => {
  test('Given 四个活动任务 When 同会话再启动 Then 拒绝且已完成记录可被淘汰', async () => {
    const f = fixture()
    for (let i = 0; i < 4; i++) await f.start()
    await expect(f.start()).rejects.toThrow('SERVER_OPS_TASK_LIMIT')
    for (const task of f.service.list('session')) f.exit(task.taskId, 0)
    for (let i = 0; i < 34; i++) { const task = await f.start(); f.exit(task.taskId, 0) }
    expect(f.service.list('session')).toHaveLength(32)
    await expect(f.service.read(f.target('task-1'))).rejects.toThrow('SERVER_OPS_TASK_NOT_FOUND')
  })
  test('Given 恶意参数 When 读取输入调整尺寸 Then 拒绝越界和多余字段', async () => {
    const f = fixture(); const task = await f.start(); const target = f.target(task.taskId)
    for (const input of [{ ...target, offset: -1 }, { ...target, offset: 1 }, { ...target, waitMs: 30_001 }, { ...target, waitMs: NaN }]) {
      await expect(f.service.read(input)).rejects.toThrow()
    }
    expect(() => f.service.write({ ...target, data: 'x'.repeat(65_537) })).toThrow()
    expect(() => f.service.resize({ ...target, cols: 0, rows: 30 })).toThrow()
  })
  test('Given 启动期间撤销权限 When 派发返回 Then 清理通道并拒绝迟到结果', async () => {
    const f = fixture(); let allowed = true
    f.connection.startTask = async (identity, taskId) => { allowed = false; return { ...identity, taskId } }
    await expect(f.service.start('session', { hostId: 'host', connectionId: 'connection', command: 'deploy' },
      () => { if (!allowed) throw new Error('revoked') })).rejects.toThrow('revoked')
    expect(f.stopped).toEqual(['task-1']); expect(f.audit[1]?.outcome).toBe('unknown')
  })
  test('Given 任务运行中 When 会话释放 Then 读者被唤醒并拒绝且任务关闭', async () => {
    const f = fixture(); const task = await f.start()
    const pending = f.service.read({ ...f.target(task.taskId), waitMs: 30_000 })
    f.service.disposeSession('session')
    await expect(pending).rejects.toThrow(); expect(f.stopped).toEqual([task.taskId])
  })
})

describe('审计准备与身份竞态', () => {
  test('Given 审计准备等待 When 权限撤销 Then 不派发任务', async () => {
    const f = fixture(); let allowed = true; let dispatched = false
    f.dependencies.audit.prepareForWrites = async () => { allowed = false }
    f.connection.startTask = async (identity, taskId) => { dispatched = true; return { ...identity, taskId } }
    await expect(f.service.start('session', { hostId: 'host', connectionId: 'connection', command: 'deploy' },
      () => { if (!allowed) throw new Error('revoked') })).rejects.toThrow('revoked')
    expect(dispatched).toBe(false); expect(f.audit).toHaveLength(0)
  })
  test('Given 重复任务标识 When 启动 Then 拒绝覆盖原记录', async () => {
    const f = fixture(); f.dependencies.uuid = () => 'same'
    await f.start(); await expect(f.start()).rejects.toThrow('SERVER_OPS_TASK_ALREADY_EXISTS')
    expect(f.service.list('session')).toHaveLength(1)
  })
})

test('Given 启动请求悬挂且已中断 When 连续新建 Then 仍计入活动容量避免泄漏', async () => {
  const f = fixture(); const resolvers: Array<() => void> = []; const pending: Array<Promise<unknown>> = []
  f.connection.startTask = (identity, taskId) => new Promise((resolve) => { resolvers.push(() => resolve({ ...identity, taskId })) })
  for (let i = 1; i <= 4; i++) {
    pending.push(f.start()); await f.service.interrupt(f.target(`task-${i}`))
  }
  await expect(f.start()).rejects.toThrow('SERVER_OPS_TASK_LIMIT')
  resolvers.forEach((resolve) => resolve()); await Promise.all(pending)
})

test('Given 启动状态通知同步中止 When start继续 Then 不发送远端命令', async () => {
  const f = fixture(); let dispatched = false
  f.connection.startTask = async (identity, taskId) => { dispatched = true; return { ...identity, taskId } }
  f.service.onChanged((task) => { if (task.state === 'starting') void f.service.interrupt(f.target(task.taskId)) })
  await f.start()
  expect(dispatched).toBe(false)
})

test('Given 32个等待读请求 When 更多读请求进入 Then 拒绝额外等待并可清理全部读者', async () => {
  const f = fixture(); const task = await f.start(); const reads: Array<Promise<unknown>> = []
  for (let i = 0; i < 32; i++) reads.push(f.service.read({ ...f.target(task.taskId), waitMs: 1 }))
  await expect(f.service.read({ ...f.target(task.taskId), waitMs: 1 })).rejects.toThrow('SERVER_OPS_TASK_READ_LIMIT')
  f.output(task.taskId, 'done'); await Promise.all(reads)
})

describe('远程任务具体认证身份绑定', () => {
  test('Given SSH代次未变但凭据版本已变化 When 用户输入 Then 关闭原任务并保留未知历史', async () => {
    const f = fixture()
    /** 认证绑定包含用户名、认证方式和凭据版本的主进程快照。 */
    let binding = 'user-a:credential-v1'
    Object.assign(f.dependencies, { getHostBinding: () => binding })
    const task = await f.start(); f.output(task.taskId, 'before')
    binding = 'user-a:credential-v2'
    expect(() => f.service.write({ ...f.target(task.taskId), data: 'secret' })).toThrow('SERVER_OPS_TASK_NOT_ACTIVE')
    expect(f.writes).toEqual([]); expect(f.stopped).toEqual([task.taskId])
    const history = await f.service.read(f.target(task.taskId))
    expect(history.task.state).toBe('unknown'); expect(history.output).toBe('before')
    expect(f.audit.filter((entry) => entry.phase === 'result')).toHaveLength(1)
  })
  test('Given 身份绑定变化 When 主动读取或调整尺寸 Then 立即使任务失效而无需等待新连接事件', async () => {
    for (const action of ['read', 'resize'] as const) {
      const f = fixture(); let binding = 'user-a'
      Object.assign(f.dependencies, { getHostBinding: () => binding })
      const task = await f.start(); binding = 'user-b'
      if (action === 'read') expect((await f.service.read(f.target(task.taskId))).task.state).toBe('unknown')
      else expect(() => f.service.resize({ ...f.target(task.taskId), cols: 80, rows: 24 })).toThrow()
      expect(f.stopped).toEqual([task.taskId]); expect(f.service.list('session')[0]?.state).toBe('unknown')
    }
  })
  test('Given 身份绑定变化 When 旧通道输出或成功退出 Then 不追加新输出且不能报告成功', async () => {
    for (const action of ['output', 'exit'] as const) {
      const f = fixture(); let binding = 'original'
      Object.assign(f.dependencies, { getHostBinding: () => binding })
      const task = await f.start(); f.output(task.taskId, 'retained'); binding = 'changed'
      if (action === 'output') f.output(task.taskId, 'reject', 2)
      else f.exit(task.taskId, 0)
      const result = await f.service.read(f.target(task.taskId))
      expect(result.task.state).toBe('unknown'); expect(result.output).toBe('retained')
      expect(f.stopped).toEqual([task.taskId]); expect(f.audit[1]?.outcome).toBe('unknown')
    }
  })
  test('Given 已完成任务 When 认证绑定变化 Then 保留真实退出历史且不再次关闭', async () => {
    const f = fixture(); let binding = 'original'
    Object.assign(f.dependencies, { getHostBinding: () => binding })
    const task = await f.start(); f.output(task.taskId, 'done'); f.exit(task.taskId, 0); binding = 'changed'
    const result = await f.service.read(f.target(task.taskId))
    expect(result.task.state).toBe('exited'); expect(result.task.exitCode).toBe(0); expect(result.output).toBe('done'); expect(f.stopped).toEqual([])
  })
})

describe('远程任务会话归档收口', () => {
  test('Given 会话在读等待期间归档 When 下一段输出到达 Then 唤醒并拒绝读者且关闭所有所属任务', async () => {
    const f = fixture(); const first = await f.start(); const second = await f.start()
    const pending = f.service.read({ ...f.target(first.taskId), waitMs: 30000 })
    f.archive(); f.output(first.taskId, 'private')
    await expect(pending).rejects.toThrow('SERVER_OPS_TASK_SESSION_UNAVAILABLE')
    expect(f.stopped.sort()).toEqual([first.taskId, second.taskId].sort())
    expect(f.acks).toEqual([])
  })
  test('Given 会话已归档 When 读取或退出到达 Then 关闭任务而非仅拒绝调用后留在远端运行', async () => {
    for (const action of ['read', 'exit'] as const) {
      const f = fixture(); const task = await f.start(); f.archive()
      if (action === 'read') await expect(f.service.read(f.target(task.taskId))).rejects.toThrow()
      else f.exit(task.taskId, 0)
      expect(f.stopped).toEqual([task.taskId]); expect(f.audit[1]?.outcome).toBe('unknown')
    }
  })
})

test('Given 绑定读取失败或启动期间变化 When 继续操作 Then 失效关闭并拒绝派发确认', async () => {
  const unavailable = fixture()
  Object.assign(unavailable.dependencies, { getHostBinding: () => { throw new Error('missing host') } })
  await expect(unavailable.start()).rejects.toThrow('missing host')
  expect(unavailable.audit).toEqual([])

  const changed = fixture()
  /** 启动 Promise 完成之前变更认证指纹，模拟保存凭据竞争。 */
  let binding = 'old'
  Object.assign(changed.dependencies, { getHostBinding: () => binding })
  changed.connection.startTask = async (identity, taskId) => { binding = 'new'; return { ...identity, taskId } }
  await expect(changed.start()).rejects.toThrow('SERVER_OPS_TASK_CONNECTION_CHANGED')
  expect(changed.stopped).toEqual(['task-1'])
  expect(changed.service.list('session')[0]?.state).toBe('unknown')
})
