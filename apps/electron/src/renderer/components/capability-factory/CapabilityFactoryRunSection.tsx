/**
 * 「运行」这一整段：提交任务 → 看轨迹与输出 → 查看优化与批量测试 → 绑虚拟接入。
 *
 * 为什么运行放在主进程而不是渲染层：模型调用要用渠道凭据、走系统代理，
 * 这些只能在主进程发生。面板这一侧只发起、等待、呈现。
 */
import * as React from 'react'
import { ChevronDown, LoaderCircle, Play } from 'lucide-react'
import type {
  CapabilityFactoryApi, CapabilityFactoryCommandInputs, CapabilityRun, CapabilityScene,
  CapabilitySavedTask, CapabilityStub, CapabilityStubSource,
} from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { CapabilityFactoryRunResult } from './CapabilityFactoryRunResult'
import { CapabilityFactoryStubSection } from './CapabilityFactoryStubSection'
import { CapabilityFactorySubmitDialog } from './CapabilityFactorySubmitDialog'
import { CapabilityFactoryEvaluationSection } from './CapabilityFactoryEvaluationSection'
import { CapabilityFactoryOptimizationSection } from './CapabilityFactoryOptimizationSection'

/** 从任意异常里取出可读文本。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 首个步骤进度事件抵达前的过渡态；不伪造完成，只说明正在建立运行轨迹。 */
function CapabilityFactoryRunStarting({ scene }: { scene: CapabilityScene }): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-md border border-border/70 p-3" aria-label="运行中">
      <div className="flex items-center gap-2 text-xs">
        <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none text-primary" aria-hidden="true" />
        <span className="font-medium">正在启动运行</span>
        <span className="text-muted-foreground">等待第一个步骤回传执行状态…</span>
      </div>
      <ol className="space-y-1.5 text-xs text-muted-foreground">
        {scene.definition.steps.map((step, index) => (
          <li key={`${step.id}:${index}`} className="flex items-center gap-2 rounded-sm px-2 py-1.5">
            <span className="w-3 text-center font-mono text-[10px]">{index + 1}</span>
            <span>{step.title}</span>
            <span className="ml-auto text-[10px]">等待</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** 只有运行类命令会产生请求级进度。 */
type CapabilityFactoryRunMethod = 'runScene' | 'runStep'

/**
 * 发起一次可观察运行：先订阅、再 invoke，终态或异常都会清理订阅。
 *
 * @param api 编排工厂 preload API
 * @param method 整链运行或单步试跑
 * @param input 不含 requestId 的业务输入
 * @param onProgress 本请求的中间运行记录
 * @returns 评审完成后的终态记录
 */
export async function invokeCapabilityFactoryRunWithProgress<M extends CapabilityFactoryRunMethod>(
  api: CapabilityFactoryApi,
  method: M,
  input: CapabilityFactoryCommandInputs[M],
  onProgress: (run: CapabilityRun) => void,
): Promise<CapabilityRun> {
  const requestId = crypto.randomUUID()
  const unsubscribe = api.onRunProgress?.((event) => {
    if (event.requestId === requestId) onProgress(event.run)
  })
  try {
    return await api.invoke(method, { ...input, requestId } as CapabilityFactoryCommandInputs[M])
  } finally {
    unsubscribe?.()
  }
}

/**
 * 合并运行列表，前一组是更新鲜的事实，同 id 时不被迟到历史覆盖。
 *
 * @param preferred 当前进度或终态
 * @param history 磁盘历史
 * @returns 去重后的新列表
 */
export function mergeCapabilityFactoryRuns(
  preferred: readonly CapabilityRun[],
  history: readonly CapabilityRun[],
): CapabilityRun[] {
  return [...preferred, ...history.filter((run) => !preferred.some((current) => current.id === run.id))]
}

/** 运行区属性。 */
export interface CapabilityFactoryRunSectionProps {
  sessionId: string
  scene: CapabilityScene
  /** 采纳候选后更新外层场景与版本。 */
  onSceneChanged?: () => Promise<void>
  /** 顶层历史菜单选中的记录；运行页收到后直接展示对应结果。 */
  historySelectionId?: string | null
}

/** 运行页分开呈现当前结果、候选对比与批量测试；历史由顶层下拉进入。 */
type RunSectionTab = 'current' | 'optimize' | 'batch'

/**
 * 渲染运行区。
 *
 * @param props 会话与当前场景
 * @returns 提交入口、本次结果、优化与批量测试、虚拟接入
 */
export function CapabilityFactoryRunSection({ sessionId, scene, onSceneChanged, historySelectionId = null }: CapabilityFactoryRunSectionProps): React.ReactElement {
  const [runs, setRuns] = React.useState<CapabilityRun[] | null>(null)
  const [stubs, setStubs] = React.useState<CapabilityStub[] | null>(null)
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)
  /** 当前页签；历史记录从顶层进入后直接回到本轮结果。 */
  const [activeTab, setActiveTab] = React.useState<RunSectionTab>('current')
  const [submitOpen, setSubmitOpen] = React.useState(false)
  /** 仅在打开提交弹窗时读取任务，避免初始结果页多读一份正文。 */
  const [savedTasks, setSavedTasks] = React.useState<CapabilitySavedTask[] | null>(null)
  const [tasksError, setTasksError] = React.useState<string | null>(null)
  /** 读取失败时的显式重试序号；不自动轮询。 */
  const [tasksRetry, setTasksRetry] = React.useState(0)
  const [running, setRunning] = React.useState(false)
  /** 同步锁防止重复提交，也避免迟到历史在启动阶段选回上一轮。 */
  const runInFlightRef = React.useRef(false)
  const [error, setError] = React.useState<string | null>(null)
  const [stubBusy, setStubBusy] = React.useState(false)
  const [stubError, setStubError] = React.useState<string | null>(null)
  /** 虚拟接入默认收起，需要测试外部能力时再展开。 */
  const [stubSectionOpen, setStubSectionOpen] = React.useState(false)
  /** 长请求回来时复核场景，避免旧闭包覆盖新 scope。 */
  const currentSceneIdRef = React.useRef(scene.id)
  currentSceneIdRef.current = scene.id

  /** 拉取这个场景的运行历史与当前桩表；失败时把原因显示出来，不静默空着。 */
  const refresh = React.useCallback(async () => {
    try {
      const [history, stubList] = await Promise.all([
        /** 统一读取整链与单步记录，步骤弹窗不再承载历史入口。 */
        window.electronAPI.capabilityFactory.invoke('listRuns', {
          sessionId, sceneId: scene.id, limit: 20,
        }),
        window.electronAPI.capabilityFactory.invoke('listStubs', { sessionId }),
      ])
      /** 历史读取可能晚于本轮进度；迟到结果只补充，不覆盖。 */
      setRuns((previous) => previous === null ? history : mergeCapabilityFactoryRuns(previous, history))
      setStubs(stubList)
      setSelectedRunId((current) => {
        if (current || runInFlightRef.current) return current
        return history[0]?.id ?? null
      })
    } catch (cause) {
      setError(errorText(cause))
      setRuns([])
      setStubs(null)
    }
  }, [scene.id, sessionId])

  React.useEffect(() => { void refresh() }, [refresh])

  React.useEffect(() => {
    if (!historySelectionId) return
    setSelectedRunId(historySelectionId)
    setActiveTab('current')
  }, [historySelectionId])

  React.useEffect(() => {
    if (!submitOpen) return
    /** 关闭、切换场景或会话之后，丢弃旧任务清单。 */
    let active = true
    setSavedTasks(null)
    setTasksError(null)
    void window.electronAPI.capabilityFactory.invoke('listTasks', { sessionId, sceneId: scene.id })
      .then((tasks) => { if (active) setSavedTasks(tasks) })
      .catch((cause: unknown) => { if (active) setTasksError(`读取已保存任务失败：${errorText(cause)}`) })
    return () => { active = false }
  }, [submitOpen, scene.id, sessionId, tasksRetry])

  /** 提交一次运行：先退出输入弹窗，再锁住运行区并开始执行。 */
  const submit = React.useCallback(async (input: Record<string, unknown>) => {
    if (runInFlightRef.current) return
    runInFlightRef.current = true
    /** 只移除本请求的临时快照，通信异常不伪造后端最终结果。 */
    let progressRunId: string | null = null
    const targetSceneId = scene.id
    const isCurrentScene = (): boolean => currentSceneIdRef.current === targetSceneId
    setRunning(true)
    setError(null)
    /** 输入已经通过弹窗校验；先关闭弹窗，运行过程交给当前页展示。 */
    setSubmitOpen(false)
    setActiveTab('current')
    /** 清掉上一轮选中项，避免新一轮开始时继续显示旧输出。 */
    setSelectedRunId(null)
    try {
      const run = await invokeCapabilityFactoryRunWithProgress(window.electronAPI.capabilityFactory, 'runScene', {
        sessionId, sceneId: scene.id, input,
      }, (progress) => {
        if (!isCurrentScene()) return
        progressRunId = progress.id
        setRuns((previous) => mergeCapabilityFactoryRuns([progress], previous ?? []))
        setSelectedRunId(progress.id)
        setActiveTab('current')
      })
      if (!isCurrentScene()) return
      setRuns((previous) => mergeCapabilityFactoryRuns([run], previous ?? []))
      setSelectedRunId(run.id)
      setActiveTab('current')
      setError(null)
    } catch (cause) {
      /** 弹窗已经关闭，失败原因直接显示在运行页；任务已保存，可再次打开复用。 */
      if (isCurrentScene()) {
        setError(`未能取得本轮最终结果：${errorText(cause)}。可在历史中核对已保存的记录。`)
        setRuns((previous) => previous?.filter((item) => item.id !== progressRunId) ?? [])
        setSelectedRunId(null)
      }
    } finally {
      runInFlightRef.current = false
      setRunning(false)
    }
  }, [scene.id, sessionId])

  /** 保存 / 清空桩：桩是本地装置，改完立刻重拉（运行记录里能看到用的是哪份桩的回显）。 */
  const saveStub = React.useCallback(async (
    capabilityId: string,
    payload: unknown,
    source: CapabilityStubSource,
  ) => {
    if (stubBusy) return
    setStubBusy(true)
    try {
      /** 'agent' 由 Agent 那侧写；界面这一侧只会传 placeholder / human。 */
      await window.electronAPI.capabilityFactory.invoke('setStub', { sessionId, capabilityId, payload, source })
      setStubError(null)
      await refresh()
    } catch (cause) {
      setStubError(errorText(cause))
    } finally {
      setStubBusy(false)
    }
  }, [refresh, sessionId, stubBusy])

  const deleteStub = React.useCallback(async (capabilityId: string) => {
    if (stubBusy) return
    setStubBusy(true)
    try {
      await window.electronAPI.capabilityFactory.invoke('deleteStub', { sessionId, capabilityId })
      setStubError(null)
      await refresh()
    } catch (cause) {
      setStubError(errorText(cause))
    } finally {
      setStubBusy(false)
    }
  }, [refresh, sessionId, stubBusy])

  /** 当前选中的运行。 */
  const selected = runs?.find((run) => run.id === selectedRunId) ?? null
  /** 当前场景声明的能力 id。 */
  const sceneCapabilityIds = new Set(scene.definition.capabilities.map((capability) => capability.id))
  /** 只保留当前场景用得到的桩，避免其他场景干扰统计和编辑。 */
  const sceneStubs = (stubs ?? []).filter((stub) => sceneCapabilityIds.has(stub.capabilityId))
  /** 当前场景已绑定的能力 id。 */
  const bound = new Set(sceneStubs.map((stub) => stub.capabilityId))
  /** 桩数据是否已加载，加载前不显示误导性的缺失数量。 */
  const stubsLoaded = stubs !== null
  /** 当前场景缺失的能力数量。 */
  const unboundCount = scene.definition.capabilities.filter((item) => !bound.has(item.id)).length
  /** 当前场景使用占位桩的能力数量。 */
  const placeholderCount = sceneStubs.filter((stub) => stub.source === 'placeholder').length

  /** 打开输入弹窗开始新一轮运行；输入仍在弹窗内提交并自动保存。 */
  const openSubmitDialog = React.useCallback(() => {
    setError(null)
    setSavedTasks(null)
    setTasksError(null)
    setSubmitOpen(true)
  }, [])
  /** 运行结果状态行右侧的主操作；没有结果时复用到本轮与历史内容区顶部。 */
  const startRunButton = (
    <Button type="button" size="sm" disabled={running} onClick={openSubmitDialog}>
      <Play className="size-3.5" aria-hidden="true" />
      开始运行
    </Button>
  )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {/* 三种"跑之前就该知道"的状态：没步骤、缺桩、用占位桩 */}
      {!running && scene.definition.steps.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">这个场景还没有步骤，跑起来会是空的。</p>
      ) : null}
      {!running && stubsLoaded && unboundCount > 0 ? (
        <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          还有 {unboundCount} 个能力没绑桩：依赖它们的步骤会明确失败（在下面的「虚拟接入」里绑）。
        </p>
      ) : null}
      {!running && stubsLoaded && placeholderCount > 0 ? (
        <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          有 {placeholderCount} 个占位桩：跑出来的过程可以看，质量结论不能看。
        </p>
      ) : null}

      {error && !submitOpen ? (
        <p role="alert" className="rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
          {error}
        </p>
      ) : null}

      <Tabs value={activeTab} onValueChange={(value) => {
        setActiveTab(value as RunSectionTab)
        if (value === 'current') void refresh()
      }} className="flex min-h-64 min-w-0 flex-1 flex-col">
        <TabsList className="h-8 w-full shrink-0 justify-start gap-1 rounded-none border-b border-border/60 bg-transparent p-0" aria-label="运行记录视图">
          <TabsTrigger value="current" className="h-8 rounded-none border-b-2 border-transparent px-2.5 text-xs shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">
            本轮
          </TabsTrigger>
          <TabsTrigger value="optimize" disabled={running} className="h-8 rounded-none border-b-2 border-transparent px-2 text-xs shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">优化对比</TabsTrigger>
          <TabsTrigger value="batch" disabled={running} className="h-8 rounded-none border-b-2 border-transparent px-2 text-xs shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">批量测试</TabsTrigger>
        </TabsList>

        <TabsContent value="current" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          {selected ? (
            <section aria-label="运行结果" className="flex min-h-0 min-w-0 flex-1 flex-col">
              {selected.kind === 'step' ? <p className="mb-2 text-[11px] text-muted-foreground">单步记录 · {selected.steps.find((step) => step.stepId === selected.stepId)?.title ?? selected.stepId}</p> : null}
              <CapabilityFactoryRunResult
                run={selected}
                actions={startRunButton}
                optimizationContext={{ sessionId, sceneName: scene.definition.name }}
              />
            </section>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              {running ? <CapabilityFactoryRunStarting scene={scene} /> : <div className="flex min-h-8 shrink-0 justify-end">{startRunButton}</div>}
              {running ? null : runs === null ? <p className="text-[11px] text-muted-foreground">正在读取运行记录…</p> : <p className="text-[11px] leading-relaxed text-muted-foreground">
                暂无运行结果。点击“开始运行”提交一份测试内容后，这里会显示输出与约束结论。
              </p>}
            </div>
          )}
        </TabsContent>

        <TabsContent value="optimize" className="mt-3 min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
          <CapabilityFactoryOptimizationSection sessionId={sessionId} scene={scene} onSceneChanged={onSceneChanged} />
        </TabsContent>
        <TabsContent value="batch" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <CapabilityFactoryEvaluationSection sessionId={sessionId} scene={scene} />
        </TabsContent>
      </Tabs>

      {scene.definition.capabilities.length > 0 ? (
        <Collapsible open={stubSectionOpen} onOpenChange={setStubSectionOpen}>
          <section className="border-t border-border/60 pt-2" aria-label="虚拟接入">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="h-7 w-full justify-between px-1.5 text-[11px] text-muted-foreground">
                <span>
                  虚拟接入
                  {stubsLoaded ? ` · 已绑 ${bound.size}/${scene.definition.capabilities.length}` : ' · 正在读取'}
                  {stubsLoaded && unboundCount > 0 ? `，缺 ${unboundCount}` : ''}
                  {stubsLoaded && placeholderCount > 0 ? `，占位 ${placeholderCount}` : ''}
                </span>
                <ChevronDown className={cn('size-3.5 transition-transform', stubSectionOpen && 'rotate-180')} aria-hidden="true" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <CapabilityFactoryStubSection
                definition={scene.definition}
                stubs={sceneStubs}
                busy={stubBusy}
                error={stubError}
                onSave={(capabilityId, payload, source) => { void saveStub(capabilityId, payload, source) }}
                onDelete={(capabilityId) => { void deleteStub(capabilityId) }}
              />
            </CollapsibleContent>
          </section>
        </Collapsible>
      ) : null}

      <CapabilityFactorySubmitDialog
        open={submitOpen}
        definition={scene.definition}
        submitting={running}
        error={error}
        savedTasks={savedTasks}
        tasksError={tasksError}
        onRetryTasks={() => setTasksRetry((previous) => previous + 1)}
        onOpenChange={(open) => { setSubmitOpen(open); if (!open) setError(null) }}
        onSubmit={(input) => { void submit(input) }}
      />
    </div>
  )
}
