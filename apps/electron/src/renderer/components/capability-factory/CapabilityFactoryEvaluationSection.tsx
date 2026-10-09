/**
 * 运行中的「批量测试」：数据集 → 自动运行与评审 → 逐条结果 → 历史对比。
 *
 * 三条刻意的设计：
 * ① **数据集是前置，必须先有**：没有固定输入集，"评测"就只是把上次那段正文再跑一遍。
 *    所以这里第一件事是"把一次真实运行的输入固化成用例"（失败用例回灌的入口也在这里）。
 * ② **分数永远带上 (场景版本, 数据集版本)**：用例改了、场景改了都不能和旧分直接比，
 *    界面在对比时会把不可比的情况明说出来。
 * ③ **约束与质量分开**：格式合法不代表内容达标，质量依赖每轮自动评审及证据；
 *    未评审或评审失败不能算通过，不编造综合质量分。
 */
import * as React from 'react'
import { LoaderCircle, Play, Plus, Trash2 } from 'lucide-react'
import type {
  CapabilityDataset, CapabilityEvaluation, CapabilityRun, CapabilityScene,
} from '@proma/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CapabilityFactoryRunResult } from './CapabilityFactoryRunResult'
import { useCapabilityFactoryBatches } from './useCapabilityFactoryBatches'
import { CapabilityFactoryBatchHistory } from './CapabilityFactoryBatchHistory'
import { describeReviewStatus } from './capability-factory-run-view'
import {
  describeCompliance, describeEvaluationComparison, describeJudgeResult, describeQuality,
  suggestedDatasetName,
} from './capability-factory-evaluation-view'

/** 从任意异常里取出可读文本。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 评测区属性。 */
export interface CapabilityFactoryEvaluationSectionProps {
  sessionId: string
  scene: CapabilityScene
}

/**
 * 渲染评测区。
 *
 * @param props 会话与当前场景
 * @returns 数据集管理、跑评测与评测历史
 */
