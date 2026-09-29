import type { ServerOpsDataSource, ServerOpsDataWriteCancelInput, ServerOpsDataWriteInput, ServerOpsDataWriteResult } from '@proma/shared'
import { getServerOpsDataErrorMessage } from './server-ops-data-display'
import { getServerOpsWriteResultError } from './server-ops-write-outcome'

/**
 * SQL 编辑器写模式的状态机。
 *
 * 与只读查询控制器同构（代次守卫、取消保留到服务确认、卸载即失效），但独立成一体：
 * 写链的取消码、错误文案与结果形状都不同，混在一个控制器里会让「查询」与「写入」
 * 两种终态互相覆盖。草稿仍由面板持有，执行时才传入 SQL 快照。
 */

/** 写入的目标上下文；与只读查询共用同一套「切库即失效」判定字段。 */
export interface ServerOpsSqlWriteContext {
  sourceId: string
  /** 用户确认时看到的完整公开数据源快照；主进程用它做目标 CAS。 */
  source: ServerOpsDataSource
  database: string
  configurationKey: string
  available: boolean
}

/** 成功结果固定执行快照，避免后续编辑让旧结果看起来属于新语句。 */
export interface ServerOpsSqlWriteExecution {
  sql: string
  database: string
  result: ServerOpsDataWriteResult
}

/** 写模式页面的私有投影。 */
export interface ServerOpsSqlWriteProjection {
  context: ServerOpsSqlWriteContext | null
  status: 'idle' | 'running' | 'cancelling' | 'success' | 'error'
  activeWriteId: string | null
  execution: ServerOpsSqlWriteExecution | null
  error: string | null
  canExecute: boolean
}

/** 写执行与取消的最小接口；缺失时界面必须显式禁用而不是静默失败。 */
export interface ServerOpsSqlWriteApi {
  write?: (input: ServerOpsDataWriteInput) => Promise<ServerOpsDataWriteResult>
  cancel?: (input: ServerOpsDataWriteCancelInput) => Promise<void>
}

/** 控制器依赖允许测试注入稳定写入 ID。 */
export interface ServerOpsSqlWriteControllerOptions {
  api: ServerOpsSqlWriteApi
  publish: (projection: ServerOpsSqlWriteProjection) => void
  createWriteId?: () => string
  /** 写入结束后通知历史保存；不等待保存，也不改变写入终态。 */
  onExecuted?: (input: ServerOpsDataWriteInput) => void
}

/** 空闲投影；未绑定上下文时不可执行。 */
export function createServerOpsSqlWriteIdleProjection(): ServerOpsSqlWriteProjection {
  return { context: null, status: 'idle', activeWriteId: null, execution: null, error: null, canExecute: false }
}

/** 判断上下文是否仍是发起时那一个；切库或配置变化都必须使在途请求失效。 */
export function isServerOpsSqlWriteContextCurrent(
  actual: ServerOpsSqlWriteContext | null,
  expected: ServerOpsSqlWriteContext,
): boolean {
  if (!actual) return false
  return actual.sourceId === expected.sourceId && actual.database === expected.database
    && actual.configurationKey === expected.configurationKey && actual.available === expected.available
    && isSameServerOpsDataSourceSnapshot(actual.source, expected.source)
}

/** 比较数据源的全部公开字段，避免同 ID 改址后旧确认仍可执行。 */
function isSameServerOpsDataSourceSnapshot(actual: ServerOpsDataSource, expected: ServerOpsDataSource): boolean {
  return actual.id === expected.id && actual.projectId === expected.projectId
    && actual.transport === expected.transport && actual.hostId === expected.hostId
    && actual.engine === expected.engine && actual.label === expected.label
    && actual.address === expected.address && actual.port === expected.port
    && actual.filePath === expected.filePath && actual.localFileId === expected.localFileId
    && actual.database === expected.database && actual.username === expected.username
    && actual.tlsMode === expected.tlsMode && actual.tlsServerName === expected.tlsServerName
    && actual.hasPassword === expected.hasPassword && actual.createdAt === expected.createdAt
    && actual.updatedAt === expected.updatedAt
}

/** 取消错误必须只认写链自己的码，避免把失败当取消吞掉。 */
function isWriteCancelled(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return text.includes('SERVER_OPS_DATA_WRITE_CANCELLED')
}

/**
 * 创建写模式控制器。
 *
 * @param options 写入接口、投影发布与可选的写入 ID / 执行回调
 * @returns 控制器；`execute` 只接受显式传入的 SQL 快照
 */
