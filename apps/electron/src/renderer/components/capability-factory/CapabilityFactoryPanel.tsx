/** 编排工厂工作区：场景、运行与交付分页呈现，评审和优化归运行，场景管理使用覆盖抽屉。 */
import * as React from 'react'
import type { CapabilityRun, CapabilityScene, CapabilitySceneVersion } from '@proma/shared'
import { Blocks, ChevronDown, History, RotateCw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { WorkspaceEntitySelector } from '@/components/common/WorkspaceEntitySelector'
import { CapabilityFactorySceneRail } from './CapabilityFactorySceneRail'
import { CapabilityFactorySceneDialog } from './CapabilityFactorySceneDialog'
import { CapabilityFactoryRunSection } from './CapabilityFactoryRunSection'
import { CapabilityFactoryStepDialog } from './CapabilityFactoryStepDialog'
import { findSceneStep } from './capability-factory-draft-view'
import { CapabilityFactoryAcceptanceDialog } from './CapabilityFactoryAcceptanceDialog'
import { CapabilityFactorySceneDefinition } from './CapabilityFactorySceneDefinition'
import { CapabilityFactoryVersionList } from './CapabilityFactoryVersionList'
import { describeRollbackEffect } from './capability-factory-version-view'
import { CapabilityFactoryDeliverySection } from './CapabilityFactoryDeliverySection'
import { describeReviewStatus, describeRunStatus, formatDuration } from './capability-factory-run-view'

/** 评审与批量验证统一归运行，避免同一任务有两个入口。 */
type FactoryPaneTab = 'scene' | 'run' | 'deliver'

export interface CapabilityFactoryPanelProps {
  sessionId: string
  /** 当前项目名，只用于展示上下文。 */
  workspaceLabel?: string
}

/** 顶层历史下拉：选择记录后直接回到运行页查看该条真实结果。 */
function CapabilityFactoryHistoryMenu({
  runs,
  error,
  onOpen,
  onSelect,
}: {
  runs: readonly CapabilityRun[] | null
  error: string | null
  onOpen: () => void
  onSelect: (runId: string) => void
}): React.ReactElement {
  // 右侧工作区位于全局窗口拖拽层内；非 modal 菜单避免 pointerdown 被外层焦点/拖拽处理吞掉。
  return (
    <DropdownMenu modal={false} onOpenChange={(open) => { if (open) onOpen() }}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-9 shrink-0 gap-1.5 px-2.5 text-xs" aria-label="打开运行历史">
          <History className="size-3.5" aria-hidden="true" />
          <span>历史{runs && runs.length > 0 ? ` ${runs.length}` : ''}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[240] w-80">
        <DropdownMenuLabel>运行历史</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="max-h-72 overflow-y-auto">
          {error ? <p className="px-2 py-1.5 text-xs text-destructive">{error}</p> : null}
          {!error && runs === null ? <p className="px-2 py-1.5 text-xs text-muted-foreground">正在读取运行记录…</p> : null}
          {!error && runs?.length === 0 ? <p className="px-2 py-1.5 text-xs text-muted-foreground">暂无历史记录</p> : null}
          {runs?.map((run) => {
            const status = describeRunStatus(run)
            const review = describeReviewStatus(run)
            const target = run.definitionTarget === 'draft' ? '候选草案 · ' : ''
            const subject = run.kind === 'step'
              ? `单步 · ${run.steps.find((step) => step.stepId === run.stepId)?.title ?? run.stepId}`
              : '整条流程'
            return (
              <DropdownMenuItem key={run.id} onSelect={() => onSelect(run.id)} className="items-start gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">{target}{subject} · v{run.sceneVersion}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {status.label} · {review.label} · {new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false })}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{formatDuration(run.startedAt, run.finishedAt)}</span>
              </DropdownMenuItem>
            )
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 从任意异常里取出可读文本。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function CapabilityFactoryPanel({ sessionId, workspaceLabel }: CapabilityFactoryPanelProps): React.ReactElement {
  const [scenes, setScenes] = React.useState<CapabilityScene[] | null>(null)
  const [selectedSceneId, setSelectedSceneId] = React.useState<string | null>(null)
  /**
   * 当前页签。默认停在「场景」：刚打开时最常见的问题是"这个场景是什么"，
   * 而不是"再跑一次"；草案通过步骤卡片进入详情对比和采纳。
   */
  const [paneTab, setPaneTab] = React.useState<FactoryPaneTab>('scene')
  /** 场景抽屉默认隐藏，从选择器的「管理场景」进入。 */
  const [railOpen, setRailOpen] = React.useState(false)
  /** 开抽屉前的焦点位置；关抽屉时还回去，键盘用户不会掉到面板之外。 */
  const railReturnFocusRef = React.useRef<HTMLElement | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  /** 新建场景走弹窗（与运维的「添加项目」一致）：抽屉底部不再挂常驻输入行。 */
  const [createOpen, setCreateOpen] = React.useState(false)
  const [createBusy, setCreateBusy] = React.useState(false)
  /** 新建失败只写在弹窗里，不占用列表横幅（那条横幅讲的是读取/改名/删除的错误）。 */
  const [createError, setCreateError] = React.useState<string | null>(null)
  /** 行内重命名：正在编辑的那一行与它的草稿值。 */
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [renameValue, setRenameValue] = React.useState('')
  /** 待删除确认的场景。 */
  const [pendingDelete, setPendingDelete] = React.useState<CapabilityScene | null>(null)
  /** 正在训练的那一步（null 表示弹窗关闭）。 */
  const [stepDialogId, setStepDialogId] = React.useState<string | null>(null)
  /** 正在编辑评审标准的模型步骤（null 表示弹窗关闭）。 */
  const [acceptanceDialogId, setAcceptanceDialogId] = React.useState<string | null>(null)
  /** 打开时保留场景，轮询删除步骤或暂时读取失败也不销毁未保存表单。 */
  const stepDialogSceneRef = React.useRef<CapabilityScene | null>(null)
  const acceptanceDialogSceneRef = React.useRef<CapabilityScene | null>(null)
  /** 版本历史（只在展开时拉取：它是次要信息，不必每次刷新都读）。 */
  const [versions, setVersions] = React.useState<CapabilitySceneVersion[] | null>(null)
  const [versionsOpen, setVersionsOpen] = React.useState(false)
  const [rollbackBusy, setRollbackBusy] = React.useState(false)
  /** 待确认的回滚目标版本。 */
  const [pendingRollback, setPendingRollback] = React.useState<number | null>(null)
  /** 顶层历史下拉的数据；选择后交给运行页展示对应的真实记录。 */
  const [runHistory, setRunHistory] = React.useState<CapabilityRun[] | null>(null)
  const [runHistoryError, setRunHistoryError] = React.useState<string | null>(null)
  const [historySelectionId, setHistorySelectionId] = React.useState<string | null>(null)
  /** 顶层会话切换后丢弃旧列表，避免把另一工作区的场景显示回来。 */
  const scope = React.useMemo(() => ({}), [sessionId])
  const currentScope = React.useRef<object | null>(scope)
  currentScope.current = scope
  const refreshGeneration = React.useRef(0)

  /** 拉取场景列表；失败时把原因显示出来，不静默空着。选中项失效时回落到第一项。 */
  const refresh = React.useCallback(async () => {
    if (currentScope.current !== scope) return
    const ticket = ++refreshGeneration.current
    try {
      const list = await window.electronAPI.capabilityFactory.invoke('listScenes', { sessionId })
      if (currentScope.current !== scope || ticket !== refreshGeneration.current) return
      setScenes(list)
      setSelectedSceneId((current) => {
        if (current && list.some((scene) => scene.id === current)) return current
        return list[0]?.id ?? null
      })
      setError(null)
    } catch (cause) {
      if (currentScope.current !== scope || ticket !== refreshGeneration.current) return
      setError(errorText(cause))
      setScenes([])
    }
  }, [sessionId, scope])

  React.useEffect(() => {
    currentScope.current = scope
    void refresh()
    return () => { currentScope.current = null; refreshGeneration.current += 1 }
  }, [refresh, scope])

  /** Agent 与 UI 的变更共用宿主事件；仅旧 preload 使用原有低频兼容刷新。 */
  React.useEffect(() => {
    if (window.electronAPI.capabilityFactory.onChanged) {
      /** 批次的步骤进度合并刷新，避免重复读取场景列表。 */
      let timer: ReturnType<typeof setTimeout> | undefined
      const unsubscribe = window.electronAPI.capabilityFactory.onChanged((event) => {
        if (event.sessionId !== sessionId) return
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => { void refresh() }, 80)
      })
      return () => { if (timer !== undefined) clearTimeout(timer); unsubscribe() }
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [refresh, sessionId])

  /** 手动刷新：轮询之外再给一个明确的动作，人看到 Agent 的改动后不用等下一轮。 */
  const manualRefresh = React.useCallback(() => {
    void refresh()
  }, [refresh])

  /** 打开场景抽屉：先记住当前焦点，关抽屉时按同一位置还回去。 */
  const openRail = React.useCallback(() => {
    railReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setRailOpen(true)
  }, [])

  /** 关闭场景抽屉；焦点只还给仍在文档里的元素，避免落到已卸载的按钮上。 */
  const closeRail = React.useCallback(() => {
    setRailOpen(false)
    const previous = railReturnFocusRef.current
    if (previous?.isConnected) previous.focus()
  }, [])

  /** 新建场景：成功后关弹窗并自动选中它，避免用户以为没生效；失败则留着弹窗与已填的名字。 */
  const createScene = React.useCallback(async (sceneName: string) => {
    const trimmed = sceneName.trim()
    if (trimmed.length === 0 || createBusy) return
    setCreateBusy(true)
    try {
      const created = await window.electronAPI.capabilityFactory.invoke('createScene', { sessionId, name: trimmed })
      setCreateOpen(false)
      setCreateError(null)
      await refresh()
      setSelectedSceneId(created.id)
    } catch (cause) {
      setCreateError(errorText(cause))
    } finally {
      setCreateBusy(false)
    }
  }, [createBusy, refresh, sessionId])

  const current = scenes?.find((scene) => scene.id === selectedSceneId) ?? null
  /** 实时场景只用于冲突提醒；弹窗身份始终指向打开时的场景。 */
  const liveStepDialogScene = scenes?.find((scene) => scene.id === stepDialogSceneRef.current?.id) ?? null
  const liveAcceptanceDialogScene = scenes?.find((scene) => scene.id === acceptanceDialogSceneRef.current?.id) ?? null
  /** 切场景时丢掉上一个场景的版本历史，避免看到别的场景的版本。 */
  React.useEffect(() => { setVersions(null); setVersionsOpen(false) }, [selectedSceneId])
  React.useEffect(() => {
    setStepDialogId(null)
    setAcceptanceDialogId(null)
    setHistorySelectionId(null)
  }, [sessionId, selectedSceneId])

  /** 读取当前场景的最近运行记录；下拉打开时会再次刷新，保证数量和内容是最新的。 */
  const loadRunHistory = React.useCallback(async () => {
    if (!current) return
    try {
      const history = await window.electronAPI.capabilityFactory.invoke('listRuns', {
        sessionId, sceneId: current.id, limit: 20,
      })
      setRunHistory(history)
      setRunHistoryError(null)
    } catch (cause) {
      setRunHistory([])
      setRunHistoryError(`读取运行历史失败：${errorText(cause)}`)
    }
  }, [current?.id, sessionId])

  React.useEffect(() => {
    setRunHistory(null)
    setRunHistoryError(null)
    void loadRunHistory()
  }, [loadRunHistory])

  /** 选择器与左列表共用同一个动作：切高亮 + 切右侧内容。 */
  const selectScene = React.useCallback((sceneId: string) => {
    setStepDialogId(null)
    setAcceptanceDialogId(null)
    setSelectedSceneId(sceneId)
  }, [])

  /** 从顶层历史菜单进入运行页，并让运行区展示用户点中的那条记录。 */
  const selectHistoryRun = React.useCallback((runId: string) => {
    setHistorySelectionId(runId)
    setPaneTab('run')
  }, [])

  /** 行内重命名：提交即发新版本（服务层保证版本号唯一指向一份定义）。 */
  const commitRename = React.useCallback(async () => {
    const target = renamingId
    const next = renameValue.trim()
    setRenamingId(null)
    if (!target || next.length === 0) return
    try {
      await window.electronAPI.capabilityFactory.invoke('renameScene', { sessionId, sceneId: target, name: next })
      await refresh()
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [refresh, renameValue, renamingId, sessionId])

  /** 删除场景：由确认框兜底，确认后从索引移除（版本历史保留）。 */
  const confirmDelete = React.useCallback(async () => {
    const target = pendingDelete
    if (!target) return
    try {
      await window.electronAPI.capabilityFactory.invoke('deleteScene', { sessionId, sceneId: target.id })
      setPendingDelete(null)
      await refresh()
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [pendingDelete, refresh, sessionId])

  /** 拉取版本历史：只在展开版本区时读，避免每次轮询都多读一个文件。 */
  const loadVersions = React.useCallback(async () => {
    if (!current) return
    try {
      setVersions(await window.electronAPI.capabilityFactory.invoke('listVersions', {
        sessionId, sceneId: current.id,
      }))
    } catch (cause) {
      setError(errorText(cause))
      setVersions([])
    }
  }, [current, sessionId])

  /**
   * 回滚：把选中的旧快照提升为新版本（版本号只增不减，历史不删）。
   * 这是"让人敢让 Agent 放手改"的前提 —— 改坏了随时回得去。
   */
  const confirmRollback = React.useCallback(async () => {
    const target = pendingRollback
    if (!current || target === null || rollbackBusy) return
    setRollbackBusy(true)
    try {
      await window.electronAPI.capabilityFactory.invoke('rollback', {
        sessionId, sceneId: current.id, targetVersion: target,
      })
      setPendingRollback(null)
      await refresh()
      await loadVersions()
    } catch (cause) {
      setError(errorText(cause))
      setPendingRollback(null)
    } finally {
      setRollbackBusy(false)
    }
  }, [current, loadVersions, pendingRollback, refresh, rollbackBusy, sessionId])

  return (
    /** relative：场景抽屉在自己的面板内绝对定位，不会飞到窗口最左边。 */
    <Tabs value={paneTab} onValueChange={(value) => setPaneTab(value as FactoryPaneTab)} className="titlebar-no-drag relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* ① 顶栏：图标 + 模块名 在左，选择器在右（与运维工具栏同构） */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/40 px-3 py-3">
        {/*
          场景栏不再单独给按钮：入口只留选择器下拉里的「管理场景」一个。
          模块名已经占住左侧，再放一个常驻按钮会变成「两个入口抢同一行的宽度」。
        */}
        <div className="flex shrink-0 items-center gap-2.5">
          <Blocks className="size-6 text-foreground/70" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-foreground">编排工厂</h1>
        </div>

        {/*
          与运维的项目切换共用同一个菜单组件：单选语义、层级、滚动上限、「管理」入口都一致，
          否则同一种交互在两个模块里长得不一样，用户会怀疑是两个功能。
        */}
        <WorkspaceEntitySelector
          items={(scenes ?? []).map((scene) => ({
            id: scene.id,
            name: scene.definition.name,
            meta: `v${scene.currentVersion}`,
          }))}
          value={selectedSceneId}
          onSelect={selectScene}
          emptyLabel="这个项目还没有场景"
          manage={{ label: '管理场景', onSelect: openRail }}
          trigger={(ref) => (
            <Button
              ref={ref}
              type="button"
              variant="outline"
              className="ml-auto h-8 min-w-0 max-w-[48%] gap-1.5 border-border/60 bg-background/40 px-2 text-xs font-normal"
              aria-label="切换编排场景"
            >
              <span className="flex-1 truncate text-left">{current ? current.definition.name : '选择场景'}</span>
              <ChevronDown className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
            </Button>
          )}
        />

        {/* Agent 的改动不经过这个面板，所以给一个明确的刷新动作，不必等轮询那一轮 */}
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button" variant="ghost" size="icon-sm"
                aria-label="刷新场景" onClick={manualRefresh}
              >
                <RotateCw className="size-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">刷新场景</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* 复用项目页签，支持方向键切换；说明移入场景详情。 */}
      {current ? (
        <div className="mx-3 my-3 flex min-w-0 shrink-0 items-center gap-2">
          <TabsList className="grid min-w-0 flex-1 grid-cols-3" aria-label="编排工厂视图">
          {([['scene', '场景'], ['run', '运行'], ['deliver', '交付']] as const).map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              className="px-2 text-xs"
            >
              {label}
            </TabsTrigger>
          ))}
          </TabsList>
          <CapabilityFactoryHistoryMenu
            runs={runHistory}
            error={runHistoryError}
            onOpen={() => { void loadRunHistory() }}
            onSelect={selectHistoryRun}
          />
        </div>
      ) : null}

      {/* 抽屉展开时错误改在抽屉里说明，避免同一句话在遮罩前后各显示一遍 */}
      {error && !railOpen ? (
        <div className="mx-3.5 mb-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {/* ③ 当前页签：左列已改成抽屉，内容不再被列表挤窄 */}
      <TabsContent value={paneTab} className="mt-0 flex min-h-0 flex-1 flex-col">
      {current && paneTab === 'run' ? (
        <CapabilityFactoryRunSection key={`${sessionId}:${current.id}:${current.currentVersion}`} sessionId={sessionId} scene={current} onSceneChanged={refresh} historySelectionId={historySelectionId} />
      ) : current && paneTab === 'deliver' ? (
        <CapabilityFactoryDeliverySection key={`${current.id}:${current.currentVersion}`} sessionId={sessionId} scene={current} />
      ) : (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!current ? (
          <div className="mx-auto mt-8 max-w-sm space-y-2 p-6 text-center">
            <p className="text-sm font-medium">{scenes === null ? '正在加载场景…' : '这个项目还没有编排场景'}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              在当前会话中让 Agent 按项目业务设计场景，或从「管理场景」添加。
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            <CapabilityFactorySceneDefinition scene={current} onSelectStep={(stepId) => {
              stepDialogSceneRef.current = structuredClone(current)
              setStepDialogId(stepId)
            }} onSelectAcceptance={(stepId) => {
              acceptanceDialogSceneRef.current = structuredClone(current)
              setAcceptanceDialogId(stepId)
            }}>
              {/* 版本历史：人在这一侧认出"我调好的那版"并回到它 */}
              <div className="mt-3 border-t border-border/60 pt-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-expanded={versionsOpen}
                    className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      const next = !versionsOpen
                      setVersionsOpen(next)
                      if (next) void loadVersions()
                    }}
                  >
                    {versionsOpen ? '收起版本历史' : '版本历史'}
                  </button>
                  <span className="font-mono text-[10px] text-muted-foreground">当前 v{current.currentVersion}</span>
                </div>
                {versionsOpen ? (
                  <div className="mt-1.5">
                    {versions === null ? (
                      <p className="text-[11px] text-muted-foreground">正在读取版本历史…</p>
                    ) : (
                      <CapabilityFactoryVersionList
                        versions={versions}
                        currentVersion={current.currentVersion}
                        busy={rollbackBusy}
                        onRequestRollback={setPendingRollback}
                      />
                    )}
                  </div>
                ) : null}
              </div>
            </CapabilityFactorySceneDefinition>
          </div>
        )}
      </section>
      )}
      </TabsContent>

      {/* 左「场景」抽屉：默认关闭，不占布局宽度 */}
      <CapabilityFactorySceneRail
        open={railOpen}
        scenes={scenes}
        selectedSceneId={selectedSceneId}
        {...(workspaceLabel ? { workspaceLabel } : {})}
        error={error}
        createBusy={createBusy}
        onRequestCreate={() => { setCreateError(null); setCreateOpen(true) }}
        rename={{
          sceneId: renamingId,
          value: renameValue,
          onChange: setRenameValue,
          onStart: (scene) => { setRenamingId(scene.id); setRenameValue(scene.definition.name) },
          onSubmit: () => { void commitRename() },
          onCancel: () => setRenamingId(null),
        }}
        onSelectScene={selectScene}
        onRequestDelete={setPendingDelete}
        onOpenChange={(open) => { if (!open) closeRail() }}
      />

      {/* 新建场景弹窗：抽屉里的 ＋ 是唯一入口 */}
      <CapabilityFactorySceneDialog
        open={createOpen}
        submitting={createBusy}
        error={createError}
        onOpenChange={(open) => { setCreateOpen(open); if (!open) setCreateError(null) }}
        onSubmit={(value) => { void createScene(value) }}
      />

      {/* 步骤弹窗仅编辑定义；输入、执行与结果统一由运行页承载。 */}
      <CapabilityFactoryStepDialog
        key={`step-dialog:${sessionId}:${stepDialogSceneRef.current?.id ?? ''}:${stepDialogId ?? 'closed'}`}
        open={stepDialogId !== null}
        sessionId={sessionId}
        scene={liveStepDialogScene ?? stepDialogSceneRef.current}
        unavailable={!liveStepDialogScene}
        step={stepDialogSceneRef.current && stepDialogId ? findSceneStep(stepDialogSceneRef.current.definition, stepDialogId)
          ?? (stepDialogSceneRef.current.draft ? findSceneStep(stepDialogSceneRef.current.draft.definition, stepDialogId) : null) : null}
        onOpenChange={(open) => { if (!open) setStepDialogId(null) }}
        onSceneChanged={() => { void refresh() }}
      />

      {/* 评审卡弹窗与步骤弹窗同构：修改后保存草案，再由人决定是否采纳。 */}
      <CapabilityFactoryAcceptanceDialog
        key={`acceptance-dialog:${sessionId}:${acceptanceDialogSceneRef.current?.id ?? ''}:${acceptanceDialogId ?? 'closed'}`}
        open={acceptanceDialogId !== null}
        sessionId={sessionId}
        scene={liveAcceptanceDialogScene ?? acceptanceDialogSceneRef.current}
        unavailable={!liveAcceptanceDialogScene}
        stepId={acceptanceDialogId}
        onOpenChange={(open) => { if (!open) setAcceptanceDialogId(null) }}
        onSceneChanged={() => { void refresh() }}
      />

      {/* 删除是破坏性动作：用仓库既有的 ConfirmDialog，而不是行内二次点击 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null) }}
        title="删除这个编排场景？"
        description={
          pendingDelete
            ? `将删除「${pendingDelete.definition.name}」；它的版本历史会保留在本机（可作为恢复依据），但界面上不再出现。`
            : undefined
        }
        confirmLabel="删除场景"
        onConfirm={confirmDelete}
      />

      {/* 回滚会改掉当前生效定义，所以也走确认框；说明里必须写清"生成新版本、历史不删" */}
      <ConfirmDialog
        open={pendingRollback !== null}
        onOpenChange={(open) => { if (!open) setPendingRollback(null) }}
        title={pendingRollback === null ? '回到旧版本？' : `回到 v${pendingRollback}？`}
        description={pendingRollback === null || !current
          ? undefined
          : describeRollbackEffect(pendingRollback, current.currentVersion)}
        confirmLabel="回滚"
        loading={rollbackBusy}
        onConfirm={confirmRollback}
      />
    </Tabs>
  )
}
