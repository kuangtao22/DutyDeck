import * as React from 'react'
import { atom, useAtom, useStore } from 'jotai'
import { CircleHelp, Code2, History, ListChecks, LoaderCircle, Play, RotateCw, Square, Table2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { ServerOpsDataPanelApi } from './ServerOpsDataServicesPanel'
import { formatServerOpsSchemaCell } from './ServerOpsSchemaBrowserView'
import { createServerOpsSqlQueryController, createServerOpsSqlQueryIdleProjection, isServerOpsSqlQueryContextCurrent } from './server-ops-sql-query-controller'
import { getServerOpsSqlQueryWarningMessage } from './server-ops-sql-query-controller'
import type { ServerOpsSqlQueryExecution } from './server-ops-sql-query-controller'
import { SERVER_OPS_STATUSBAR_CLASS, SERVER_OPS_TAB_CLASS, SERVER_OPS_TABLE_CLASS } from './server-ops-ui'
import { createServerOpsSqlQueryHistoryController, createServerOpsSqlQueryHistoryIdleProjection } from './server-ops-sql-query-history-controller'
import { ServerOpsSqlQueryHistory } from './ServerOpsSqlQueryHistory'
import type { ServerOpsDataQueryHistoryRecordInput, ServerOpsDataSchemaCell, ServerOpsDataSource } from '@proma/shared'
import { SERVER_OPS_DATA_QUERY_TIMEOUT_MS, validateServerOpsSqlQuery } from '@proma/shared'
import { createServerOpsSqlWriteController, createServerOpsSqlWriteIdleProjection, isServerOpsSqlWriteContextCurrent } from './server-ops-sql-write-controller'
import type { ServerOpsSqlWriteContext, ServerOpsSqlWriteProjection } from './server-ops-sql-write-controller'
import { getServerOpsWriteOutcomePresentation } from './server-ops-write-outcome'
import { ServerOpsSqlEditor } from './ServerOpsSqlEditor'
import type { ServerOpsSqlEditorHandle } from './ServerOpsSqlEditor'
import { createServerOpsSqlCompletionSource } from './server-ops-sql-completion'
import type { ServerOpsSqlDialect } from './server-ops-sql-completion'
import { createServerOpsSqlCompletionController, createServerOpsSqlCompletionIdleProjection, getServerOpsSqlCompletionContextKey } from './server-ops-sql-completion-controller'
import type { ServerOpsSqlCompletionApi } from './server-ops-sql-completion-controller'
import { validateServerOpsSqlDraft, validateServerOpsSqlWriteDraft } from './server-ops-sql-validation'
import type { ServerOpsSqlDraftValidation, ServerOpsSqlEditorDiagnostic } from './server-ops-sql-validation'

/** 空诊断保持引用稳定，等待防抖时不反复更新 CodeMirror 扩展。 */
const EMPTY_DIAGNOSTICS: ServerOpsSqlEditorDiagnostic[] = []
/** 校验结果绑定原始草稿及连接上下文，迟到结果不能标记新文本。 */
interface SqlValidationSnapshot {
  sql: string
  contextKey: string
  /** 方言变化时立即隐藏旧校验结果。 */
  dialect: ServerOpsSqlDialect
  /** 自动识别后的操作类型，防止查询和写入复用错误的诊断。 */
  operation: 'query' | 'write'
  result: ServerOpsSqlDraftValidation
}

/** 确认仅绑定本次目标和完整 SQL，不代表对后续写入永久授权。 */
interface SqlWriteConfirmation {
  context: ServerOpsSqlWriteContext
  sql: string
  heads: string[]
}

/** SQL 查询历史的最小控制器接口；写入历史仍由主进程回执刷新。 */
interface ServerOpsSqlHistoryExecutionController {
  record: (input: ServerOpsDataQueryHistoryRecordInput) => Promise<void>
  refresh: () => Promise<void>
}

/**
 * 把查询历史保存与写入历史刷新分流到各自的权威入口。
 *
 * @param historyController 当前数据库的历史控制器
 * @returns 查询完成时保存 SQL；写入完成时只刷新主进程已经记录的逐次运行结果
 */
export function createServerOpsSqlHistoryExecutionHandlers(historyController: ServerOpsSqlHistoryExecutionController): {
  onQueryExecuted: (input: ServerOpsDataQueryHistoryRecordInput) => void
  onWriteExecuted: () => void
} {
  return {
    onQueryExecuted: (input) => { void historyController.record(input) },
    onWriteExecuted: () => { void historyController.refresh() },
  }
}

/**
 * 返回写入确认卡的数据库事务说明。
 *
 * @param dialect 当前数据库方言
 * @returns 不超出运行时可证明范围的风险说明
 */
export function getServerOpsSqlWriteConfirmationDescription(dialect: ServerOpsSqlDialect): string {
  return dialect === 'mysql'
    ? '若脚本包含建表、改表等语句，MySQL 会隐式提交，这些改动无法回滚；'
    : dialect === 'postgresql'
    ? 'PostgreSQL 会把整段脚本放在事务中执行；事务失败会尝试回滚，最终结果以执行回执为准；'
    : 'SQLite 会把整段脚本放在事务中执行；事务失败会尝试回滚，最终结果以执行回执为准；'
}

/** 生成确认卡中的完整目标身份，不包含密码或凭据引用。 */
export function formatServerOpsSqlWriteTarget(source: ServerOpsDataSource, database: string): string {
  const endpoint = source.engine === 'sqlite'
    ? source.filePath ?? '文件路径未知'
    : `${source.address ?? '地址未知'}:${source.port ?? '端口未知'}`
  return `${source.label} · ${endpoint} · 数据库 ${database}`
}

/**
 * 查询、取消与本地历史使用独立接口，兼容尚未升级的 preload。
 */
export type ServerOpsSqlQueryPanelApi = Pick<ServerOpsDataPanelApi, 'queryServerOpsDatabase' | 'cancelServerOpsDatabaseQuery' | 'writeServerOpsDatabase' | 'cancelServerOpsDatabaseWrite' | 'listServerOpsDatabaseQueryHistory' | 'saveServerOpsDatabaseQueryHistory'> & ServerOpsSqlCompletionApi

/** SQL 查询页面输入；database 由工作台顶部选库器统一控制。 */
export interface ServerOpsSqlQueryPanelProps {
  api: ServerOpsSqlQueryPanelApi
  sourceId: string
  /** 手工写入必须携带真实公开来源快照；旧调用方缺少来源时保留只读。 */
  source?: ServerOpsDataSource
  database: string | null
  configurationKey: string
  available: boolean
  /** 查询解析、编辑与补全使用的数据源方言。 */
  dialect?: ServerOpsSqlDialect
}

/** 查询结果纯视图，固定显示执行快照并让空结果保留真实列头。 */
export function ServerOpsSqlQueryResult({ execution, busy }: { execution: ServerOpsSqlQueryExecution; busy: boolean }): React.ReactElement {
  return <section className="flex min-h-64 min-w-0 flex-1 flex-col overflow-hidden" aria-label="查询结果" data-server-ops-sql-result>
    <div className="shrink-0 border-b border-border/40 px-4 py-2 text-[11px] leading-5 text-muted-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="mr-auto min-w-0 truncate" title={execution.database}>数据库：<strong className="font-medium text-foreground">{execution.database}</strong></span>
        <span className="tabular-nums">{execution.result.rowCount} 行 · {execution.result.durationMs} ms</span>
        {execution.result.truncated ? <span className="text-amber-700 dark:text-amber-400">结果已截断</span> : null}
      </div>
      {busy ? <p className="mt-1 flex items-center gap-1.5" role="status"><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />正在执行新查询，以下为上次成功结果</p> : null}
      <div className="mt-1 min-w-0 truncate font-mono text-[10px]" title={execution.sql}>执行 SQL：{execution.sql}</div>
    </div>
    {execution.result.warnings.length ? <ul className="max-h-24 shrink-0 space-y-1 overflow-y-auto bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground" data-server-ops-sql-warnings>{execution.result.warnings.map((warning: string, index: number) => <li key={`${index}:${warning}`} className="break-words">{getServerOpsSqlQueryWarningMessage(warning)}</li>)}</ul> : null}
    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
      <table className={cn(SERVER_OPS_TABLE_CLASS, 'whitespace-nowrap [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-content-area')}>
        <thead><tr>{execution.result.columns.map((column: string, index: number) => <th key={`${index}:${column}`} scope="col">{column}</th>)}</tr></thead>
        <tbody>{execution.result.rows.map((row: ServerOpsDataSchemaCell[], rowIndex: number) => <tr key={rowIndex}>{execution.result.columns.map((_: string, cellIndex: number) => {
          const cell = row[cellIndex] ?? null
          return <td key={cellIndex} className={cn('max-w-[20rem] truncate font-mono', typeof cell === 'string' && /^-?\d+(\.\d+)?$/u.test(cell) && 'text-right tabular-nums', (cell === null || cell === '' || typeof cell === 'object') && 'text-muted-foreground italic')} title={formatServerOpsSchemaCell(cell)}>{formatServerOpsSchemaCell(cell)}</td>
        })}</tr>)}</tbody>
      </table>
      {execution.result.rows.length === 0 ? <div className="p-8 text-center text-xs text-muted-foreground">查询成功，结果为空</div> : null}
    </div>
    <div className={SERVER_OPS_STATUSBAR_CLASS}><span>{execution.result.rowCount} 行</span><span>{execution.result.columns.length} 列</span>{execution.result.truncated ? <span>已按行数或结果大小上限截断</span> : null}</div>
  </section>
}

/**
 * 写执行结果纯视图。
 *
 * 写链不返回结果集，因此这里只呈现「有没有生效」：语句条数、累计受影响行数、
 * 是否已提交，以及逐条影响行数。**是否提交必须显式展示**——MySQL 的 DDL 会隐式提交，
 * 用户需要知道这次改动能不能通过重跑或回滚撤掉。
 */
export function ServerOpsSqlWriteResult({ projection }: { projection: ServerOpsSqlWriteProjection }): React.ReactElement | null {
  const execution = projection.execution
  if (!execution) return null
  const result = execution.result
  const outcome = getServerOpsWriteOutcomePresentation(result)
  const outcomeClassName = outcome.tone === 'success'
    ? 'text-emerald-700 dark:text-emerald-400'
    : outcome.tone === 'danger' ? 'text-destructive' : outcome.tone === 'warning' ? 'text-amber-700 dark:text-amber-400' : 'text-foreground'
  return <section className="flex min-h-40 min-w-0 flex-1 flex-col overflow-hidden" aria-label="写入结果" data-server-ops-sql-write-result>
    <div className="shrink-0 border-b border-border/40 px-4 py-2 text-[11px] leading-5 text-muted-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="mr-auto min-w-0 truncate" title={execution.database}>数据库：<strong className="font-medium text-foreground">{execution.database}</strong></span>
        <span className="tabular-nums">{result.statementCount} 条语句 · 影响 {result.affectedRows} 行 · {result.durationMs} ms</span>
        <span className={outcomeClassName}>{outcome.label}</span>
      </div>
      {projection.status === 'running' || projection.status === 'cancelling' ? <p className="mt-1 flex items-center gap-1.5" role="status"><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />{projection.status === 'cancelling' ? '正在取消新写入，以下为上次执行回执' : '正在执行新写入，以下为上次执行回执'}</p> : null}
      <div className="mt-1 min-w-0 truncate font-mono text-[10px]" title={execution.sql}>执行语句：{execution.sql}</div>
    </div>
    {result.warnings.length ? <ul className="max-h-24 shrink-0 space-y-1 overflow-y-auto bg-amber-500/5 px-4 py-2 text-[11px] text-amber-700 dark:text-amber-400" data-server-ops-sql-write-warnings>{result.warnings.map((warning, index) => <li key={`${index}:${warning}`} className="break-words">{warning}</li>)}</ul> : null}
    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
      <table className={cn(SERVER_OPS_TABLE_CLASS, 'whitespace-nowrap')}>
        <thead><tr><th scope="col">#</th><th scope="col">语句</th><th scope="col">影响行数</th></tr></thead>
        <tbody>{result.statements.map((statement, index) => <tr key={`${index}:${statement.head}`}>
          <td className="tabular-nums text-muted-foreground">{index + 1}</td>
          <td className="font-mono">{statement.head}</td>
          <td className="tabular-nums">{statement.affectedRows}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className={SERVER_OPS_STATUSBAR_CLASS}><span>共 {result.statementCount} 条语句</span><span>累计影响 {result.affectedRows} 行</span><span className={outcomeClassName}>{outcome.detail}</span></div>
  </section>
}

/** 当前库的查询和手工写入页面；写入复用现有执行器，逐次核对目标与 SQL。 */
export function ServerOpsSqlQueryPanel({ api, sourceId, source, database, configurationKey, available, dialect = 'mysql' }: ServerOpsSqlQueryPanelProps): React.ReactElement {
  /** 同步消费确认 atom，阻断 React 重渲染前的双击和快捷键重复提交。 */
  const store = useStore()
  /** 写能力跟随实际来源与方言；MySQL、PostgreSQL、SQLite 均复用统一确认链。 */
  const supportsWrite = source?.id === sourceId && source.engine === dialect
    && (source.engine === 'sqlite' || source.engine === 'mysql' || source.engine === 'postgresql')
  /** 每次确认保存完整脚本和目标快照；关闭即销毁。 */
  const [confirmationAtom] = React.useState(() => atom<SqlWriteConfirmation | null>(null))
  const [confirmation, setConfirmation] = useAtom(confirmationAtom)
  /** 每个 Pane 使用独立表单标识，标题标签可准确聚焦自己的编辑器。 */
  const editorId = React.useId()
  /** 独立无障碍说明标识保证双 Pane 中不会引用另一编辑器的诊断。 */
  const diagnosticsId = React.useId()
  /** 从历史回填后将键盘焦点交回当前 Pane 的编辑器。 */
  const editorRef = React.useRef<ServerOpsSqlEditorHandle>(null)
  /** 元数据只保存在当前 Pane 的私有 atom；持久缓存由主进程管理。 */
  const [completionAtom] = React.useState(() => atom(createServerOpsSqlCompletionIdleProjection()))
  const [completion, setCompletion] = useAtom(completionAtom)
  const completionController = React.useMemo(() => createServerOpsSqlCompletionController({ api, publish: setCompletion }), [api, setCompletion])
  /** 稳定 source 在每次补全时获取最新结构，避免键入时重新配置编辑器。 */
  const completionSource = React.useMemo(() => createServerOpsSqlCompletionSource({ dialect, getSchema: completionController.snapshot, ensureCatalog: completionController.ensureCatalog, ensureColumns: completionController.ensureColumns }), [completionController, dialect])
  const completionContextKey = getServerOpsSqlCompletionContextKey({ sourceId, database, configurationKey, available })
  const visibleCompletion = React.useMemo(() => completion.contextKey === completionContextKey ? completion : createServerOpsSqlCompletionIdleProjection(), [completion, completionContextKey])
  /** 草稿、查询行和执行快照只存在于当前组件的私有 atom。 */
  const [projectionAtom] = React.useState(() => atom(createServerOpsSqlQueryIdleProjection()))
  const [projection, setProjection] = useAtom(projectionAtom)
  /** 单一执行入口根据 SQL 是否能通过只读解析器自动分流查询或写入。 */
  const operation: 'query' | 'write' = React.useMemo(() => {
    if (!projection.draft.trim() || !database) return 'query'
    return validateServerOpsSqlQuery(projection.draft, database, dialect).plan ? 'query' : 'write'
  }, [projection.draft, database, dialect])
  /** 写状态独立于查询结果，避免查询失败或草稿变化覆盖真实写回执。 */
  const [writeProjectionAtom] = React.useState(() => atom(createServerOpsSqlWriteIdleProjection()))
  const [writeProjection, setWriteProjection] = useAtom(writeProjectionAtom)
  /** 完整目标快照也参与当前渲染的校验，防止配置 effect 同步前误写旧库。 */
  const currentWriteContext: ServerOpsSqlWriteContext | null = supportsWrite && source && database
    ? { sourceId, source, database, configurationKey, available } : null
  /** 同时检查来源、数据库、配置与可达状态。 */
  const writeContextMatches = currentWriteContext !== null && isServerOpsSqlWriteContextCurrent(writeProjection.context, currentWriteContext)
  /** 渲染与事件同时核对目标，防止选库 props 先于控制器 effect 更新时误查旧库。 */
  const currentQueryContext = { sourceId, database, configurationKey, available, dialect }
  const queryContextMatches = isServerOpsSqlQueryContextCurrent(projection.context, currentQueryContext)
  /** 输入法组合与诊断只属于当前 Pane；不进入持久草稿或查询历史。 */
  const [validationAtom] = React.useState(() => atom<SqlValidationSnapshot | null>(null))
  const [validation, setValidation] = useAtom(validationAtom)
  const [composingAtom] = React.useState(() => atom(false))
  const [composing, setComposing] = useAtom(composingAtom)
  /** 文本或连接一变就隐藏旧结果，等待本次本地校验，不沿用旧的绿色通过状态。 */
  const visibleValidation = !composing && validation?.sql === projection.draft && validation.contextKey === completionContextKey && validation.dialect === dialect && validation.operation === operation ? validation.result : null
  const diagnostics = visibleValidation?.diagnostics ?? EMPTY_DIAGNOSTICS
  /** 输出页签和历史读取独立于查询结果，切换页签不取消在途查询。 */
  const [outputTabAtom] = React.useState(() => atom<'result' | 'history'>('result'))
  const [outputTab, setOutputTab] = useAtom(outputTabAtom)
  const [historyAtom] = React.useState(() => atom(createServerOpsSqlQueryHistoryIdleProjection()))
  const [history, setHistory] = useAtom(historyAtom)
  /** 历史写入独立收口；本地保存失败不会覆盖 SQL 执行状态。 */
  const historyController = React.useMemo(() => createServerOpsSqlQueryHistoryController({
    api: { list: api.listServerOpsDatabaseQueryHistory, save: api.saveServerOpsDatabaseQueryHistory },
    publish: setHistory,
  }), [api, setHistory])
  /** 查询沿用 SQL 历史保存；写入历史由主进程落盘，Renderer 只重新读取。 */
  const historyExecutionHandlers = React.useMemo(
    () => createServerOpsSqlHistoryExecutionHandlers(historyController),
    [historyController],
  )
  /** 桥接引用稳定时控制器保持稳定，切库由显式上下文代次处理。 */
  const controller = React.useMemo(() => createServerOpsSqlQueryController({
    api: {
      query: api.queryServerOpsDatabase,
      cancel: api.cancelServerOpsDatabaseQuery,
    },
    publish: setProjection,
    onExecuted: historyExecutionHandlers.onQueryExecuted,
  }), [api, setProjection, historyExecutionHandlers])
  /** 沿用写入控制器的取消、单飞、回执匹配和卸载失效保护。 */
  const writeController = React.useMemo(() => createServerOpsSqlWriteController({
    api: { write: api.writeServerOpsDatabase, cancel: api.cancelServerOpsDatabaseWrite },
    publish: setWriteProjection,
    onExecuted: historyExecutionHandlers.onWriteExecuted,
  }), [api, setWriteProjection, historyExecutionHandlers])
  React.useEffect(() => {
    writeController.activate()
    return () => writeController.dispose()
  }, [writeController])
  React.useEffect(() => {
    if (supportsWrite && source && database) writeController.setContext({ sourceId, source, database, configurationKey, available })
    else writeController.clearContext()
  }, [writeController, supportsWrite, sourceId, source, database, configurationKey, available])
  React.useEffect(() => {
    /** 配置、SQL 或连接状态变化时撤销旧确认；对象等值更新不打断确认。 */
    if (confirmation && (operation !== 'write' || !currentWriteContext || !available
      || !isServerOpsSqlWriteContextCurrent(confirmation.context, currentWriteContext)
      || confirmation.sql !== projection.draft)) setConfirmation(null)
  }, [confirmation, operation, currentWriteContext, available, projection.draft, setConfirmation])
  React.useEffect(() => {
    completionController.activate()
    return () => completionController.dispose()
  }, [completionController])
  React.useEffect(() => {
    completionController.setContext({ sourceId, database, configurationKey, available })
  }, [completionController, sourceId, database, configurationKey, available])
  React.useEffect(() => {
    historyController.activate()
    return () => historyController.dispose()
  }, [historyController])
  React.useEffect(() => {
    historyController.setContext({ sourceId, database, configurationKey })
    setOutputTab('result')
  }, [historyController, sourceId, database, configurationKey, setOutputTab])
  React.useEffect(() => {
    controller.activate()
    return () => controller.dispose()
  }, [controller])
  React.useEffect(() => {
    controller.setContext({ sourceId, database, configurationKey, available, dialect })
  }, [controller, sourceId, database, configurationKey, available, dialect])
  React.useEffect(() => {
    if (composing || !database || !projection.draft.trim()) return
    /** 停顿 350ms 后只读取现有结构，快速输入和卸载会清理待执行校验。 */
    const timer = setTimeout(() => {
      setValidation({ sql: projection.draft, contextKey: completionContextKey, dialect, operation, result: operation === 'write'
        ? validateServerOpsSqlWriteDraft(projection.draft, dialect)
        : validateServerOpsSqlDraft(projection.draft, database, visibleCompletion, dialect) })
    }, 350)
    return () => clearTimeout(timer)
  }, [projection.draft, database, completionContextKey, visibleCompletion, composing, dialect, operation, setValidation])

  /** 手动校验及执行前检查共用纯函数，不调用查询或历史接口。 */
  const validateDraft = (locate: boolean): ServerOpsSqlDraftValidation => {
    const sql = controller.snapshot().draft
    const result = operation === 'write' ? validateServerOpsSqlWriteDraft(sql, dialect) : validateServerOpsSqlDraft(sql, database, visibleCompletion, dialect)
    setValidation({ sql, contextKey: completionContextKey, dialect, operation, result })
    if (locate && result.diagnostics[0]) editorRef.current?.reveal(result.diagnostics[0])
    return result
  }

  /** 点击与快捷键共用入口；按 SQL 自动分流，写入只准备快照，确认前绝不发出请求。 */
  const executeSql = (): void => {
    if (composing || busy || store.get(confirmationAtom)
      || !isServerOpsSqlQueryContextCurrent(controller.snapshot().context, currentQueryContext)) return
    if (operation === 'write') {
      if (!currentWriteContext || !writeContextMatches || !writeProjection.canExecute || unavailableReason) return
    } else if (!controller.snapshot().canExecute) return
    const result = validateDraft(false)
    if (result.status !== 'valid') {
      if (result.diagnostics[0]) editorRef.current?.reveal(result.diagnostics[0])
      return
    }
    if (operation === 'write' && currentWriteContext) {
      /** 同步读取草稿并冻结，避免确认期间编辑器或数据源对象被替换。 */
      const sql = controller.snapshot().draft
      setConfirmation({ context: structuredClone(currentWriteContext), sql, heads: validateServerOpsSqlWriteDraft(sql, dialect).heads })
      return
    }
    setOutputTab('result')
    void controller.execute(currentQueryContext)
  }
  /** 确认按钮只消费一次快照，所有目标和草稿在执行前再次核对。 */
  const confirmWrite = (): void => {
    /** 从当前 store 取值而不是捕获旧 render，阻断连续确认事件。 */
    const pending = store.get(confirmationAtom)
    setConfirmation(null)
    if (!pending || operation !== 'write' || !currentWriteContext || unavailableReason || busy
      || !isServerOpsSqlWriteContextCurrent(pending.context, currentWriteContext)
      || pending.sql !== controller.snapshot().draft
      || validateServerOpsSqlWriteDraft(pending.sql, dialect).status !== 'valid') return
    setOutputTab('result')
    void writeController.execute(pending.sql, pending.context)
  }
  /** 历史回填不执行 SQL，也不改变上次成功结果的执行快照。 */
  const useHistorySql = (sql: string): void => {
    if (busy) return
    setConfirmation(null)
    controller.setDraft(sql)
    editorRef.current?.focus()
  }
  /** 接口、选库和连接状态按最具体原因提示。 */
  const unavailableReason = operation === 'write' && (!api.writeServerOpsDatabase || !api.cancelServerOpsDatabaseWrite)
    ? '写入接口尚未就绪，请重启应用后重试。'
    : operation === 'query' && (!api.queryServerOpsDatabase || !api.cancelServerOpsDatabaseQuery)
      ? '查询接口尚未就绪，请重启应用后重试。'
    : !database ? '请先在顶部选择数据库。'
      : !available ? `当前连接不可达，恢复连接后才能${operation === 'write' ? '写入' : '查询'}。` : null
  /** 两条执行链互斥；运行中不能对同一来源再发请求。 */
  const busy = projection.status === 'running' || projection.status === 'cancelling'
    || writeProjection.status === 'running' || writeProjection.status === 'cancelling'
  /** 结果和取消操作跟随自动识别的操作类型；配置改变时隐藏旧来源回执。 */
  const activeProjection = operation === 'write' ? writeProjection : projection
  const execution = operation === 'query' && queryContextMatches ? projection.execution : null
  /** 确认身份变化当帧即隐藏弹窗，不依赖异步 effect 才阻止点击。 */
  const visibleConfirmation = confirmation && operation === 'write' && currentWriteContext && available && !unavailableReason
    && isServerOpsSqlWriteContextCurrent(confirmation.context, currentWriteContext)
    && confirmation.sql === projection.draft ? confirmation : null
  /** 当前操作的取消入口保留真实回执，不把点击取消解释为回滚成功。 */
  const cancelExecution = (): void => { void (operation === 'write' ? writeController.cancel() : controller.cancel()) }
  /** props 切库到 effect 生效之间也不展示旧数据库历史。 */
  const visibleHistory = history.context?.sourceId === sourceId && history.context.database === database && history.context.configurationKey === configurationKey
    ? history : createServerOpsSqlQueryHistoryIdleProjection()
  /** 结果尚未出现时仍明确区分等待执行、执行中、取消和不可用原因。 */
  /** 操作名称统一驱动按钮、状态和结果标题，避免写入仍显示查询文案。 */
  const operationLabel = operation === 'write' ? '写入' : '查询'
  const emptyTitle = unavailableReason ? `暂时无法${operationLabel}` : activeProjection.status === 'cancelling' ? `正在取消${operationLabel}` : busy ? `正在执行${operationLabel}` : activeProjection.error ? `${operationLabel}未完成` : `等待执行${operationLabel}`
  /** 空白区只显示当前最相关的操作提示，详细语法规则放入查询说明。 */
  const emptyDescription = unavailableReason ?? (activeProjection.status === 'cancelling'
    ? operation === 'write' ? '正在取消写入，是否生效以最终回执为准。' : '正在释放本次查询，完成后可重新执行。'
    : busy ? '执行完成后，结果会显示在这里。' : activeProjection.error ? '请根据上方提示处理。'
      : '输入任意 SQL，点击「执行」或使用快捷键；写入语句会在执行前要求确认。')
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-server-ops-sql-query data-server-ops-sql-dialect={dialect}>
    <section className="m-3 shrink-0 overflow-hidden rounded-xl border border-border/60 bg-content-area" aria-label="SQL 查询编辑区" data-server-ops-sql-editor-region>
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/40 bg-muted/20 px-3 py-1.5">
        <label htmlFor={editorId} className="flex items-center gap-1.5 text-xs font-medium"><Code2 className="size-3.5 text-muted-foreground" aria-hidden="true" />SQL 编辑器</label>
        <span className="flex items-center gap-1 rounded-md bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"><TriangleAlert className="size-3" aria-hidden="true" />自动识别 SQL；写入前需确认</span>
        <Popover>
          <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" className="ml-auto h-7 gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground" aria-label="SQL 说明"><CircleHelp className="size-3.5" aria-hidden="true" />SQL 说明</Button></PopoverTrigger>
          <PopoverContent align="end" className="z-[260] w-80 max-w-[calc(100vw-2rem)] space-y-2 text-xs leading-5">
            <h3 className="font-medium">SQL 执行说明</h3>
            <p className="text-muted-foreground">输入后会自动识别受控 SELECT 查询或写入脚本。查询支持当前库基础表的筛选、排序、分组聚合与受控 JOIN；写入支持 INSERT、UPDATE、DELETE、建表和改表等脚本。</p>
            <p className="text-muted-foreground">写入每次执行前确认完整 SQL 和目标库，最多 200 条语句、16 KiB，事务由应用管理，不支持手工 BEGIN、COMMIT 或切换数据库。结果未知或部分生效时请先核对数据，不要直接重跑。</p>
            <p className="text-muted-foreground">每次最多返回 200 行。大字段请明确选择字段，或使用 <code className="break-words font-mono text-foreground">{dialect === 'sqlite' ? 'substr(字段, 1, 256)' : 'SUBSTRING(字段, 1, 256)'}</code>。</p>
            <p className="text-muted-foreground">单表与联表均设 {SERVER_OPS_DATA_QUERY_TIMEOUT_MS / 1_000} 秒执行上限，超时释放本次连接。请优先限定查询条件；超时后不会自动重试。</p>
            <p className="text-muted-foreground">查询结果不会自动刷新，修改 SQL 后需要重新执行。</p>
          </PopoverContent>
        </Popover>
      </div>
      <ServerOpsSqlEditor
        id={editorId}
        ref={editorRef}
        contextKey={completionContextKey}
        completionSource={completionSource}
        diagnostics={diagnostics}
        diagnosticsId={diagnosticsId}
        dialect={dialect}
        value={projection.draft}
        onChange={(value) => { setConfirmation(null); controller.setDraft(value) }}
        onExecute={executeSql}
        onCompositionChange={setComposing}
      />
      <div className="flex min-w-0 items-center gap-2 border-t border-border/30 px-3 py-1 text-[10px] text-muted-foreground" data-server-ops-sql-schema-status>
        {visibleCompletion.status === 'loading' || visibleCompletion.pendingTables > 0 ? <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden="true" /> : null}
        <span className="min-w-0 flex-1 truncate" role="status" title={visibleCompletion.error ?? undefined}>{visibleCompletion.error ?? (visibleCompletion.status === 'loading' ? '正在读取表目录…' : visibleCompletion.pendingTables > 0 ? '正在读取字段…' : visibleCompletion.status === 'ready' ? `${visibleCompletion.tables.length} 张表${visibleCompletion.tablesTruncated ? '（目录已截断）' : ''} · 字段按需加载 · Tab 接受联想` : '选择数据库后可联想表名和字段')}</span>
        <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1.5 text-[10px]" disabled={!database || !available || visibleCompletion.status === 'loading'} onClick={() => { void completionController.refresh() }} aria-label="刷新数据库结构"><RotateCw className="size-3" aria-hidden="true" />刷新结构</Button>
      </div>
      <div id={diagnosticsId} className="max-h-28 overflow-y-auto border-t border-border/30 px-3 py-1.5 text-[11px] leading-5" data-server-ops-sql-validation>
        {diagnostics.length > 0 ? <ul className="space-y-1" aria-label="SQL 校验提示">{diagnostics.map((diagnostic, index) => {
          /** 用户看到的行列从 1 开始，位置不泄漏 SQL 中的常量。 */
          const before = projection.draft.slice(0, diagnostic.from).split('\n')
          const location = `第 ${before.length} 行，第 ${(before.at(-1)?.length ?? 0) + 1} 列`
          const category = diagnostic.category === 'schema' ? '结构提醒' : diagnostic.category === 'unsupported' ? '暂不支持' : diagnostic.category === 'policy' ? '查询限制' : '语法错误'
          return <li key={`${diagnostic.code}:${diagnostic.from}:${index}`}><button type="button" className={cn('w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40', diagnostic.severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400')} onClick={() => editorRef.current?.reveal(diagnostic)} title={`点击定位：${location}`}><span className="font-medium">{category}</span><span className="ml-2 text-muted-foreground">{location}</span><span className="block break-words">{diagnostic.message}</span></button></li>
        })}</ul> : null}
        <p role="status" aria-live="polite" className={cn('text-muted-foreground', diagnostics.length > 0 && 'sr-only')}>
          {diagnostics.length > 0 ? `${diagnostics.length} 条校验提示：${diagnostics[0]?.message}` : !database ? '选择数据库后可校验 SQL' : !projection.draft.trim() ? '输入 SQL 后自动校验，也可点击「校验」' : composing ? '输入完成后自动校验' : !visibleValidation ? '等待输入完成后校验…' : operation === 'write' ? '脚本边界校验通过，SQL 语法与账号权限以数据库执行结果为准。' : '语法校验通过，执行时仍会检查结构与权限。'}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border/40 bg-muted/10 px-3 py-2" data-server-ops-sql-actions>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" size="sm" variant="outline" aria-label="校验 SQL" disabled={!database || !projection.draft.trim() || composing} onClick={() => { validateDraft(true) }}><ListChecks className="size-3.5" aria-hidden="true" />校验</Button>
          <Button
            type="button"
            size="sm"
            aria-label="执行"
            disabled={busy || !!unavailableReason || !queryContextMatches || composing || !projection.draft.trim()
              || (operation === 'write' ? !writeContextMatches || !writeProjection.canExecute : !projection.canExecute)}
            onClick={executeSql}
          >
            {activeProjection.status === 'running' ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}执行
          </Button>
          <Button type="button" size="sm" variant="outline" aria-label={`取消${operationLabel}`} disabled={activeProjection.status !== 'running'} onClick={cancelExecution}>
            {activeProjection.status === 'cancelling' ? <LoaderCircle className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}{activeProjection.status === 'cancelling' ? '取消中' : '取消'}
          </Button>
        </div>
        <span className="text-[10px] text-muted-foreground">Ctrl/Cmd + Enter</span>
        {operation === 'query' ? <label className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">最多行数
            <input className="h-7 w-16 rounded-md border border-border/60 bg-content-area px-2 text-xs tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" type="number" min={1} max={200} step={1} value={projection.maxRows} disabled={busy} onChange={(event) => controller.setMaxRows(event.currentTarget.valueAsNumber)} />
          </label> : <span className="ml-auto text-[10px] text-muted-foreground">写入逐次确认 · 记录执行历史</span>}
      </div>
    </section>
    {unavailableReason && execution ? <p className="shrink-0 px-4 py-2 text-xs text-muted-foreground">{unavailableReason}</p> : null}
    {activeProjection.error ? <div role="alert" className="mx-3 my-2 flex shrink-0 flex-wrap items-center gap-2 rounded-md bg-destructive/5 px-3 py-2 text-xs"><span className="min-w-0 flex-1 break-words text-destructive">{activeProjection.error}</span>{operation === 'query' ? <Button type="button" size="sm" variant="outline" disabled={projection.activeQueryId === null ? busy || !projection.canExecute : projection.status !== 'running'} onClick={() => { if (projection.activeQueryId === null) executeSql(); else void controller.cancel() }}><RotateCw className="size-3.5" />{projection.activeQueryId === null ? '重试' : '重试取消'}</Button> : null}</div> : null}
    {visibleHistory.failedCount > 0 ? <div role="alert" className="mx-3 mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-md bg-amber-500/5 px-3 py-2 text-xs"><span className="min-w-0 flex-1 text-amber-700 dark:text-amber-400">{visibleHistory.failedCount} 条 SQL 未能保存到查询历史，不影响查询结果。</span><Button type="button" size="sm" variant="outline" disabled={visibleHistory.saving} onClick={() => { void historyController.retryFailed() }}><RotateCw className="size-3.5" />重试保存</Button></div> : null}
    <Tabs value={outputTab} onValueChange={(value) => { setOutputTab(value === 'history' ? 'history' : 'result'); if (value === 'history') void historyController.refresh() }} className="flex min-h-40 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-y border-border/40 px-3">
        <TabsList aria-label="查询输出" className="h-10 justify-start gap-1 rounded-none bg-transparent p-0">
          <TabsTrigger value="result" className={SERVER_OPS_TAB_CLASS}><Table2 className="size-3.5" aria-hidden="true" />{operationLabel}结果</TabsTrigger>
          <TabsTrigger value="history" className={SERVER_OPS_TAB_CLASS}><History className="size-3.5" aria-hidden="true" />查询历史{visibleHistory.entries.length > 0 ? <span className="text-[10px] tabular-nums text-muted-foreground">{visibleHistory.entries.length}</span> : null}</TabsTrigger>
        </TabsList>
        {visibleHistory.saving ? <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground" role="status"><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />保存中</span> : null}
      </div>
      <TabsContent value="result" className="mt-0 flex min-h-40 min-w-0 flex-1 flex-col data-[state=inactive]:hidden">
        {operation === 'write' && writeContextMatches && writeProjection.execution ? <ServerOpsSqlWriteResult projection={writeProjection} /> : execution ? <ServerOpsSqlQueryResult execution={execution} busy={busy} /> : (
          <section className="flex min-h-40 min-w-0 flex-1 flex-col" aria-label="查询结果">
            <div className="flex min-h-28 flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center text-muted-foreground">
              <span className="flex size-9 items-center justify-center rounded-xl bg-muted/40">{busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Table2 className="size-4" aria-hidden="true" />}</span>
              <p className="text-xs font-medium text-foreground/80" role="status">{emptyTitle}</p>
              <p className="max-w-sm text-[11px] leading-5">{emptyDescription}</p>
            </div>
          </section>
        )}
      </TabsContent>
      <TabsContent value="history" className="mt-0 flex min-h-40 min-w-0 flex-1 flex-col data-[state=inactive]:hidden">
        <ServerOpsSqlQueryHistory projection={visibleHistory} onUse={useHistorySql} onRefresh={() => { void historyController.refresh() }} />
      </TabsContent>
    </Tabs>
    <AlertDialog open={visibleConfirmation !== null} onOpenChange={(open) => { if (!open) setConfirmation(null) }}>
      <AlertDialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden" onCloseAutoFocus={(event) => { event.preventDefault(); editorRef.current?.focus() }}>
        <AlertDialogHeader>
          <AlertDialogTitle>确认执行写入</AlertDialogTitle>
          <AlertDialogDescription>这段 SQL 会直接修改数据库。请核对目标与完整脚本，确认已有备份或恢复方式。</AlertDialogDescription>
        </AlertDialogHeader>
        {visibleConfirmation ? <div className="min-h-0 space-y-3 overflow-y-auto text-xs">
          <p className="break-all rounded-md border border-border/60 bg-muted/30 p-3" data-server-ops-sql-write-target>{formatServerOpsSqlWriteTarget(visibleConfirmation.context.source, visibleConfirmation.context.database)}{visibleConfirmation.context.source.transport === 'ssh' ? (visibleConfirmation.context.source.engine === 'sqlite' ? '（通过 SSH 修改服务器文件）' : '（通过 SSH 转发连接数据库）') : ''}</p>
          <p className="text-muted-foreground">共 {visibleConfirmation.heads.length} 条语句：{visibleConfirmation.heads.join('、')}</p>
          <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 font-mono leading-5" aria-label="待执行 SQL">{visibleConfirmation.sql}</pre>
          <p className="leading-5 text-muted-foreground">{getServerOpsSqlWriteConfirmationDescription(dialect)}断线、超时或取消可能导致结果未知，请先核对实际数据再决定后续操作。</p>
        </div> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={confirmWrite}>确认执行写入</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}
