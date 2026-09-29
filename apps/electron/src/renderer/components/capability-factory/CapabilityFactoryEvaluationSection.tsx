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
  const [newDatasetName, setNewDatasetName] = React.useState(() => suggestedDatasetName(scene.definition.name))
  const [busy, setBusy] = React.useState<'idle' | 'evaluating' | 'dataset'>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [latest, setLatest] = React.useState<CapabilityEvaluation | null>(null)

  /** 拉取数据集、评测历史与最近一次整链运行（回灌用）。 */
  const refresh = React.useCallback(async () => {
    try {
      const [datasetList, history, runs] = await Promise.all([
        window.electronAPI.capabilityFactory.invoke('listDatasets', { sessionId }),
        window.electronAPI.capabilityFactory.invoke('listEvaluations', { sessionId, sceneId: scene.id, limit: 20 }),
        window.electronAPI.capabilityFactory.invoke('listRuns', {
          sessionId, sceneId: scene.id, kind: 'full', limit: 1,
        }),
      ])
      setDatasets(datasetList)
      setEvaluations(history)
      setLatest(history[0] ?? null)
      setLastRun(runs[0] ?? null)
      setSelectedDatasetId((current) => {
        if (current && datasetList.some((dataset) => dataset.id === current)) return current
        return datasetList[0]?.id ?? null
      })
    } catch (cause) {
      setError(errorText(cause))
      setDatasets([])
      setEvaluations([])
    }
  }, [scene.id, sessionId])

  React.useEffect(() => { void refresh() }, [refresh])

  const selectedDataset = datasets?.find((dataset) => dataset.id === selectedDatasetId) ?? null

  /** 新建数据集：评测必须有地方放用例，所以第一步就是它。 */
  const createDataset = React.useCallback(async () => {
    const name = newDatasetName.trim()
    if (name.length === 0 || busy !== 'idle') return
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
  }, [busy, newDatasetName, refresh, sessionId])

  /** 把最近一次真实运行的输入固化成用例 —— 这是"失败回灌"的最小形态。 */
  const addCaseFromLastRun = React.useCallback(async () => {
    if (!selectedDataset || !lastRun || busy !== 'idle') return
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
  }, [busy, lastRun, refresh, selectedDataset, sessionId])

  const deleteCase = React.useCallback(async (caseId: string) => {
    if (!selectedDataset || busy !== 'idle') return
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
  }, [busy, refresh, selectedDataset, sessionId])

  /** 跑评测：每条用例一次整链运行（会调模型，界面上写清条目数）。 */
  const runEvaluation = React.useCallback(async () => {
    if (!selectedDataset || busy !== 'idle') return
    setBusy('evaluating')
    try {
      const result = await window.electronAPI.capabilityFactory.invoke('runEvaluation', {
        sessionId, sceneId: scene.id, datasetId: selectedDataset.id,
      })
      setLatest(result)
      setError(null)
      await refresh()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('idle')
    }
  }, [busy, refresh, scene.id, selectedDataset, sessionId])

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
                value={newDatasetName} disabled={busy !== 'idle'}
                aria-label="新数据集名称"
                className="h-8 text-[11px]"
                onChange={(event) => setNewDatasetName(event.target.value)}
              />
              <Button type="button" size="sm" disabled={busy !== 'idle' || newDatasetName.trim().length === 0} onClick={() => { void createDataset() }}>
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
                disabled={busy !== 'idle' || !lastRun}
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
                    <Badge variant="outline" className="text-[10px]">
                      {item.source === 'regression' ? '失败回灌' : item.source === 'agent' ? 'Agent 加' : '人工'}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-[11px]">{item.name}</span>
                    <Button
                      type="button" size="sm" variant="ghost" className="h-6 px-2"
                      aria-label={`删除用例：${item.name}`}
                      disabled={busy !== 'idle'}
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
          disabled={busy !== 'idle' || !selectedDataset || selectedDataset.cases.length === 0}
          onClick={() => { void runEvaluation() }}
        >
          {busy === 'evaluating' ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <Play className="size-3.5" aria-hidden="true" />}
          跑评测
        </Button>
        {selectedDataset && selectedDataset.cases.length > 0 ? (
          <span className="ml-2 text-[11px] text-muted-foreground">
            将对 {selectedDataset.cases.length} 条用例各跑一次完整流程（会调用模型）
          </span>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
            {error}
          </p>
        ) : null}
      </section>

      {latest ? (
        <section className="space-y-1.5" aria-label="本次评测">
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
