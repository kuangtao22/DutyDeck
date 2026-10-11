import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { atom, createStore, Provider, useAtomValue } from 'jotai'
import type { ServerOpsDataQueryInput, ServerOpsDataSource, ServerOpsDataWriteInput, ServerOpsDataWriteResult } from '@proma/shared'
import { applyThemeToDOM } from '../src/renderer/atoms/theme'
import { ServerOpsSqlQueryPanel } from '../src/renderer/components/server-ops/ServerOpsSqlQueryPanel'
import type { ServerOpsSqlQueryPanelApi } from '../src/renderer/components/server-ops/ServerOpsSqlQueryPanel'
import '../src/renderer/styles/globals.css'

/** 场景 props 可以变更，生产组件保持挂载以覆盖确认失效。 */
interface FixtureConfig { database: string; available: boolean; missingWrite: boolean; postgres: boolean; filePath: string }
/** 已保存 SSH SQLite 的公开身份；路径仅展示，永不读取。 */
const source: ServerOpsDataSource = { id: 'fixture-source', transport: 'ssh', hostId: 'fixture-host', engine: 'sqlite', label: '隔离 SSH SQLite', filePath: '/fixture/open-api.db', tlsMode: 'disabled', hasPassword: false, createdAt: 1, updatedAt: 1 }
/** 内存调用记录用于证明确认前零请求和确认后不重发。 */
const state = { writes: [] as ServerOpsDataWriteInput[], queries: [] as ServerOpsDataQueryInput[], historyReads: 0, draftSql: 'SELECT id FROM users' }
/** 回执等待测试显式完成，以覆盖在途重复执行。 */
let pending: ((result: ServerOpsDataWriteResult) => void) | undefined
/** 隔离场景状态，不读取用户配置。 */
const configAtom = atom<FixtureConfig>({ database: 'main', available: true, missingWrite: false, postgres: false, filePath: source.filePath! })
/** 独立 Jotai store 不触碰用户设置。 */
const store = createStore()
/** 只实现公开 bridge，不创建真实服务和连接。 */
const api: ServerOpsSqlQueryPanelApi = {
  queryServerOpsDatabase: async (input) => {
    state.queries.push(input)
    return { queryId: input.queryId, database: input.database, columns: ['id'], rows: [['fixture-row']], rowCount: 1, durationMs: 2, truncated: false, warnings: [] }
  },
  cancelServerOpsDatabaseQuery: async () => undefined,
  writeServerOpsDatabase: async (input) => {
    state.writes.push(input)
    return await new Promise<ServerOpsDataWriteResult>((resolve) => { pending = resolve })
  },
  cancelServerOpsDatabaseWrite: async () => undefined,
  listServerOpsDatabaseQueryHistory: async (scope) => { state.historyReads += 1; return { entries: [{ ...scope, id: 'fixture-history', sql: state.draftSql, createdAt: 1 }] } },
  saveServerOpsDatabaseQueryHistory: async () => ({ entries: [] }),
}
Object.assign(window, { __sqlSmoke: {
  state,
  /** 模拟上下文变化，输入局部场景字段，无持久化。 */
  configure: (input: Partial<FixtureConfig>) => store.set(configAtom, { ...store.get(configAtom), ...input }),
  /** 完成最后一次内存写入，保留实际请求身份供生产控制器校验。 */
  finish: (outcome: 'committed' | 'unknown') => {
    /** 最新请求是回执的唯一身份来源。 */
    const input = state.writes.at(-1)
    if (!input || !pending) throw new Error('没有在途写入')
    pending({ writeId: input.writeId, database: input.database, statementCount: 1, affectedRows: outcome === 'committed' ? 1 : 0, committed: outcome === 'committed', outcome, durationMs: 5, statements: [{ head: 'UPDATE', affectedRows: outcome === 'committed' ? 1 : 0 }], warnings: [] })
    pending = undefined
  },
  /** 只修改 fixture DOM 的主题。 */
  setTheme: (mode: 'light' | 'dark') => applyThemeToDOM(mode, 'default'),
} })

/** 渲染真实 SQL 面板，通过公开 props 切换场景。 */
function Fixture(): React.ReactElement {
  /** 当前场景由驱动侧更新。 */
  const config = useAtomValue(configAtom)
  /** 稳定 API，避免普通场景变化重建控制器。 */
  const panelApi = React.useMemo(() => config.missingWrite ? { ...api, writeServerOpsDatabase: undefined, cancelServerOpsDatabaseWrite: undefined } : api, [config.missingWrite])
  /** 数据源身份与方言同步变化。 */
  const selectedSource = React.useMemo<ServerOpsDataSource>(() => config.postgres ? { id: 'fixture-postgres', transport: 'direct', engine: 'postgresql', label: '隔离 PostgreSQL', address: 'db.example.invalid', port: 5432, tlsMode: 'disabled', hasPassword: false, createdAt: 1, updatedAt: 1 } : { ...source, filePath: config.filePath }, [config.postgres, config.filePath])
  React.useEffect(() => { document.body.dataset.smokeReady = 'true' }, [])
  return <div className="flex h-screen flex-col bg-background text-foreground"><ServerOpsSqlQueryPanel api={panelApi} source={selectedSource} sourceId={selectedSource.id} database={config.database} configurationKey={selectedSource.id} available={config.available} dialect={config.postgres ? 'postgresql' : 'sqlite'} /></div>
}
createRoot(document.getElementById('root')!).render(<Provider store={store}><Fixture /></Provider>)