export function createServerOpsSqlWriteController(options: ServerOpsSqlWriteControllerOptions) {
  /** 私有状态；所有变更都必须经过 publish。 */
  const state: ServerOpsSqlWriteProjection = createServerOpsSqlWriteIdleProjection()
  /** 当前挂载期代次；卸载或在途请求被替换后自增。 */
  let generation = 0
  /** 取消确认的代次，用于识别迟到的取消回执。 */
  let cancellationGeneration = 0
  /** 当前在途请求的完整身份。 */
  let activeRequest: { writeId: string; sourceId: string; configurationKey: string; generation: number; abandoned: boolean } | null = null
  /** 组件是否仍挂载；卸载后一切回执作废。 */
  let active = false
  const createWriteId = options.createWriteId ?? (() => globalThis.crypto.randomUUID())

  /** 发布投影副本，避免调用方直接改内部状态。 */
  const publish = (): void => { options.publish({ ...state, context: state.context === null ? null : { ...state.context, source: structuredClone(state.context.source) } }) }

  /** 当前是否具备发起写入的全部条件。 */
  const canExecute = (): boolean => active && activeRequest === null && state.context?.available === true && options.api.write !== undefined

  /**
   * 读取当前终态。
   *
   * 必须经由函数读取：同一函数体里对 `state.status` 的赋值会让 TypeScript 把属性收窄，
   * 于是 `'cancelling'`（由取消流程写入）在编译器看来不可能出现，取消与失败的区分就失效了。
   */
  const currentStatus = (): ServerOpsSqlWriteProjection['status'] => state.status

  /** 等待主进程确认取消；确认前保持 cancelling，避免用户以为已停。 */
  const cancelActiveWrite = async (): Promise<void> => {
    const request = activeRequest
    const cancel = options.api.cancel
    if (!request || !cancel) return
    const revision = cancellationGeneration
    state.status = 'cancelling'
    publish()
    try {
      await cancel({ sourceId: request.sourceId, writeId: request.writeId })
      if (cancellationGeneration !== revision) return
    } catch (error) {
      if (cancellationGeneration !== revision) return
      /** 取消失败不改写为写入失败：真实事务状态未知，由用户决定是否重试。 */
      state.status = 'running'
      state.error = getServerOpsDataErrorMessage(error)
      publish()
    }
  }

  return {
    /** 挂载：允许发起请求。 */
    activate(): void { active = true; state.canExecute = canExecute(); publish() },
    /** 设置目标上下文；切换目标必须让在途请求与旧结果失效。 */
    setContext(context: ServerOpsSqlWriteContext): void {
      if (isServerOpsSqlWriteContextCurrent(state.context, context)) return
      const request = activeRequest
      generation += 1
      cancellationGeneration += 1
      activeRequest = null
      state.context = { ...context, source: structuredClone(context.source) }
      state.status = 'idle'
      state.activeWriteId = null
      state.execution = null
      state.error = null
      state.canExecute = canExecute()
      publish()
      /** 旧目标上的在途写入尽力取消，避免它继续写一个用户已经离开的库。 */
      if (request) void options.api.cancel?.({ sourceId: request.sourceId, writeId: request.writeId }).catch(() => undefined)
    },
    /** 清空数据库目标；无选库状态不能保留上一个库的写上下文。 */
    clearContext(): void {
      const request = activeRequest
      generation += 1
      cancellationGeneration += 1
      activeRequest = null
      state.context = null
      state.status = 'idle'
      state.activeWriteId = null
      state.execution = null
      state.error = null
      state.canExecute = false
      publish()
      if (request) void options.api.cancel?.({ sourceId: request.sourceId, writeId: request.writeId }).catch(() => undefined)
    },
    /**
     * 执行一次写入。
     *
     * @param sql 点击确认瞬间的 SQL 快照
     */
    async execute(sql: string, confirmedContext?: ServerOpsSqlWriteContext): Promise<void> {
      const context = state.context
      const write = options.api.write
      if (!canExecute() || !context || !write
        || (confirmedContext !== undefined && !isServerOpsSqlWriteContextCurrent(context, confirmedContext))) return
      const writeId = createWriteId()
      const revision = ++generation
      const input: ServerOpsDataWriteInput = {
        sourceId: context.sourceId,
        source: structuredClone(context.source),
        database: context.database,
        writeId,
        sql,
      }
      activeRequest = { writeId, sourceId: context.sourceId, configurationKey: context.configurationKey, generation: revision, abandoned: false }
      state.status = 'running'
      state.activeWriteId = writeId
      state.error = null
      state.canExecute = false
      publish()
      try {
        const result = await write(input)
        const request = activeRequest
        if (!active || generation !== revision || !request || request.writeId !== writeId) return
        if (result.writeId !== writeId || result.database !== context.database) {
          activeRequest = null; cancellationGeneration += 1; state.activeWriteId = null
          state.status = 'error'; state.error = '写入结果与当前请求不匹配'; state.canExecute = canExecute(); publish(); return
        }
        activeRequest = null; cancellationGeneration += 1; state.activeWriteId = null
        if (request.abandoned) { state.status = 'idle'; state.error = null; publish(); return }
        state.execution = { sql, database: context.database, result: structuredClone(result) }
        state.error = getServerOpsWriteResultError(result)
        state.status = state.error === null ? 'success' : 'error'
        state.canExecute = canExecute()
        publish()
      } catch (error) {
        const request = activeRequest
        if (!active || generation !== revision || !request || request.writeId !== writeId) return
        const explicitlyCancelling = currentStatus() === 'cancelling'
        activeRequest = null; cancellationGeneration += 1; state.activeWriteId = null
        if (request.abandoned) { state.status = 'idle'; state.error = null; publish(); return }
        if (explicitlyCancelling && isWriteCancelled(error)) { state.status = 'idle'; state.error = null; state.canExecute = canExecute(); publish(); return }
        state.status = 'error'
        state.error = getServerOpsDataErrorMessage(error)
        state.canExecute = canExecute()
        publish()
      } finally {
        try { options.onExecuted?.(input) } catch { /* 历史故障由独立状态呈现，不覆盖写入结果。 */ }
      }
    },
    /** 用户取消：确认前保持 busy。 */
    async cancel(): Promise<void> {
      if (!active || state.status !== 'running' || !activeRequest) return
      await cancelActiveWrite()
    },
    /** 卸载立即让回执失效，并尽力取消真实写入。 */
    dispose(): void {
      const request = activeRequest
      generation += 1; cancellationGeneration += 1; activeRequest = null; active = false
      if (request) void options.api.cancel?.({ sourceId: request.sourceId, writeId: request.writeId }).catch(() => undefined)
    },
  }
}
