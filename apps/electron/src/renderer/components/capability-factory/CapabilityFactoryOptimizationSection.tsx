/** 当前会话负责提出草案；工厂负责用同一批任务验证、对比，再由人采纳。 */
import * as React from 'react'
import { diffSceneDefinition } from '@proma/shared'
import type { CapabilityRun, CapabilitySavedTask, CapabilityScene } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CapabilityFactoryRunResult } from './CapabilityFactoryRunResult'
import { describeReviewStatus, formatDuration } from './capability-factory-run-view'
import { canAdoptOptimization, compareOptimizationPair, groupOptimizationRuns, isAdoptableOptimizationBatch, isPromptOnlyOptimization, optimizationKey, runOptimizationBatch, sceneStandardsKey, type OptimizationPair } from './capability-factory-optimization'

/** 任务摘要只用于选择，运行始终使用保存的原始内容。 */
function taskLabel(task: Pick<CapabilitySavedTask, 'input'>): string {
  return Object.values(task.input).map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' · ').replace(/\s+/g, ' ').slice(0, 90) || '空输入'
}

/** 对比结果优先展示变化和证据，完整输出按需打开。 */
function PairResult({ pair, onInspect }: { pair: OptimizationPair; onInspect: (run: CapabilityRun) => void }): React.ReactElement {
  /** 候选还未返回时，已保存的基线仍可阅读。 */
  const { baseline, candidate } = pair
  const comparison = candidate ? compareOptimizationPair(baseline, candidate) : null
  return (
    <section className="space-y-2 rounded-md border border-border/60 p-3" aria-label="任务对比结果">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{new Date(baseline.startedAt).toLocaleString('zh-CN', { hour12: false })} · v{baseline.sceneVersion}</span>
        <span className="shrink-0">{comparison?.comparable ? `修复 ${comparison.fixed.length} · 退化 ${comparison.regressed.length}` : candidate ? '暂不能判断' : '候选运行中'}</span>
      </div>
      <p className="break-words text-[11px] leading-5 text-muted-foreground">{taskLabel(baseline)}</p>
      <div className="grid grid-cols-2 gap-3 text-xs">
        {[{ label: '当前版', run: baseline }, { label: '候选草案', run: candidate }].map(({ label, run }) => (
          <div key={label} className="min-w-0 space-y-1">
            <p className="font-medium">{label} <span className="font-normal text-muted-foreground">· {run ? describeReviewStatus(run).label : '尚未运行'}</span></p>
            {run ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-muted-foreground">{formatDuration(run.startedAt, run.finishedAt)}</span><Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => onInspect(run)}>查看详情</Button></div> : null}
          </div>
        ))}
      </div>
      {comparison ? (
        <Collapsible>
          <CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm" className="h-7 px-0 text-[11px]">查看详细对比</Button></CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-1 text-[11px] leading-5">
            {comparison.reasons.map((reason) => <p key={reason} className="text-amber-600 dark:text-amber-400">{reason}</p>)}
            {comparison.fixed.map((criterion) => <p key={`fixed:${criterion}`} className="text-emerald-600 dark:text-emerald-400">已修复：{criterion}</p>)}
            {comparison.regressed.map((criterion) => <p key={`regressed:${criterion}`} className="text-destructive">新增问题：{criterion}</p>)}
            {comparison.unknown.map((criterion) => <p key={`unknown:${criterion}`} className="text-amber-600 dark:text-amber-400">无法判断：{criterion}</p>)}
            {comparison.comparable && !comparison.fixed.length && !comparison.regressed.length && !comparison.unknown.length ? <p className="text-muted-foreground">明确判据没有变化，不能据此宣称提升。</p> : null}
            <div className="border-t border-border/50 pt-2">
              {baseline.review?.criteria.map((criterion) => {
                /** 按同一判据匹配候选证据，不凭列表下标错配。 */
                const after = candidate?.review?.criteria.find((item) => item.criterion === criterion.criterion)
                return <div key={criterion.criterion} className="space-y-0.5"><p>{criterion.criterion}</p><p className="text-muted-foreground">当前版：{criterion.evidence}</p><p className="text-muted-foreground">候选：{after?.evidence ?? '缺少证据'}</p></div>
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  )
}

/** 仅打开优化页时读取任务与对比历史，避免运行首屏搬运多份长正文。 */
export function CapabilityFactoryOptimizationSection({ sessionId, scene, onSceneChanged }: {
  sessionId: string; scene: CapabilityScene; onSceneChanged?: () => Promise<void>
}): React.ReactElement {
  /** 已保存任务和当前勾选项，默认最近一条，可按需多选。 */
  const [tasks, setTasks] = React.useState<CapabilitySavedTask[] | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])
  /** 显式配对记录可由历史恢复，不猜测两个任意运行的关联。 */
  const [pairs, setPairs] = React.useState<OptimizationPair[]>([])
  /** 只有当前页面完成的整批对比才可采纳，历史结果用于阅读而不自动背书。 */
  const [completedBatchIds, setCompletedBatchIds] = React.useState<string[] | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [retry, setRetry] = React.useState(0)
  const [inspected, setInspected] = React.useState<CapabilityRun | null>(null)
  /** 页面离开后不再排下一次模型调用，已发出的结果仍由后端保存。 */
  const active = React.useRef(true)
  const operationLock = React.useRef(false)
  React.useEffect(() => {
    active.current = true
    /** 独立读请求取消标记，防重试后的旧回执覆盖新列表。 */
    let cancelled = false
    void Promise.all([
      window.electronAPI.capabilityFactory.invoke('listTasks', { sessionId, sceneId: scene.id }),
      window.electronAPI.capabilityFactory.invoke('listRuns', { sessionId, sceneId: scene.id, kind: 'full', limit: 20 }),
    ]).then(([saved, history]) => {
      if (cancelled || !active.current) return
      setTasks(saved); setSelected(saved[0] ? [saved[0].id] : []); setPairs(groupOptimizationRuns(history)); setCompletedBatchIds(null); setError(null)
    }).catch((cause: unknown) => { if (!cancelled && active.current) { setTasks([]); setError(cause instanceof Error ? cause.message : String(cause)) } })
    return () => { cancelled = true; active.current = false }
  }, [sessionId, scene.id, retry])

  /** 当前草案改动摘要；标准变化独立提示，不能靠更宽松口径获取提升。 */
  const draft = scene.draft
  const changes = draft ? diffSceneDefinition(scene.definition, draft.definition) : []
  const standardsChanged = Boolean(draft && sceneStandardsKey(scene) !== optimizationKey(draft.definition.stepAcceptances ?? draft.definition.acceptance))
  /** 模型或参数变化单独实验，不先花费一次基线调用再拒绝候选。 */
  const modelsChanged = Boolean(draft && optimizationKey(scene.definition.modelSlots) !== optimizationKey(draft.definition.modelSlots))
  /** 结构变化需要走流程设计验证，不能混进提示词对比。 */
  const promptOnly = Boolean(draft && isPromptOnlyOptimization(scene.definition, draft.definition))
  /** 只有当前页面刚完成的整批任务都通过，才提供就地采纳；一条好结果不能掩盖同批失败。 */
  const completedPairs = completedBatchIds
    ? pairs.filter((pair) => completedBatchIds.includes(pair.id))
    : []
  const batchComparisons = completedPairs.flatMap((pair) => pair.candidate
    ? [compareOptimizationPair(pair.baseline, pair.candidate)] : [])
  const batchCandidatesMatch = completedPairs.length > 0
    && completedPairs.length === completedBatchIds?.length
    && completedPairs.every((pair) => pair.candidate && canAdoptOptimization(pair.candidate, scene))
  const adoptable = batchCandidatesMatch && isAdoptableOptimizationBatch(batchComparisons)
    ? completedPairs.find((pair) => pair.candidate)?.candidate
    : undefined

  /** 冻结点击时的版本及任务，按两版顺序试跑；不自动修改或采纳。 */
  const start = async (): Promise<void> => {
    if (operationLock.current) return
    operationLock.current = true; setBusy(true); setError(null); setCompletedBatchIds(null)
    const comparisonIds = new Set<string>()
    try {
      await runOptimizationBatch({ api: window.electronAPI.capabilityFactory, sessionId, scene,
        tasks: (tasks ?? []).filter((task) => selected.includes(task.id)), isActive: () => active.current,
        onPair: (pair) => {
          comparisonIds.add(pair.id)
          setPairs((previous) => [pair, ...previous.filter((item) => item.id !== pair.id)])
        },
      })
      if (active.current) setCompletedBatchIds([...comparisonIds])
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { operationLock.current = false; if (active.current) setBusy(false) }
  }

  /** 采纳仅由点击发起；将被测试快照送后端复核，防新草案冒用旧结果。 */
  const adopt = async (): Promise<void> => {
    if (!adoptable || operationLock.current) return
    operationLock.current = true; setBusy(true); setError(null)
    try {
      await window.electronAPI.capabilityFactory.invoke('adoptDraft', { sessionId, sceneId: scene.id,
        expectedVersion: scene.currentVersion, expectedDraftCreatedAt: adoptable.draftCreatedAt,
        expectedDraftDefinition: adoptable.definitionSnapshot,
      })
      if (active.current) await onSceneChanged?.()
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { operationLock.current = false; if (active.current) setBusy(false) }
  }

  return (
    <div className="space-y-3" aria-label="优化对比">
      <p className="rounded-md bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">用相同测试输入运行当前版和候选草案，确认提示词是否变好。</p>
      {draft ? (
        <section className="space-y-2 rounded-md border border-border/60 p-3" aria-label="候选草案">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><div><p className="text-xs font-medium">候选草案</p><p className="text-[11px] text-muted-foreground">当前 v{scene.currentVersion} · {changes.length} 项改动 · 尚未生效</p></div><span className="text-[11px] text-muted-foreground">先验证，再采纳</span></div>
          {draft.note ? <p className="break-words text-[11px] leading-5 text-muted-foreground">{draft.note}</p> : null}
          <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm" className="h-7 px-0 text-[11px]">查看改动详情</Button></CollapsibleTrigger>
            <CollapsibleContent className="pt-1"><ul className="space-y-1 text-[11px] leading-5 text-muted-foreground">{changes.map((change) => <li key={`${change.kind}:${change.detail}`}>{change.detail}</li>)}</ul></CollapsibleContent>
          </Collapsible>
          {standardsChanged ? <p role="alert" className="text-xs leading-6 text-amber-600 dark:text-amber-400">草案修改了评审标准，暂不作为提示词优化比较。请先单独确认标准，再重新验证两版。</p> : null}
          {modelsChanged ? <p role="alert" className="text-xs leading-6 text-amber-600 dark:text-amber-400">草案修改了模型配置，请保持两版模型配置一致后再比较提示词效果。</p> : null}
          {draft && !promptOnly && !standardsChanged && !modelsChanged ? <p role="alert" className="text-xs leading-6 text-amber-600 dark:text-amber-400">草案修改了流程或输入输出契约，不能作为提示词优化比较；请先完成流程设计验证。</p> : null}
        </section>
      ) : <section className="rounded-md border border-dashed border-border/70 px-3 py-4" aria-label="暂无候选草案"><p className="text-xs font-medium">还没有候选草案</p><p className="mt-1 text-[11px] leading-5 text-muted-foreground">在当前会话让 Agent 根据这轮结果提出提示词草案，保存后会出现在这里。</p></section>}
      {error ? <div role="alert" className="space-y-2 text-xs text-destructive"><p>{error}</p><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setRetry((value) => value + 1)}>重新读取</Button></div> : null}
      {tasks === null ? <p className="text-xs text-muted-foreground">正在读取保存任务…</p> : tasks.length === 0 ? <p className="text-xs text-muted-foreground">暂无保存任务，先在本轮提交一份测试内容。</p> : (
        <section className="space-y-2 rounded-md border border-border/60 p-3" aria-label="对比任务">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-xs font-medium">测试输入</p><span className="text-[11px] text-muted-foreground">已选 {selected.length} / {Math.min(tasks.length, 10)}</span></div>
          <p className="text-[11px] leading-5 text-muted-foreground">选择要重复验证的已保存任务；每条任务会分别运行当前版和候选版。</p>
          <div className="max-h-36 space-y-1 overflow-y-auto">
            {tasks.map((task) => <label key={task.id} className="flex items-start gap-2 rounded-sm px-1 py-1.5 text-[11px] leading-5 hover:bg-muted/40">
              <input type="checkbox" className="mt-1 accent-primary" checked={selected.includes(task.id)} disabled={busy || (!selected.includes(task.id) && selected.length >= 10)} onChange={(event) => {
                setCompletedBatchIds(null)
                setSelected((previous) => event.target.checked ? [...previous, task.id] : previous.filter((id) => id !== task.id))
              }} />
              <span className="min-w-0 break-words">{taskLabel(task)}</span>
            </label>)}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2"><span className="text-[10px] leading-4 text-muted-foreground">最多 10 条，会调用模型并自动评审。</span><Button type="button" size="sm" disabled={busy || !draft || standardsChanged || modelsChanged || !promptOnly || !selected.length} onClick={() => { void start() }}>{busy ? '对比中…' : '开始对比'}</Button></div>
        </section>
      )}
      <section className="space-y-2" aria-label="对比结果">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-medium">对比结果</p>{adoptable ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { void adopt() }}>采纳已测试草案</Button> : null}</div>
        {adoptable ? <p className="text-[11px] leading-5 text-muted-foreground">当前草案已通过选定任务的对比；采纳前仍请检查各条结果。</p> : null}
        {pairs.length ? <div className="space-y-2">{pairs.map((pair) => <PairResult key={pair.id} pair={pair} onInspect={setInspected} />)}</div> : <p className="rounded-md border border-dashed border-border/70 px-3 py-4 text-[11px] text-muted-foreground">尚无对比结果。选择测试输入后开始对比。</p>}
      </section>
      <Dialog open={inspected !== null} onOpenChange={(open) => { if (!open) setInspected(null) }}>
        <DialogContent className="flex h-[min(820px,calc(100dvh-32px))] w-[calc(100vw-32px)] max-w-4xl min-w-0 flex-col" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{inspected?.definitionTarget === 'draft' ? '候选草案运行详情' : '当前版运行详情'}</DialogTitle></DialogHeader>
          {inspected ? <CapabilityFactoryRunResult run={inspected} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
