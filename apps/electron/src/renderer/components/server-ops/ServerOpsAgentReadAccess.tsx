import * as React from 'react'
import { atom, useAtom, useStore } from 'jotai'
import { Database, LoaderCircle, ShieldCheck } from 'lucide-react'
import type { ServerOpsDataSource } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { serverOpsDatabaseNavigationAtom } from '@/atoms/server-ops-database-atoms'
import type { ServerOpsConnection } from './server-ops-connections'
import { createServerOpsAgentReadController, emptyServerOpsAgentReadProjection } from './server-ops-agent-read-controller'
import type { ServerOpsDatabaseAgentPolicyApi } from './server-ops-agent-read-controller'
import type { ServerOpsAgentCatalogApi } from './server-ops-agent-catalog-controller'
import { ServerOpsDatabaseAgentPolicy } from './ServerOpsDatabaseAgentPolicy'
import { resolveServerOpsAgentDatabase } from './server-ops-agent-table-scope'

/** 数据库禁用表编辑器只接收公开连接目录，不接触凭据或会话授权。 */
export interface ServerOpsAgentReadAccessProps {
  projectId: string
  allConnections: readonly ServerOpsConnection[]
  dataSources: readonly ServerOpsDataSource[]
  /** 与数据库工作台一致的 Pane 导航范围，避免跨会话或面板复用选库。 */
  viewScope?: string
  /** 仅当前正在查看的连接沿用选库，其他连接的浏览历史不作为编辑目标。 */
  activeSourceId?: string
  /** 数据库卡片绑定的连接；SSH 和 Redis 不再提供板块授权入口。 */
  connectionId: string
  /** 外部卡片已经提供入口；挂载后加载并打开同一个编辑器。 */
  dialogOnly?: boolean
  /** 关闭或保存后通知外部释放编辑器，并恢复卡片入口焦点。 */
  onClosed?: () => void
  policyApi?: ServerOpsDatabaseAgentPolicyApi
  catalogApi?: ServerOpsAgentCatalogApi
}

/** 不可达的会话授权接口；数据库控制器以 null 会话运行，确保不会发起 grant 读写。 */
const DATABASE_ONLY_ACCESS_API = {
  get: async () => null,
  set: async () => null,
}

