import * as React from 'react'
import { useAtom } from 'jotai'
import { BarChart3, ChevronRight, Download, Info, RefreshCw, Search } from 'lucide-react'
import { TOKEN_USAGE_SOURCE_LABELS } from '@proma/shared'
import type {
  TokenUsageAPI,
  TokenUsageOption,
  TokenUsageQuery,
  TokenUsageSnapshot,
  TokenUsageSource,
  TokenUsageTaskDetail,
  TokenUsageTotals,
} from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useOpenSession } from '@/hooks/useOpenSession'
import { cn } from '@/lib/utils'
import {
  createTokenUsageQuery,
  loadTokenUsageSnapshot,
  drillIntoTokenUsage,
  formatTokenAmount,
  formatTokenUsageTotal,
  tokenCoverageLabel,
  tokenUsageDimensionAtom,
  tokenUsageQueryAtom,
  tokenUsageRangeAtom,
  tokenUsageViewAtom,
  validateTokenDates,
} from '@/atoms/token-usage'

/** 页面使用的卡片边界沿用设置页主题。 */
const CARD = 'settings-card rounded-xl border border-border/50 overflow-hidden'
/** 可注入只读桥接用于隔离 UI 验收，不启动真实客户端。 */
interface TokenUsageSettingsProps {
  api?: TokenUsageAPI
}
/** 所有有限选项统一使用项目 Radix Select。 */
function UsageSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value?: string
  options: TokenUsageOption[]
  onChange: (value: string | undefined) => void
}): React.ReactElement {
  /** 日期变化可能移除当前选项；保留明确的空范围标签，避免触发器变空。 */
  const visibleOptions =
    value && !options.some((option) => option.id === value)
      ? [...options, { id: value, name: `所选${label.replace('全部', '')}（当前范围无调用）` }]
      : options
  return (
    <Select
      value={value ?? '__all__'}
      onValueChange={(next) => onChange(next === '__all__' ? undefined : next)}
    >
      <SelectTrigger aria-label={label} className="h-9 min-w-0">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">{label}</SelectItem>
        {visibleOptions.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
/** 统一数字与未知口径；总量是已报告分量的小计。 */
export function TokenUsageMetrics({ totals }: { totals: TokenUsageTotals }): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-y-6 py-7 lg:grid-cols-4">
      {[
        ['累计 Token', formatTokenUsageTotal(totals, 'totalTokens'), '已报告用量小计', `${formatTokenUsageTotal(totals, 'totalTokens', 'exact')} Token`],
        ['输入 Token', formatTokenUsageTotal(totals, 'inputTokens'), '含缓存读取与缓存写入', `${formatTokenUsageTotal(totals, 'inputTokens', 'exact')} Token`],
        ['输出 Token', formatTokenUsageTotal(totals, 'outputTokens'), '含供应商计入的思考用量', `${formatTokenUsageTotal(totals, 'outputTokens', 'exact')} Token`],
        ['模型调用', formatTokenAmount(totals.calls, 'exact'), '可观察到的实际调用', `${formatTokenAmount(totals.calls, 'exact')} 次调用`],
      ].map(([label, value, note, exactValue]) => (
        <div key={label} className="border-border/40 px-4 first:pl-0 lg:border-l lg:first:border-l-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p title={exactValue} aria-label={exactValue} className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">
            {value}
          </p>
          <p className="mt-2 text-[11px] text-muted-foreground">{note}</p>
        </div>
      ))}
    </div>
  )
}
/** 加载、失败和无匹配状态共用可访问反馈，允许独立验证而不伪造业务数据。 */
export function TokenUsageFeedback({
  kind,
  onRetry,
}: {
  kind: 'loading' | 'error' | 'empty'
  onRetry?: () => void
}): React.ReactElement {
  if (kind === 'loading')
    return (
      <div role="status" className="space-y-5 py-6">
        <span className="text-sm text-muted-foreground">正在读取统计…</span>
        <div className="h-24 animate-pulse rounded-xl bg-muted/40" />
        <div className="h-52 animate-pulse rounded-xl bg-muted/30" />
      </div>
    )
  if (kind === 'error')
    return (
      <div role="alert" className={cn(CARD, 'p-10 text-center')}>
        <h2 className="text-sm font-medium">暂时无法读取用量记录</h2>
        <p className="my-3 text-xs text-muted-foreground">本地统计暂不可用。当前筛选已保留，可以重试加载。</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          重新加载
        </Button>
      </div>
    )
  return (
    <div role="status" className="p-10 text-center">
      <BarChart3 size={24} className="mx-auto mb-3 text-muted-foreground" />
      <h3 className="text-sm">当前范围没有匹配任务</h3>
      <p className="mt-2 text-xs text-muted-foreground">调整时间或筛选条件；新调用产生后可刷新查看。</p>
    </div>
  )
}
/** 根据是否已有快照选择整页反馈或局部提示，避免刷新时替换统计内容。 */
export function TokenUsageDataStatus({
  hasSnapshot,
  loading,
  error,
  onRetry,
}: {
  hasSnapshot: boolean
  loading: boolean
  error: string
  onRetry: () => void
}): React.ReactElement | null {
  if (!hasSnapshot && loading) return <TokenUsageFeedback kind="loading" />
  if (!hasSnapshot && error) return <TokenUsageFeedback kind="error" onRetry={onRetry} />
  if (!hasSnapshot) return null
  return (
    <>
      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          正在刷新统计数据…
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          刷新统计失败，已保留上次数据。可以稍后重试。
        </p>
      )}
    </>
  )
}
/** 任务详情刷新只更新数据；已有详情时保留抽屉内容并显示行内反馈。 */
export function TokenUsageTaskDetailStatus({
  hasDetail,
  loading,
  error,
  onRetry,
}: {
  hasDetail: boolean
  loading: boolean
  error: string
  onRetry: () => void
}): React.ReactElement | null {
  if (!hasDetail && loading) {
    return (
      <p role="status" className="py-8 text-sm text-muted-foreground">
        正在读取任务详情…
      </p>
    )
  }
  if (!hasDetail && error) {
    return (
      <div role="alert" className="py-8">
        <p className="mb-3 text-sm">{error}</p>
        <Button variant="outline" onClick={onRetry}>
          重试详情
        </Button>
      </div>
    )
  }
  if (!hasDetail) return null
  return (
    <>
      {loading && (
        <p role="status" className="pt-6 text-xs text-muted-foreground">
          正在刷新任务详情，当前内容仍可查看…
        </p>
      )}
      {error && (
        <div role="alert" className="pt-6 text-xs text-destructive">
          刷新任务详情失败，已保留上次数据。点击“重试详情”再次读取。
          <Button className="ml-2" size="sm" variant="outline" onClick={onRetry}>
            重试详情
          </Button>
        </div>
      )}
    </>
  )
}
/** 单页统计功能：请求只随筛选变化，过期请求不会覆盖当前结果。 */
export function TokenUsageSettings({ api }: TokenUsageSettingsProps): React.ReactElement {
  /** 使用生产 preload 或验收专用桥接；不会访问任意本机路径。 */
  const bridge = api ?? window.electronAPI
  const openSession = useOpenSession()
  const [query, setQuery] = useAtom(tokenUsageQueryAtom)
  const [range, setRange] = useAtom(tokenUsageRangeAtom)
  const [view, setView] = useAtom(tokenUsageViewAtom)
  const [dimension, setDimension] = useAtom(tokenUsageDimensionAtom)
  const [snapshot, setSnapshot] = React.useState<TokenUsageSnapshot | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [refresh, setRefresh] = React.useState(0)
  const [rules, setRules] = React.useState(false)
  const [dates, setDates] = React.useState(false)
  const [dateFrom, setDateFrom] = React.useState(query.from)
  const [dateTo, setDateTo] = React.useState(query.to)
  const [dateError, setDateError] = React.useState('')
  const [search, setSearch] = React.useState(query.search ?? '')
  const [taskId, setTaskId] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<TokenUsageTaskDetail | null>(null)
  const [detailError, setDetailError] = React.useState('')
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [expandedCall, setExpandedCall] = React.useState<string | null>(null)
  const [exporting, setExporting] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  /** 详情请求序号，阻止旧请求在刷新后覆盖当前结果。 */
  const detailRequestRef = React.useRef(0)
  /** 搜索防抖，避免每按一个键就读取账本；清理定时器避免旧输入回写。 */
  React.useEffect(() => {
    const timer = setTimeout(
      () =>
        setQuery((current) =>
          current.search === (search || undefined)
            ? current
            : { ...current, search: search || undefined, page: 1 },
        ),
      250,
    )
    return () => clearTimeout(timer)
  }, [search, setQuery])
  React.useEffect(
    () =>
      loadTokenUsageSnapshot(
        () => bridge.getTokenUsage(query),
        (state) => {
          setLoading(state.status === 'loading')
          setError(state.status === 'error' ? '本地统计暂不可用。当前筛选已保留，可以重试加载。' : '')
          if (state.status === 'ready') setSnapshot(state.snapshot)
        },
      ),
    [bridge, query, refresh],
  )
  /** 重新查询统计时保留当前任务详情，仅更新详情数据并显示局部加载状态。 */
  const detailRefreshRef = React.useRef(refresh)
  React.useEffect(() => {
    let current = true
    /** 当前 effect 对应的详情请求序号；响应只允许写回最新请求。 */
    const requestId = ++detailRequestRef.current
    setDetail(null)
    setDetailError('')
    setExpandedCall(null)
    if (!taskId) return
    setDetailLoading(true)
    bridge
      .getTokenUsageTask(taskId, query)
      .then((result) => {
        if (current && detailRequestRef.current === requestId) {
          setDetail(result)
          if (!result) setDetailError('此任务的统计记录已不可用。')
        }
      })
      .catch(() => {
        if (current && detailRequestRef.current === requestId) setDetailError('任务详情读取失败，请重试。')
      })
      .finally(() => {
        if (current && detailRequestRef.current === requestId) setDetailLoading(false)
      })
    return () => {
      current = false
    }
  }, [bridge, taskId, query])
  React.useEffect(() => {
    if (detailRefreshRef.current === refresh) return
    detailRefreshRef.current = refresh
    if (!taskId) return
    let current = true
    /** 刷新详情请求序号；避免首次读取和手动刷新并发时旧结果回写。 */
    const requestId = ++detailRequestRef.current
    setDetailError('')
    setDetailLoading(true)
    bridge
      .getTokenUsageTask(taskId, query)
      .then((result) => {
        if (current && detailRequestRef.current === requestId) {
          setDetail(result)
          if (!result) setDetailError('此任务的统计记录已不可用。')
        }
      })
      .catch(() => {
        if (current && detailRequestRef.current === requestId) setDetailError('任务详情读取失败，请重试。')
      })
      .finally(() => {
        if (current && detailRequestRef.current === requestId) setDetailLoading(false)
      })
    return () => {
      current = false
    }
  }, [bridge, taskId, query, refresh])
  /** 修改筛选清除页码；排序和未知筛选保留当前下钻日期。 */
  function filter(patch: Partial<TokenUsageQuery>): void {
    setQuery((current) => ({ ...current, ...patch, page: 1 }))
  }
  /** 排行或趋势下钻时移除旧局部搜索，转到任务视图。 */
  function drill(patch: Partial<TokenUsageQuery>): void {
    setSearch('')
    setQuery((current) => drillIntoTokenUsage(current, patch))
    setView('tasks')
  }
  /** 导出捕获当前筛选，保存由主进程系统对话框完成。 */
  async function exportCsv(): Promise<void> {
    setExporting(true)
    setNotice('')
    try {
      const result = await bridge.exportTokenUsage(query)
      setNotice(result.saved ? `已导出 ${result.count} 次调用` : '已取消导出')
    } catch {
      setNotice('导出失败，请重试。')
    } finally {
      setExporting(false)
    }
  }
  /** 任务分页信息来自服务端；总览只显示最近三项。 */
  const tasks = snapshot ? (view === 'overview' ? snapshot.tasks.slice(0, 3) : snapshot.tasks) : []
  const pageCount = snapshot ? Math.max(1, Math.ceil(snapshot.taskCount / snapshot.pageSize)) : 1
  const chartMax = Math.max(1, ...(snapshot?.trend.map((day) => day.totalTokens) ?? []))
  const rankMax = Math.max(1, ...(snapshot?.ranking[dimension].map((rank) => rank.totalTokens) ?? []))
  return (
    <div className="space-y-6" data-testid="token-usage-settings">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold">Token 统计</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">了解模型用量，追溯每一次任务的消耗。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setRules(true)}>
            <Info size={14} className="mr-1.5" />
            统计口径
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || !!error || !snapshot?.taskCount || snapshot.coverage.historyImportedAt === null || exporting}
            onClick={() => void exportCsv()}
          >
            <Download size={14} className="mr-1.5" />
            {exporting ? '正在导出…' : '导出 CSV'}
          </Button>
        </div>
      </header>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex rounded-md bg-muted/50 p-1" role="group" aria-label="时间范围">
            {(
              [
                ['today', '今天'],
                ['week', '近 7 天'],
                ['month', '本月'],
                ['custom', '自定义'],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                variant="ghost"
                size="sm"
                className={cn('h-7 px-3 text-xs', range === value && 'bg-background shadow-sm')}
                aria-pressed={range === value}
                onClick={() => {
                  if (value === 'custom') {
                    setDateFrom(query.from)
                    setDateTo(query.to)
                    setDateError('')
                    setDates(true)
                  } else {
                    setRange(value)
                    filter({ ...createTokenUsageQuery(value), day: undefined })
                  }
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">
            {query.from} — {query.to}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <UsageSelect
            label="全部项目"
            value={query.projectId}
            options={snapshot?.options.projects ?? []}
            onChange={(projectId) => filter({ projectId, day: undefined })}
          />
          <UsageSelect
            label="全部模型"
            value={query.modelId}
            options={snapshot?.options.models ?? []}
            onChange={(modelId) => filter({ modelId, day: undefined })}
          />
          <UsageSelect
            label="全部渠道"
            value={query.channelId}
            options={snapshot?.options.channels ?? []}
            onChange={(channelId) => filter({ channelId, day: undefined })}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新统计"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>
        {(query.day || query.source || query.projectId || query.modelId || query.channelId) && (
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {query.day && <span>日期：{query.day}</span>}
            {query.source && <span>任务类型：{TOKEN_USAGE_SOURCE_LABELS[query.source]}</span>}
            <button
              className="underline underline-offset-4"
              onClick={() => {
                setSearch('')
                setQuery(createTokenUsageQuery(range === 'custom' ? 'week' : range))
                if (range === 'custom') setRange('week')
              }}
            >
              清除筛选
            </button>
          </div>
        )}
      </div>
      <Tabs
        value={view}
        onValueChange={(next) => {
          setView(next as 'overview' | 'tasks')
          if (next === 'overview') {
            setSearch('')
            filter({ search: undefined, unknownOnly: false, sort: 'recent' })
          }
        }}
      >
        <TabsList className="border-b border-border/40 bg-transparent p-0">
          <TabsTrigger value="overview">用量总览</TabsTrigger>
          <TabsTrigger value="tasks">任务明细 {snapshot ? `(${snapshot.taskCount})` : ''}</TabsTrigger>
        </TabsList>
      </Tabs>
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      <TokenUsageDataStatus
        hasSnapshot={snapshot !== null}
        loading={loading}
        error={error}
        onRetry={() => setRefresh((value) => value + 1)}
      />
      {snapshot && (
        <>
            <div>
              <TokenUsageMetrics totals={snapshot.totals} />
              <p className="border-y border-border/30 py-3 text-xs text-muted-foreground">
                报告覆盖度：{tokenCoverageLabel(snapshot.totals)}
              </p>
              {snapshot.coverage.historyImportedAt === null && !snapshot.coverage.historyImportError && (
                <p role="status" className="mt-3 text-xs text-muted-foreground">
                  历史用量正在后台恢复，当前先展示已采集记录；恢复完成后点击右上角刷新查看。
                </p>
              )}
              {snapshot.coverage.historyImportError && (
                <p role="alert" className="mt-3 text-xs text-destructive">
                  历史用量恢复失败：{snapshot.coverage.historyImportError}。点击右上角刷新重试。
                </p>
              )}
              {snapshot.coverage.recordingError && <p role="alert" className="mt-3 text-xs text-destructive">{snapshot.coverage.recordingError}</p>}
            </div>
            {view === 'overview' && (
              <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
                <section>
                  <h2 className="text-sm font-medium">用量趋势</h2>
                  <p className="mb-3 mt-1 text-xs text-muted-foreground">每日输入与输出 · 点击日期查看任务</p>
                  <div className={cn(CARD, 'p-4')}>
                    <div className="flex h-44 items-end gap-1 overflow-x-auto">
                      {snapshot.trend.map((day) => (
                        <button
                          key={day.day}
                          className="group flex h-full min-w-5 flex-1 flex-col justify-end rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                          aria-label={`${day.day}，${day.totalTokens} Token，${day.calls} 次调用`}
                          title={`${day.day} · 输入 ${formatTokenAmount(day.inputTokens, 'exact')} / 输出 ${formatTokenAmount(day.outputTokens, 'exact')} Token · ${day.unknownCalls} 次未知`}
                          onClick={() => drill({ day: day.day })}
                        >
                          <div
                            className="mx-auto flex w-full max-w-8 flex-col justify-end overflow-hidden rounded-t-sm"
                            style={{
                              height: `${Math.max(day.calls ? 2 : 0, (day.totalTokens / chartMax) * 100)}%`,
                            }}
                          >
                            <div
                              className="min-h-0 bg-foreground/35 group-hover:bg-foreground/50"
                              style={{ flex: day.outputTokens }}
                            />
                            <div
                              className="min-h-0 bg-foreground/75 group-hover:bg-foreground"
                              style={{ flex: day.inputTokens }}
                            />
                          </div>
                          <span className="mt-2 text-[9px] text-muted-foreground">
                            {snapshot.trend.length <= 14 ? day.day.slice(5) : day.day.slice(8)}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p className="mt-4 flex gap-4 text-[11px] text-muted-foreground">
                      <span>■ 输入（含缓存）</span>
                      <span className="opacity-60">■ 输出</span>
                    </p>
                  </div>
                </section>
                <section>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-medium">消耗来源</h2>
                    <div role="group" aria-label="来源维度" className="flex gap-1">
                      {(
                        [
                          ['project', '项目'],
                          ['model', '模型'],
                          ['source', '任务类型'],
                        ] as const
                      ).map(([value, label]) => (
                        <Button
                          key={value}
                          size="sm"
                          variant="ghost"
                          className={cn('h-7 px-2 text-xs', dimension === value && 'bg-muted')}
                          aria-pressed={dimension === value}
                          onClick={() => setDimension(value)}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className={cn(CARD, 'max-h-80 overflow-y-auto')}>
                    {snapshot.ranking[dimension].length ? (
                      snapshot.ranking[dimension].map((rank, index) => (
                        <button
                          key={rank.id}
                          className="block w-full border-b border-border/25 px-4 py-3 text-left last:border-0 hover:bg-muted/40"
                          onClick={() =>
                            drill(
                              dimension === 'project'
                                ? { projectId: rank.id }
                                : dimension === 'model'
                                  ? { modelId: rank.id }
                                  : { source: rank.id as TokenUsageSource },
                            )
                          }
                        >
                          <span className="flex items-center justify-between gap-3 text-xs">
                            <span className="truncate">
                              <span className="mr-2 text-muted-foreground">{index + 1}</span>
                              {rank.name}
                            </span>
                            <span title={`${formatTokenUsageTotal(rank, 'totalTokens', 'exact')} Token`} className="shrink-0 tabular-nums">
                              {formatTokenUsageTotal(rank, 'totalTokens')}
                            </span>
                          </span>
                          <span className="mt-2 block h-1 rounded-full bg-muted">
                            <span
                              className="block h-full rounded-full bg-foreground/40"
                              style={{ width: `${(rank.totalTokens / rankMax) * 100}%` }}
                            />
                          </span>
                          <span className="mt-1 block text-[10px] text-muted-foreground">
                            {rank.calls} 次调用
                            {rank.unknownCalls + rank.partialCalls > 0
                              ? ` · ${rank.unknownCalls + rank.partialCalls} 次报告不完整`
                              : ''}
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="p-8 text-center text-xs text-muted-foreground">当前范围暂无调用</p>
                    )}
                  </div>
                </section>
              </div>
            )}
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-medium">{view === 'overview' ? '最近任务' : '任务明细'}</h2>
                {view === 'overview' && (
                  <Button size="sm" variant="ghost" onClick={() => setView('tasks')}>
                    查看全部
                    <ChevronRight size={14} />
                  </Button>
                )}
              </div>
              {view === 'tasks' && (
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <div className="relative min-w-48 flex-1">
                    <Search size={14} className="absolute left-3 top-3 text-muted-foreground" />
                    <Input
                      aria-label="搜索任务"
                      maxLength={500}
                      placeholder="搜索任务名称或项目"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      className="pl-9"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="accent-foreground"
                      checked={query.unknownOnly ?? false}
                      onChange={(event) => filter({ unknownOnly: event.target.checked })}
                    />
                    仅看有未知用量的任务
                  </label>
                  <div className="w-32">
                    <Select
                      value={query.sort ?? 'recent'}
                      onValueChange={(sort) => filter({ sort: sort as 'recent' | 'tokens' })}
                    >
                      <SelectTrigger aria-label="任务排序">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="recent">最近发生</SelectItem>
                        <SelectItem value="tokens">消耗最多</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              <div className={CARD}>
                {tasks.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-xs">
                      <thead className="bg-muted/25 text-muted-foreground">
                        <tr>
                          <th className="px-4 py-3 text-left font-normal">任务 / 项目</th>
                          <th className="p-3 text-right font-normal">Token</th>
                          <th className="p-3 text-right font-normal">调用</th>
                          <th className="p-3 text-right font-normal">最近发生</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tasks.map((task) => (
                          <tr key={task.id} className="border-t border-border/25 hover:bg-muted/30">
                            <td className="max-w-72 px-4 py-3">
                              <button
                                className="flex w-full items-center gap-2 text-left"
                                onClick={() => setTaskId(task.id)}
                              >
                                <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
                                <span className="truncate font-medium">{task.title}</span>
                              </button>
                              <p className="ml-5 mt-1 truncate text-[11px] text-muted-foreground">
                                {task.projectNames.join('、')} · {task.modelIds.join('、')}
                              </p>
                            </td>
                            <td className="p-3 text-right tabular-nums">
                              <span title={`${formatTokenUsageTotal(task, 'totalTokens', 'exact')} Token`}>
                                {formatTokenUsageTotal(task, 'totalTokens')}
                              </span>
                              {task.unknownCalls + task.partialCalls > 0 && (
                                <p className="mt-1 text-[10px] text-muted-foreground">
                                  含 {task.unknownCalls + task.partialCalls} 次用量不完整
                                </p>
                              )}
                            </td>
                            <td className="p-3 text-right tabular-nums">{task.calls}</td>
                            <td className="whitespace-nowrap p-3 text-right text-muted-foreground">
                              {new Date(task.lastCalledAt).toLocaleString('zh-CN', {
                                month: '2-digit',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <TokenUsageFeedback kind="empty" />
                )}
              </div>
              {view === 'tasks' && (
                <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    共 {snapshot.taskCount} 个任务 · 第 {snapshot.page} / {pageCount} 页
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={snapshot.page <= 1}
                      onClick={() => setQuery({ ...query, page: snapshot.page - 1 })}
                    >
                      上一页
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={snapshot.page >= pageCount}
                      onClick={() => setQuery({ ...query, page: snapshot.page + 1 })}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">
                任务用量只汇总当前筛选内的调用；点击任务查看每次调用与完整任务。
              </p>
            </section>
            <p className="text-[11px] text-muted-foreground">
              统计保存在本机 · 仅汇总已报告用量 · 时区 {query.timeZone}
            </p>
        </>
      )}
      <Dialog open={dates} onOpenChange={setDates}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>自定义时间范围</DialogTitle>
            <DialogDescription>按 {query.timeZone} 自然日统计，包含起止日期，最多一年。</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (!validateTokenDates(dateFrom, dateTo)) {
                setDateError('请输入有效日期，结束不能早于开始，且范围不能超过一年。')
                return
              }
              setRange('custom')
              filter({ from: dateFrom, to: dateTo, day: undefined })
              setDates(false)
            }}
          >
            <div className="grid grid-cols-2 gap-4">
              <label className="space-y-2 text-sm">
                开始日期
                <Input
                  type="date"
                  required
                  value={dateFrom}
                  onChange={(event) => setDateFrom(event.target.value)}
                />
              </label>
              <label className="space-y-2 text-sm">
                结束日期
                <Input
                  type="date"
                  required
                  value={dateTo}
                  onChange={(event) => setDateTo(event.target.value)}
                />
              </label>
            </div>
            {dateError && (
              <p role="alert" className="text-xs text-destructive">
                {dateError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setDates(false)}>
                取消
              </Button>
              <Button type="submit">应用范围</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={rules} onOpenChange={setRules}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>统计口径</DialogTitle>
            <DialogDescription>让总量、来源与任务明细使用同一套依据。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            {[
              [
                '累计用量与上下文占用',
                '这里累计每次模型调用的消耗。历史内容再次发送会产生新的输入；会话中的上下文圆环表示当前窗口占用。',
              ],
              [
                '输入、输出与缓存',
                '总 Token = 输入 + 输出。输入包含缓存读取与缓存写入，缓存不重复相加；已计入输出的思考用量不再重复计算。',
              ],
              [
                '数字单位',
                '大数值使用 K（千）、M（百万）、B（十亿）、T（万亿），最多保留两位小数；悬停查看精确值，CSV 导出保留原始数字。',
              ],
              [
                '已知、未知与失败调用',
                '只使用模型接口报告的用量。未报告标记为未知，不补零、不用字符估算替代。部分报告只计入已知分量；失败或取消仍可能产生消耗。',
              ],
              [
                '归属与去重',
                '每次可观察调用只记一次，子 Agent 和后台处理归入所属任务；项目、渠道和模型采用调用时快照。供应商内部重试可能不可观察。',
              ],
            ].map(([title, text]) => (
              <div key={title}>
                <h3 className="font-medium">{title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{text}</p>
              </div>
            ))}
            <div>
              <h3 className="font-medium">历史覆盖</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {snapshot
                  ? `采集起点：${new Date(snapshot.coverage.trackingStartedAt).toLocaleString('zh-CN')}。恢复 ${snapshot.coverage.historyRecords} 条有依据的历史调用。`
                  : '历史只恢复有明确用量依据的记录。'}
                删除会话不清除已记录用量。
              </p>
              {snapshot?.coverage.notes.map((note) => (
                <p key={note} className="mt-2 text-xs text-muted-foreground">
                  {note}
                </p>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Sheet
        open={taskId !== null}
        onOpenChange={(open) => {
          if (!open) setTaskId(null)
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{detail?.task.title ?? '任务用量详情'}</SheetTitle>
            <SheetDescription>当前筛选贡献与完整任务分别展示，范围外调用不加入当前小计。</SheetDescription>
          </SheetHeader>
          <TokenUsageTaskDetailStatus
            hasDetail={detail !== null}
            loading={detailLoading}
            error={detailError}
            onRetry={() => setRefresh((value) => value + 1)}
          />
          {detail && (
            <div className="space-y-6 pt-6">
                <section>
                  <p className="text-xs text-muted-foreground">当前筛选贡献</p>
                  <p title={`${formatTokenUsageTotal(detail.matching, 'totalTokens', 'exact')} Token`} className="mt-2 text-3xl font-semibold tabular-nums">
                    {formatTokenUsageTotal(detail.matching, 'totalTokens')}{' '}
                    <span className="text-sm font-normal">Token</span>
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">{tokenCoverageLabel(detail.matching)}</p>
                  <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    {[
                      ['输入（含缓存）', formatTokenUsageTotal(detail.matching, 'inputTokens'), formatTokenUsageTotal(detail.matching, 'inputTokens', 'exact')],
                      ['输出', formatTokenUsageTotal(detail.matching, 'outputTokens'), formatTokenUsageTotal(detail.matching, 'outputTokens', 'exact')],
                      ['缓存读取', formatTokenUsageTotal(detail.matching, 'cacheReadTokens'), formatTokenUsageTotal(detail.matching, 'cacheReadTokens', 'exact')],
                      ['缓存写入', formatTokenUsageTotal(detail.matching, 'cacheWriteTokens'), formatTokenUsageTotal(detail.matching, 'cacheWriteTokens', 'exact')],
                    ].map(([label, value, exactValue]) => (
                      <div key={label} className="rounded-md bg-muted/40 p-3">
                        <p className="text-muted-foreground">{label}</p>
                        <p title={`${exactValue} Token`} className="mt-1 tabular-nums">{value}</p>
                      </div>
                    ))}
                  </div>
                </section>
                <div className="rounded-md border border-border/40 p-3 text-xs text-muted-foreground">
                  完整任务：<span title={`${formatTokenUsageTotal(detail.task, 'totalTokens', 'exact')} Token`}>{formatTokenUsageTotal(detail.task, 'totalTokens')} Token</span> · {detail.task.calls} 次调用
                  {detail.task.sessionId && detail.task.sessionType && (
                    <Button
                      className="mt-3 block"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const task = detail.task
                        if (task.sessionId && task.sessionType) {
                          setTaskId(null)
                          openSession(task.sessionType, task.sessionId, task.title)
                        }
                      }}
                    >
                      打开关联会话
                    </Button>
                  )}
                </div>
                <section>
                  <h3 className="mb-3 text-sm font-medium">逐次调用</h3>
                  <div className={CARD}>
                    {detail.calls.map((call) => {
                      /** 单次调用只累加已报告分量，两者都未知时保持未知。 */
                      const callTokens = call.inputTokens === null && call.outputTokens === null
                        ? null
                        : (call.inputTokens ?? 0) + (call.outputTokens ?? 0)
                      /** 缩写与精确提示共用部分报告标记，防止误读为完整用量。 */
                      const partialLabel = callTokens !== null && (call.inputTokens === null || call.outputTokens === null) ? '（部分）' : ''
                      return (
                        <div key={call.id} className="border-b border-border/30 last:border-0">
                          <button
                            aria-expanded={expandedCall === call.id}
                            className="w-full p-3 text-left hover:bg-muted/30"
                            onClick={() => setExpandedCall(expandedCall === call.id ? null : call.id)}
                          >
                            <span className="flex justify-between gap-3 text-xs">
                              <span className="truncate">
                                {TOKEN_USAGE_SOURCE_LABELS[call.source]} · {call.modelId}
                              </span>
                              <span title={`${formatTokenAmount(callTokens, 'exact')}${partialLabel} Token`} className="shrink-0">
                                {formatTokenAmount(callTokens)}{partialLabel}
                              </span>
                            </span>
                            <span className="mt-1 block text-[11px] text-muted-foreground">
                              {new Date(call.startedAt).toLocaleString('zh-CN')} ·{' '}
                              {call.status === 'completed'
                                ? '完成'
                                : call.status === 'cancelled'
                                  ? '已取消'
                                  : '失败'}
                              {!call.matchesFilter && ' · 范围外'}
                            </span>
                          </button>
                          {expandedCall === call.id && (
                            <dl className="grid grid-cols-2 gap-2 bg-muted/20 px-3 pb-3 text-xs">
                              {[
                                ['项目', call.projectName],
                                ['渠道', call.channelName],
                                ['输入（含缓存）', formatTokenAmount(call.inputTokens), formatTokenAmount(call.inputTokens, 'exact')],
                                ['输出', formatTokenAmount(call.outputTokens), formatTokenAmount(call.outputTokens, 'exact')],
                                ['缓存读取', formatTokenAmount(call.cacheReadTokens), formatTokenAmount(call.cacheReadTokens, 'exact')],
                                ['缓存写入', formatTokenAmount(call.cacheWriteTokens), formatTokenAmount(call.cacheWriteTokens, 'exact')],
                                ['记录来源', call.origin === 'history' ? '历史恢复' : '实时采集'],
                                [
                                  '重试可见性',
                                  call.hiddenRetriesPossible ? '可能含不可观察的内部重试' : '按可观察调用统计',
                                ],
                              ].map(([label, value, exactValue]) => (
                                <div key={label}>
                                  <dt className="mt-2 text-muted-foreground">{label}</dt>
                                  <dd title={exactValue === undefined ? undefined : `${exactValue} Token`} className="mt-1 break-words">{value}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