export function CapabilityFactoryEvaluationSection({
  sessionId, scene,
}: CapabilityFactoryEvaluationSectionProps): React.ReactElement {
  const [datasets, setDatasets] = React.useState<CapabilityDataset[] | null>(null)
  const [evaluations, setEvaluations] = React.useState<CapabilityEvaluation[] | null>(null)
  const [lastRun, setLastRun] = React.useState<CapabilityRun | null>(null)
  const [selectedDatasetId, setSelectedDatasetId] = React.useState<string | null>(null)
  /** 数据集容量不限，每批显式选择最多十条，避免大数据集只能删用例才能继续测试。 */
  const [selectedCaseIds, setSelectedCaseIds] = React.useState<string[]>([])
  const caseDataset = React.useRef<string | null>(null)
  const [newDatasetName, setNewDatasetName] = React.useState(() => suggestedDatasetName(scene.definition.name))
  const [busy, setBusy] = React.useState<'idle' | 'evaluating' | 'dataset'>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [latest, setLatest] = React.useState<CapabilityEvaluation | null>(null)
  /** Agent 与界面共用持久批次；完整证据按需查看。 */
  const batchState = useCapabilityFactoryBatches(sessionId, scene.id, 'evaluation')
  const [inspected, setInspected] = React.useState<CapabilityRun | null>(null)
  const controlsBusy = busy !== 'idle' || batchState.busy
  /** 会话/场景切换与卸载都会使旧读取失效。 */
  const scope = React.useMemo(() => ({}), [sessionId, scene.id])
  const currentScope = React.useRef<object | null>(scope)
  currentScope.current = scope
  const refreshGeneration = React.useRef(0)

  /** 拉取数据集、评测历史与最近一次整链运行（回灌用）。 */
  const refresh = React.useCallback(async () => {
    if (currentScope.current !== scope) return
    const ticket = ++refreshGeneration.current
    try {
      const [datasetList, history, runs] = await Promise.all([
        window.electronAPI.capabilityFactory.invoke('listDatasets', { sessionId }),
        window.electronAPI.capabilityFactory.invoke('listEvaluations', { sessionId, sceneId: scene.id, limit: 20 }),
        window.electronAPI.capabilityFactory.invoke('listRuns', {
          sessionId, sceneId: scene.id, kind: 'full', limit: 1,
        }),
      ])
      if (currentScope.current !== scope || ticket !== refreshGeneration.current) return
      setDatasets(datasetList)
      setEvaluations(history)
      setLatest(history[0] ?? null)
      setLastRun(runs[0] ?? null)
      setSelectedDatasetId((current) => {
        if (current && datasetList.some((dataset) => dataset.id === current)) return current
        return datasetList[0]?.id ?? null
      })
    } catch (cause) {
      if (currentScope.current !== scope || ticket !== refreshGeneration.current) return
      setError(errorText(cause))
      setDatasets([])
      setEvaluations([])
    }
  }, [scene.id, sessionId, scope])

  React.useEffect(() => {
    currentScope.current = scope
    void refresh()
    /** 同一运行的密集进度合并为一次数据读取。 */
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.electronAPI.capabilityFactory.onChanged?.((event) => {
      if (event.sessionId !== sessionId || (event.sceneId && event.sceneId !== scene.id)) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { void refresh() }, 80)
    })
    return () => { currentScope.current = null; refreshGeneration.current += 1; if (timer !== undefined) clearTimeout(timer); unsubscribe?.() }
  }, [refresh, sessionId, scene.id, scope])

  const selectedDataset = datasets?.find((dataset) => dataset.id === selectedDatasetId) ?? null
  /** 用稳定的 ID 序列触发选择同步，后台评审事件不重置用户勾选。 */
  const availableCaseIds = JSON.stringify(selectedDataset?.cases.map((item) => item.id) ?? [])
  React.useEffect(() => {
    const ids = JSON.parse(availableCaseIds) as string[]
    const changedDataset = caseDataset.current !== selectedDatasetId
    caseDataset.current = selectedDatasetId
    setSelectedCaseIds((previous) => changedDataset
      ? ids.slice(0, 10) : previous.filter((id) => ids.includes(id)))
  }, [selectedDatasetId, availableCaseIds])

  /** 新建数据集：评测必须有地方放用例，所以第一步就是它。 */
  const createDataset = React.useCallback(async () => {
    const name = newDatasetName.trim()
    if (name.length === 0 || controlsBusy) return
    setBusy('dataset')
    try {
      const created = await window.electronAPI.capabilityFactory.invoke('createDataset', { sessionId, name })
      setSelectedDatasetId(created.id)
      setError(null)
      await refresh()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('idle')
    }
  }, [controlsBusy, newDatasetName, refresh, sessionId])

  /** 把最近一次真实运行的输入固化成用例 —— 这是"失败回灌"的最小形态。 */
  const addCaseFromLastRun = React.useCallback(async () => {
    if (!selectedDataset || !lastRun || controlsBusy) return
    setBusy('dataset')
    try {
      await window.electronAPI.capabilityFactory.invoke('addCase', {
        sessionId, datasetId: selectedDataset.id, input: lastRun.input,
        name: `来自运行 ${new Date(lastRun.startedAt).toLocaleString('zh-CN', { hour12: false })}`,
        fromRunId: lastRun.id,
      })
      setError(null)
      await refresh()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('idle')
    }
  }, [controlsBusy, lastRun, refresh, selectedDataset, sessionId])

  const deleteCase = React.useCallback(async (caseId: string) => {
    if (!selectedDataset || controlsBusy) return
    setBusy('dataset')
    try {
      await window.electronAPI.capabilityFactory.invoke('deleteCase', {
        sessionId, datasetId: selectedDataset.id, caseId,
      })
      setError(null)
      await refresh()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('idle')
    }
  }, [controlsBusy, refresh, selectedDataset, sessionId])

  /** 批测与 Agent 共用入口，每条运行和评审都进入可恢复批次。 */
  const runEvaluation = async (): Promise<void> => {
    if (!selectedDataset || selectedCaseIds.length === 0 || controlsBusy) return
    await batchState.start({ datasetId: selectedDataset.id, caseIds: selectedCaseIds, expectedVersion: scene.currentVersion })
  }

  /** 上一条同数据集的评测：对比只在同一份用例集上做。 */
  const previousSameDataset = (evaluations ?? []).find((item) =>
    item.id !== latest?.id && item.datasetId === latest?.datasetId) ?? null

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <section className="space-y-2" aria-label="数据集">
        <div className="text-[11px] font-medium text-muted-foreground">数据集</div>
        {datasets === null ? (
          <p className="text-[11px] text-muted-foreground">正在读取数据集…</p>
        ) : datasets.length === 0 ? (
          <div className="space-y-2">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              还没有数据集。评测需要一组固定输入，否则只能把上次那段正文再跑一遍，和「再提交一次」没区别。
            </p>
            <div className="flex items-center gap-1.5">
              <Input
                value={newDatasetName} disabled={controlsBusy}
                aria-label="新数据集名称"
                className="h-8 text-[11px]"
                onChange={(event) => setNewDatasetName(event.target.value)}
              />
              <Button type="button" size="sm" disabled={controlsBusy || newDatasetName.trim().length === 0} onClick={() => { void createDataset() }}>
                <Plus className="size-3.5" aria-hidden="true" />
                新建
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                value={selectedDatasetId ?? ''}
                aria-label="选择数据集"
                className="h-8 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-[11px]"
                onChange={(event) => setSelectedDatasetId(event.target.value)}
              >
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name}（v{dataset.version} · {dataset.cases.length} 条）
                  </option>
                ))}
              </select>
              <Button
                type="button" size="sm" variant="outline"
                disabled={controlsBusy || !lastRun}
                title={lastRun ? '把最近一次运行的输入固化成用例' : '还没有跑过整链运行'}
                onClick={() => { void addCaseFromLastRun() }}
              >
                从最近一次运行固化
              </Button>
            </div>

            {selectedDataset ? (
              <ul className="space-y-1" data-capability-factory-cases>
                {selectedDataset.cases.length === 0 ? (
                  <li className="text-[11px] leading-relaxed text-muted-foreground">
                    这个数据集还没有用例：先去「运行」页跑一条真实输入，再回来点「从最近一次运行固化」。
                  </li>
                ) : null}
                {selectedDataset.cases.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 rounded-sm border border-border/70 px-2 py-1.5">
                    <input type="checkbox" aria-label={`测试用例：${item.name}`} checked={selectedCaseIds.includes(item.id)}
                      disabled={controlsBusy || (!selectedCaseIds.includes(item.id) && selectedCaseIds.length >= 10)}
                      onChange={(event) => setSelectedCaseIds((previous) => event.target.checked ? [...previous, item.id] : previous.filter((id) => id !== item.id))} />
                    <Badge variant="outline" className="text-[10px]">
                      {item.source === 'regression' ? '失败回灌' : item.source === 'agent' ? 'Agent 加' : '人工'}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-[11px]">{item.name}</span>
                    <Button
                      type="button" size="sm" variant="ghost" className="h-6 px-2"
                      aria-label={`删除用例：${item.name}`}
                      disabled={controlsBusy}
                      onClick={() => { void deleteCase(item.id) }}
                    >
                      <Trash2 className="size-3" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>

      <section className="space-y-2" aria-label="跑评测">
        <Button
          type="button" size="sm"
          disabled={controlsBusy || !selectedDataset || selectedCaseIds.length === 0}
          onClick={() => { void runEvaluation() }}
        >
          {batchState.busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <Play className="size-3.5" aria-hidden="true" />}
          跑评测
        </Button>
        {selectedDataset && selectedDataset.cases.length > 0 ? (
          <span className="ml-2 text-[11px] text-muted-foreground">
            已选 {selectedCaseIds.length} / {selectedDataset.cases.length} 条，每批最多 10 条（会调用模型）
          </span>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
            {error}
          </p>
        ) : null}
      </section>

      {batchState.error ? <p role="alert" className="text-xs text-destructive">{batchState.error}</p> : null}
      <CapabilityFactoryBatchHistory batches={batchState.batches} selectedId={batchState.batch?.id} running={batchState.running} onSelect={batchState.select} onCancel={batchState.cancel} />
      {batchState.batch ? <section className="space-y-2" aria-label="批次评测结果">
        <p className="text-xs font-medium">内容通过 {batchState.batch.evaluation?.passedReview ?? 0} / {batchState.batch.items.length} · 格式有效 {batchState.batch.evaluation?.valid ?? 0} / {batchState.batch.items.length}</p>
        {batchState.batch.error ? <p role="alert" className="text-xs text-destructive">{batchState.batch.error}</p> : null}
        {batchState.runs.map((run) => <div key={run.id} className="space-y-1 rounded-sm border border-border/60 p-2 text-[11px]">
          <div className="flex items-center justify-between gap-2"><span>{describeReviewStatus(run).label} · v{run.sceneVersion}</span><Button type="button" size="sm" variant="outline" onClick={() => setInspected(run)}>查看详情</Button></div>
          <p className="text-muted-foreground">{run.error ?? run.review?.summary ?? '未完成内容评审'}</p>
        </div>)}
      </section> : null}
      <Dialog open={inspected !== null} onOpenChange={(open) => { if (!open) setInspected(null) }}>
        <DialogContent className="flex h-[min(820px,calc(100dvh-32px))] w-[calc(100vw-32px)] max-w-4xl min-w-0 flex-col" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>批量测试运行详情</DialogTitle></DialogHeader>
          {inspected ? <CapabilityFactoryRunResult run={inspected} /> : null}
        </DialogContent>
      </Dialog>
      {latest ? (
        <section className="space-y-1.5" aria-label="此前评测记录">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">内容质量</span>
            <Badge variant="outline" className="text-[10px]">{describeQuality(latest).status}</Badge>
            <span className="text-[11px] text-muted-foreground">{describeQuality(latest).detail}</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">格式与约束</span>
            <span className="font-mono text-[15px] font-semibold">{describeCompliance(latest).percent}</span>
            <span className="text-[11px] text-muted-foreground">{describeCompliance(latest).detail}</span>
            <Badge variant="outline" className="font-mono text-[10px]">场景 v{latest.sceneVersion}</Badge>
            <Badge variant="outline" className="font-mono text-[10px]">数据集 v{latest.datasetVersion}</Badge>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {describeEvaluationComparison(latest, previousSameDataset)}
          </p>
          {latest.judgeResults.length > 0 ? (
            <ul className="space-y-1" aria-label="判据汇总">
              {latest.judgeResults.map((result) => (
                <li key={result.criterionId} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">{result.criterion}</span>
                  <span className="font-mono">{describeJudgeResult(result)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {latest.error ? (
            <p role="alert" className="text-[11px] leading-relaxed text-destructive">{latest.error}</p>
          ) : null}
          {(latest.caseResults ?? []).length > 0 ? (
            <ul className="space-y-1" data-capability-factory-case-results>
              {(latest.caseResults ?? []).map((result) => (
                <li key={result.caseId} className="rounded-sm border border-border/70 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className={cn('text-[10px]', result.valid ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
                      {result.valid ? '通过' : '不通过'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px]">{result.caseName}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{result.status}</span>
                  </div>
                  {result.detail ? (
                    <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{result.detail}</p>
                  ) : null}
                  <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                    {result.reviewEligible === false && result.review?.passed === true
                      ? '内容评审：结果不具备质量通过资格（运行、格式或占位桩）'
                      : result.review?.status === 'succeeded'
                      ? `内容评审：${result.review.passed === true ? '通过' : result.review.passed === false ? '未通过' : '无法判断'} · ${result.review.summary}`
                      : result.review?.status === 'failed'
                        ? `内容评审失败：${result.review.error ?? '未返回原因'}`
                        : '内容评审：未完成'}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-1" aria-label="评测历史">
        <div className="text-[11px] font-medium text-muted-foreground">评测历史</div>
        {(evaluations ?? []).length === 0 ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            还没有评测记录。第一次评测之后，这里能看出"改了提示词有没有进步"。
          </p>
        ) : (
          <ul className="space-y-1">
            {(evaluations ?? []).map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-sm border border-border/70 px-2 py-1.5">
                <span className="text-[10px] text-muted-foreground">{describeQuality(item).status}</span>
                <span className="font-mono text-[11px]">{describeCompliance(item).percent}</span>
                <span className="text-[10px] text-muted-foreground">{describeCompliance(item).detail}</span>
                <span className="font-mono text-[10px] text-muted-foreground">场景 v{item.sceneVersion}</span>
                <span className="font-mono text-[10px] text-muted-foreground">数据集 v{item.datasetVersion}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {new Date(item.startedAt).toLocaleString('zh-CN', { hour12: false })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
