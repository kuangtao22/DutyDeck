import { describe, expect, test } from 'bun:test'
import { createServerOpsSqlWriteController } from './server-ops-sql-write-controller'
import type { ServerOpsDataSource } from '@proma/shared'
import type { ServerOpsSqlWriteContext, ServerOpsSqlWriteProjection } from './server-ops-sql-write-controller'

/** 公开数据源快照；不含密码或凭据引用。 */
const source: ServerOpsDataSource = {
  id: 'source-1', transport: 'direct', engine: 'mysql', label: '业务主库', address: '127.0.0.1', port: 3306,
  tlsMode: 'disabled', hasPassword: true, createdAt: 1, updatedAt: 2,
}

/** 目标上下文基线；各用例只覆盖要验证的字段。 */
const context: ServerOpsSqlWriteContext = {
  sourceId: 'source-1', source, database: 'chebenben', configurationKey: 'key-1', available: true,
}

/** 构造一次写入结果。 */
function createResult(writeId: string, database: string, affectedRows = 3) {
  return {
    writeId, database, statementCount: 1, affectedRows, committed: true, durationMs: 8,
    statements: [{ head: 'UPDATE', affectedRows }], warnings: [],
  }
}

/**
 * 搭建控制器与可手动结算的写入接口。
 *
 * @param overrides.write 覆盖写入实现
 * @param overrides.cancel 覆盖取消实现
 */
function createHarness(overrides: { write?: (input: unknown) => Promise<unknown>; cancel?: (input: unknown) => Promise<void> } = {}) {
  const published: ServerOpsSqlWriteProjection[] = []
  const inputs: unknown[] = []
  const cancels: unknown[] = []
  let idCounter = 0
  const controller = createServerOpsSqlWriteController({
    api: {
      write: async (input) => {
        inputs.push(input)
        if (overrides.write) return await overrides.write(input) as ReturnType<typeof createResult>
        return createResult(input.writeId, input.database)
      },
      cancel: async (input) => {
        cancels.push(input)
        if (overrides.cancel) await overrides.cancel(input)
      },
    },
    publish: (projection) => { published.push(projection) },
    createWriteId: () => `write-${++idCounter}`,
  })
  return {
    controller, published, inputs, cancels,
    latest: () => published[published.length - 1]!,
  }
}

