/** Token 统计 IPC：只接收过滤 DTO，导出路径完全由主进程保存对话框决定。 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { TOKEN_USAGE_IPC } from '@proma/shared'
import type { TokenUsageQuery, TokenUsageTaskDetail } from '@proma/shared'
import type { TokenUsageStore } from './token-usage-store'
import { aggregateTokenUsage, tokenUsageCsv, tokenUsageExportRecords, tokenUsageTaskDetail, validateTokenUsageQuery } from './token-usage-query'
import { importTokenUsageHistory } from './token-usage-history'
import { getTokenUsageRecordingError, getTokenUsageStore } from './token-usage-recorder'
import { getConfigDir } from './config-paths'

/** 注入保持测试不依赖 Electron 窗口、真实文件对话框或业务数据根。 */
export interface TokenUsageIpcDependencies {
  assertSender: (event: IpcMainInvokeEvent) => void
  saveCsv: (csv: string, query: TokenUsageQuery) => Promise<boolean>
  getStore?: () => TokenUsageStore
  getRoot?: () => string
  /** 历史恢复只在后台启动；测试可注入一个受控的长任务。 */
  importHistory?: (root: string, store: TokenUsageStore) => Promise<void>
  /** 已删除会话仅禁用导航，独立用量历史仍可查。 */
  sessionExists?: (type: 'agent' | 'chat', id: string) => boolean
}
/** 注册查询、详情、导出三个固定通道。 */
export function registerTokenUsageIpc(ipc: Pick<IpcMain, 'handle'>, dependencies: TokenUsageIpcDependencies): void {
  /** 每个账本最多保留一条后台恢复错误，避免页面在失败时无限轮询。 */
  const historyImportErrors = new WeakMap<TokenUsageStore, string>()
  /** 防止筛选刷新同时启动多个恢复任务；失败后下一次显式查询可重试。 */
  const historyImports = new WeakMap<TokenUsageStore, Promise<void>>()
  /** 在调用时取得 locator 账本，不在模块导入时访问 home。 */
  const ready = async (): Promise<TokenUsageStore> => {
    const store = (dependencies.getStore ?? getTokenUsageStore)()
    /** 首次查询先返回当前账本；旧历史在后台恢复，避免大历史阻塞首屏。 */
    const root = (dependencies.getRoot ?? getConfigDir)()
    const importHistory = dependencies.importHistory ?? importTokenUsageHistory
    if (store.coverage().historyImportedAt === null) {
      const existing = historyImports.get(store)
      if (!existing) {
        const importing = Promise.resolve().then(() => importHistory(root, store))
        historyImports.set(store, importing)
        void importing.then(
          () => {
            historyImports.delete(store)
            historyImportErrors.delete(store)
          },
          (error: unknown) => {
            historyImports.delete(store)
            const message = error instanceof Error && error.message ? error.message : '历史用量恢复失败，请重试。'
            historyImportErrors.set(store, message)
            console.warn('[Token 统计] 历史用量后台恢复失败', error)
          },
        )
      }
    }
    return store
  }
  ipc.handle(TOKEN_USAGE_IPC.QUERY, async (event, input: unknown) => {
    dependencies.assertSender(event)
    const query = validateTokenUsageQuery(input)
    const store = await ready()
    const coverage = store.coverage()
    const historyImportError = historyImportErrors.get(store)
    if (historyImportError) coverage.historyImportError = historyImportError
    const error = getTokenUsageRecordingError()
    if (error) { coverage.notes = [...coverage.notes, error]; coverage.recordingError = error }
    return aggregateTokenUsage(store.read(query), query, coverage)
  })
  ipc.handle(TOKEN_USAGE_IPC.TASK, async (event, taskId: unknown, input: unknown): Promise<TokenUsageTaskDetail | null> => {
    dependencies.assertSender(event)
    if (typeof taskId !== 'string' || !taskId.length || taskId.length > 2000) throw new Error('任务标识无效')
    const query = validateTokenUsageQuery(input)
    const store = await ready()
    const detail = tokenUsageTaskDetail(store.readTask(taskId), taskId, query)
    if (detail?.task.sessionId && detail.task.sessionType && dependencies.sessionExists && !dependencies.sessionExists(detail.task.sessionType, detail.task.sessionId)) delete detail.task.sessionId
    return detail
  })
  ipc.handle(TOKEN_USAGE_IPC.EXPORT, async (event, input: unknown) => {
    dependencies.assertSender(event)
    const query = validateTokenUsageQuery(input)
    const store = await ready()
    const records = tokenUsageExportRecords(store.read(query), query)
    if (!records.length) return { saved: false, count: 0 }
    const saved = await dependencies.saveCsv(tokenUsageCsv(records), query)
    return { saved, count: saved ? records.length : 0 }
  })
}