/** 数据库入口只维护持久禁用表；服务器和 Redis 保存并连接后即可由 Agent 使用。 */
export function ServerOpsAgentReadAccess({ projectId, allConnections, dataSources, viewScope = 'default', activeSourceId, connectionId, dialogOnly = false, onClosed, policyApi, catalogApi }: ServerOpsAgentReadAccessProps): React.ReactElement {
  /** 只在打开时读取当前 Pane 的选库，不订阅翻页或后台目录请求。 */
  const store = useStore()
  /** 打开时冻结编辑目标，后续导航不偷偷改变禁用项归属。 */
  const databaseTargetsRef = React.useRef<ReadonlyMap<string, string>>(new Map())
  /** 复用数据库策略的代次、CAS 与广播处理，不提供任何会话授权身份。 */
  const projectionAtom = React.useMemo(() => atom(emptyServerOpsAgentReadProjection()), [])
  const [projection, setProjection] = useAtom(projectionAtom)
  const controller = React.useMemo(() => createServerOpsAgentReadController({ api: DATABASE_ONLY_ACCESS_API, policyApi, publish: setProjection }), [policyApi, setProjection])
  const view = projection.projectId === projectId ? projection : emptyServerOpsAgentReadProjection()
  /** 关闭弹窗后恢复入口焦点，保留原键盘交互。 */
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  /** 记录实际打开过的生命周期，区分首读等待与保存后的关闭。 */
  const openedRef = React.useRef(false)
  /** 异步初始化完成后使用最新目标，不因连接列表重渲染重复打开。 */
  const openEditorRef = React.useRef<() => void>(() => undefined)
  const targetConnection = allConnections.find((connection) => connection.id === connectionId && connection.kind === 'database')
  const source = dataSources.find((entry) => entry.id === targetConnection?.sourceId)

  React.useEffect(() => {
    controller.activate()
    const unsubscribePolicy = policyApi?.onChanged?.((policy) => controller.databaseChanged(policy))
    return () => { unsubscribePolicy?.(); controller.dispose() }
  }, [policyApi, controller])
  React.useEffect(() => {
    /** null 会话明确关闭 grant 读取；这里只初始化当前项目的数据库策略编辑上下文。 */
    let current = true
    void controller.select(null, projectId).then(() => {
      if (current && dialogOnly) openEditorRef.current()
    })
    return () => { current = false }
  }, [controller, projectId, dialogOnly])
  React.useEffect(() => {
    if (view.open) openedRef.current = true
    else if (openedRef.current) onClosed?.()
  }, [view.open, onClosed])

  /** 打开禁用表弹窗，只从正在查看的数据库连接捕获选库。 */
  const openEditor = (): void => {
    const targets = new Map<string, string>()
    const activeSource = dataSources.find((entry) => entry.id === activeSourceId && entry.id === targetConnection?.sourceId)
    if (activeSource) {
      const database = resolveServerOpsAgentDatabase(activeSource,
        store.get(serverOpsDatabaseNavigationAtom).get(JSON.stringify([viewScope, activeSource.id])))
      if (database) targets.set(activeSource.id, database)
    }
    databaseTargetsRef.current = targets
    controller.open(targets)
  }
  openEditorRef.current = openEditor
  /** 保存中禁止关闭，避免让用户误以为持久策略写入已取消。 */
  const closeEditor = (): void => {
    if (view.saving) return
    if (dialogOnly && !openedRef.current) onClosed?.()
    else controller.close()
  }
  /** 只提交数据库禁用策略，不生成或续期任何服务器会话授权。 */
  const savePolicy = async (): Promise<void> => {
    await controller.save([], true, false)
  }
  /** 已删除数据源的禁用规则仍展示，用户可明确清除。 */
  const missingDatabases = view.databaseExclusions.filter((entry) => !dataSources.some((item) => item.id === entry.sourceId))
  const busy = view.saving || view.databaseLoading || (dialogOnly && !view.open) || !policyApi

  return <>
    {!dialogOnly ? <Button ref={triggerRef} type="button" variant="outline" size="sm" className="h-8 gap-1.5 rounded-md bg-content-area px-2 text-xs text-foreground/80" aria-label="管理禁用表"
      title={policyApi ? '管理数据库禁用表' : '请完整重启客户端后管理数据库禁用表'} disabled={!targetConnection || !policyApi || view.databaseLoading} onClick={openEditor}>
      {view.databaseLoading ? <LoaderCircle className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
      <span className="shrink-0">管理禁用表</span>
    </Button> : null}
    <Dialog open={view.open || (dialogOnly && !openedRef.current)} onOpenChange={(open) => { if (!open) closeEditor() }}>
      <DialogContent className="z-[260] flex max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl flex-col gap-3 overflow-hidden" overlayClassName="z-[250]" hideClose={view.saving}
        onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus() }}
        onEscapeKeyDown={(event) => { event.stopPropagation(); if (view.saving) event.preventDefault() }}>
        <DialogHeader><DialogTitle>管理禁用表{targetConnection ? ` · ${targetConnection.label}` : ''}</DialogTitle><DialogDescription>未禁用的业务表默认可读取。直连 MySQL 和本地 SQLite 写入由 Agent 原生确认弹窗逐次批准；勾选的表会持续禁止 Agent 读写。</DialogDescription></DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {targetConnection && source ? <div className="min-w-0 space-y-2 rounded-md border border-border/60 p-3">
            <div className="flex min-w-0 items-start gap-2 text-xs font-medium">
              <Database className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1"><span className="block break-words">{targetConnection.label}<span className="ml-2 text-[10px] font-normal text-muted-foreground">读取免授权 · 写入需确认</span></span><span className="mt-0.5 block break-all text-[10px] font-normal text-muted-foreground">{targetConnection.detail}</span></span>
            </div>
            <div className="ml-5 min-w-0 text-xs">
              {view.databasePolicy ? <ServerOpsDatabaseAgentPolicy source={source} currentDatabase={databaseTargetsRef.current.get(source.id)}
                exclusions={view.databaseExclusions} disabled={busy} api={catalogApi} onChange={(exclusions) => controller.editDatabase(exclusions)} />
                : <p className="text-[11px] text-muted-foreground">{view.databaseLoading ? '正在读取禁用规则…' : policyApi ? '禁用规则尚未加载，请重试。' : '请完整重启客户端后设置禁用表，已有规则不会改变。'}</p>}
            </div>
          </div> : <p className="text-xs text-muted-foreground">数据库连接已移除，请关闭窗口后刷新项目。</p>}
          {missingDatabases.map((entry) => <div key={JSON.stringify([entry.sourceId, entry.database])} className="flex items-center justify-between gap-2 text-xs"><span className="break-all">已移除连接的禁用表：{entry.sourceId} / {entry.database}</span><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => controller.editDatabase(view.databaseExclusions.filter((item) => item.sourceId !== entry.sourceId || item.database !== entry.database))}>清除禁用</Button></div>)}
        </div>
        <p className="text-[11px] leading-5 text-muted-foreground">未禁用的业务表（含新增表）默认可查询；勾选的表保存后持久禁用。服务器和 Redis 保存并连接后即可使用，敏感修改仍会记录审计并逐次审批。{view.databasePolicy?.revision === 0 ? '旧版临时禁用未持久保存，需重新勾选保存。' : ''}</p>
        {view.databaseError ? <p role="alert" className="break-words text-xs text-destructive">{view.databaseError}</p> : null}
        {view.error && view.error !== view.databaseError ? <p role="alert" className="break-words text-xs text-destructive">{view.error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {policyApi && !view.databasePolicy && !view.databaseLoading ? <Button type="button" variant="outline" size="sm" disabled={view.saving} onClick={openEditor}>重试</Button> : null}
          <Button type="button" variant="outline" size="sm" disabled={view.saving} onClick={closeEditor}>取消</Button>
          <Button type="button" size="sm" disabled={busy || Boolean(view.databaseError) || !view.databasePolicy} onClick={() => { void savePolicy() }}>
            {view.saving ? <LoaderCircle className="size-3.5 animate-spin" /> : null}保存禁用表
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </>
}