describe('SQL 写模式控制器', () => {
  test('Given 未绑定上下文 When 执行 Then 不发请求也不改状态', async () => {
    const harness = createHarness()
    harness.controller.activate()
    await harness.controller.execute('UPDATE t SET n = 1')
    expect(harness.inputs).toEqual([])
    expect(harness.latest().status).toBe('idle')
  })

  test('Given 已绑定可写目标 When 执行成功 Then 固定快照并暴露受影响行数', async () => {
    const harness = createHarness()
    harness.controller.activate()
    harness.controller.setContext(context)
    await harness.controller.execute('UPDATE t SET n = 1')
    expect(harness.inputs).toEqual([{ sourceId: 'source-1', source, database: 'chebenben', writeId: 'write-1', sql: 'UPDATE t SET n = 1' }])
    expect(harness.latest()).toMatchObject({ status: 'success', execution: { sql: 'UPDATE t SET n = 1', database: 'chebenben' } })
    expect(harness.latest().execution?.result.affectedRows).toBe(3)
  })

  test('Given 写入仍在运行 When 再次执行 Then 保持单飞且不生成第二个请求', async () => {
    let resolveWrite: ((value: unknown) => void) | undefined
    const harness = createHarness({ write: () => new Promise((resolve) => { resolveWrite = resolve }) })
    harness.controller.activate()
    harness.controller.setContext(context)
    const pending = harness.controller.execute('UPDATE t SET n = 1', context)
    expect(harness.latest().canExecute).toBe(false)
    await harness.controller.execute('DELETE FROM t', context)
    expect(harness.inputs).toHaveLength(1)
    resolveWrite?.(createResult('write-1', 'chebenben'))
    await pending
    expect(harness.latest().canExecute).toBe(true)
  })

  test('Given 确认后目标已经变化 When 执行确认快照 Then 不向新旧目标发请求', async () => {
    const harness = createHarness()
    harness.controller.activate()
    harness.controller.setContext(context)
    const confirmedContext = { ...context }
    harness.controller.setContext({ ...context, database: 'other', configurationKey: 'key-2' })
    await harness.controller.execute('UPDATE t SET n = 1', confirmedContext)
    expect(harness.inputs).toEqual([])
  })

  test('Given 确认后同 ID 数据源被改址 When 执行旧确认 Then 完整快照不匹配且不发请求', async () => {
    const harness = createHarness()
    harness.controller.activate()
    harness.controller.setContext(context)
    const confirmedContext = structuredClone(context)
    harness.controller.setContext({
      ...context,
      source: { ...source, address: '10.0.0.8', updatedAt: 3 },
    })
    await harness.controller.execute('UPDATE t SET n = 1', confirmedContext)
    expect(harness.inputs).toEqual([])
  })

  test('Given 上下文绑定后调用方修改原对象 When 执行 Then 输入仍携带绑定时冻结的数据源快照', async () => {
    const harness = createHarness()
    const mutableSource = { ...source }
    harness.controller.activate()
    harness.controller.setContext({ ...context, source: mutableSource })
    mutableSource.address = '10.0.0.9'
    await harness.controller.execute('UPDATE t SET n = 1')
    expect(harness.inputs[0]).toMatchObject({ source: { address: '127.0.0.1', updatedAt: 2 } })
  })

  test('Given 已绑定数据库 When 数据库变为空 Then 清空上下文并禁止执行', async () => {
    const harness = createHarness()
    harness.controller.activate()
    harness.controller.setContext(context)
    harness.controller.clearContext()
    expect(harness.latest()).toMatchObject({ context: null, status: 'idle', canExecute: false })
    await harness.controller.execute('UPDATE t SET n = 1', context)
    expect(harness.inputs).toEqual([])
  })

  test('Given 数据源不可用 When 执行 Then canExecute 为假且不发请求', async () => {
    const harness = createHarness()
    harness.controller.activate()
    harness.controller.setContext({ ...context, available: false })
    expect(harness.latest().canExecute).toBe(false)
    await harness.controller.execute('UPDATE t SET n = 1')
    expect(harness.inputs).toEqual([])
  })

  test('Given 写入失败 When 执行 Then 收敛成中文说明而不是稳定码', async () => {
    const harness = createHarness({
      write: async () => { throw new Error('SERVER_OPS_DATA_WRITE_PERMISSION_DENIED') },
    })
    harness.controller.activate()
    harness.controller.setContext(context)
    await harness.controller.execute('UPDATE t SET n = 1')
    expect(harness.latest().status).toBe('error')
    expect(harness.latest().error).toContain('写入权限')
    /** 稳定码不能原样出现在界面上。 */
    expect(harness.latest().error).not.toContain('SERVER_OPS_')
  })

  test('Given 结果身份与请求不符 When 执行 Then 判为错误而不是发布脏结果', async () => {
    const harness = createHarness({ write: async () => createResult('write-999', 'chebenben') })
    harness.controller.activate()
    harness.controller.setContext(context)
    await harness.controller.execute('UPDATE t SET n = 1')
    expect(harness.latest().status).toBe('error')
    expect(harness.latest().execution).toBeNull()
  })

  test('Given 切换数据库 When 在途写入返回 Then 旧回执不落库并尽力取消', async () => {
    let resolveWrite: ((value: unknown) => void) | undefined
    const harness = createHarness({
      write: () => new Promise((resolve) => { resolveWrite = resolve }),
    })
    harness.controller.activate()
    harness.controller.setContext(context)
    const pending = harness.controller.execute('UPDATE t SET n = 1')
    harness.controller.setContext({ ...context, database: 'other' })
    /** 切库必须立刻请求取消旧目标上的写入。 */
    expect(harness.cancels).toEqual([{ sourceId: 'source-1', writeId: 'write-1' }])
    resolveWrite?.(createResult('write-1', 'chebenben'))
    await pending
    expect(harness.latest().status).toBe('idle')
    expect(harness.latest().execution).toBeNull()
  })

  test('Given 用户取消 When 服务确认 Then 回到空闲而不是错误', async () => {
    const harness = createHarness({
      write: async () => { throw new Error('SERVER_OPS_DATA_WRITE_CANCELLED') },
    })
    harness.controller.activate()
    harness.controller.setContext(context)
    const pending = harness.controller.execute('UPDATE t SET n = 1')
    await harness.controller.cancel()
    await pending
    expect(harness.cancels).toHaveLength(1)
    expect(harness.latest().status).toBe('idle')
    expect(harness.latest().error).toBeNull()
  })

  test('Given 取消请求发出但数据库已经提交 When 成功回执返回 Then 保留已提交事实', async () => {
    let resolveWrite: ((value: unknown) => void) | undefined
    const harness = createHarness({ write: () => new Promise((resolve) => { resolveWrite = resolve }) })
    harness.controller.activate()
    harness.controller.setContext(context)
    const pending = harness.controller.execute('UPDATE t SET n = 1', context)
    await harness.controller.cancel()
    resolveWrite?.({ ...createResult('write-1', 'chebenben'), outcome: 'committed' })
    await pending
    expect(harness.latest()).toMatchObject({ status: 'success', execution: { result: { outcome: 'committed' } } })
  })

  test('Given 写入只部分生效 When 回执返回 Then 保留结果并进入错误终态', async () => {
    const harness = createHarness({
      write: async () => ({ ...createResult('write-1', 'chebenben'), committed: false, outcome: 'partial', errorCode: 'SERVER_OPS_DATA_WRITE_FAILED' }),
    })
    harness.controller.activate()
    harness.controller.setContext(context)
    await harness.controller.execute('ALTER TABLE t ADD n INT; UPDATE t SET n = 1', context)
    expect(harness.latest().status).toBe('error')
    expect(harness.latest().execution?.result.outcome).toBe('partial')
    expect(harness.latest().error).toContain('写入失败')
  })

  test('Given 卸载 When 在途写入返回 Then 回执作废', async () => {
    let resolveWrite: ((value: unknown) => void) | undefined
    const harness = createHarness({ write: () => new Promise((resolve) => { resolveWrite = resolve }) })
    harness.controller.activate()
    harness.controller.setContext(context)
    const pending = harness.controller.execute('UPDATE t SET n = 1')
    harness.controller.dispose()
    expect(harness.cancels).toHaveLength(1)
    resolveWrite?.(createResult('write-1', 'chebenben'))
    await pending
    expect(harness.latest().execution).toBeNull()
    expect(harness.latest().status).toBe('running')
  })
})
