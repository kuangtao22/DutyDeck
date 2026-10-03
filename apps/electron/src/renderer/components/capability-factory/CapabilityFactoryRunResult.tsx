/** 一次运行的结果视图：先看输出与结论，需要排查时再展开流程细节。 */
import * as React from 'react'
import { Check, ChevronDown, Circle, CircleAlert, LoaderCircle, Minus } from 'lucide-react'
import type { CapabilityRun, CapabilityRunReview, StepTrace } from '@proma/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { CapabilityFactoryOptimizeAction } from './CapabilityFactoryOptimizeAction'
import { CapabilityTaskEditor } from './CapabilityTaskEditor'
import { inspectTaskContent } from './capability-factory-task-input'
import {
  describeConstraintAxis, describeReviewStatus, describeRunStatus, describeRunVerdict, describeStepStatus, describeRunStepNavigation,
  formatDuration, type RunTone,
} from './capability-factory-run-view'

/** 语气对应的状态样式，保持运行页内语义一致。 */
const TONE_CLASS: Record<RunTone, string> = {
  ok: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  warn: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  bad: 'border-destructive/40 text-destructive',
  idle: 'text-muted-foreground',
}

/** 把结构化值转成适合检查的文本。 */
function pretty(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 取得步骤最适合直接阅读的一份输出，避免原始值与解析值同时重复展示。 */
function stepOutput(step: StepTrace): unknown {
  return step.parsedOutput ?? step.rawOutput
}

/** 把运行记录里的实际模型绑定压缩成底部标记，避免模型信息单独占一个导航项。 */
function ModelMarker({ run, reviewModel }: { run: CapabilityRun; reviewModel?: CapabilityRunReview['modelBinding'] }): React.ReactElement {
  const executionModels = run.modelBindings?.length
    ? run.modelBindings.map((binding) => `${binding.channelName}/${binding.modelId}${binding.substituted ? `（替代声明 ${binding.declaredModel}）` : ''}`)
    : Array.from(new Set(run.steps.map((step) => step.model).filter((model): model is string => Boolean(model))))
  const executionLabel = executionModels.length > 0 ? executionModels.join(' · ') : '未记录'
  return (
    <div className="shrink-0 border-t border-border/60 px-3 py-1.5 text-[10px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]" aria-label="当前使用模型">
      <span className="font-medium text-foreground/70">模型：</span>{executionLabel}
      {reviewModel ? <><span className="mx-1.5 text-border">·</span><span className="font-medium text-foreground/70">评审：</span>{reviewModel.channelName}/{reviewModel.modelId}</> : null}
    </div>
  )
}

/** 首屏只说明本轮可确认的事实，不把格式通过描述成内容质量合格。 */
function conciseVerdict(run: CapabilityRun): string {
  if (run.status === 'running') return describeRunVerdict(run)
  if (run.placeholderCapabilities && run.placeholderCapabilities.length > 0) return describeRunVerdict(run)
  if (run.status === 'succeeded' && run.valid) return '输出格式符合约束，内容质量需另行评审。'
  if (!run.valid) return '输出未通过约束，请查看错误并调整提示词。'
  return '运行未完整完成，请查看错误与步骤详情。'
}

/** 进度图标只反映真实状态；减少动态效果模式下仍保留文字和静态图标。 */
function ProgressMark({ state, label }: { state: 'running' | 'done' | 'failed' | 'pending' | 'skipped'; label: string }): React.ReactElement {
  const Icon = state === 'running' ? LoaderCircle : state === 'done' ? Check : state === 'failed' ? CircleAlert : state === 'skipped' ? Minus : Circle
  return <span title={label} className="inline-flex shrink-0">
    <Icon aria-hidden="true" className={cn('size-3', state === 'running' && 'animate-spin motion-reduce:animate-none text-primary', state === 'done' && 'text-emerald-600 dark:text-emerald-400', state === 'failed' && 'text-destructive', (state === 'pending' || state === 'skipped') && 'text-muted-foreground')} />
    <span className="sr-only">{label}</span>
  </span>
}

/** 自动评审首屏：只展开问题与建议，全部判据和指标收进细项。 */
function ReviewSummary({ run, review, isStepReview: stepReviewOverride }: { run: CapabilityRun; review: CapabilityRunReview; isStepReview?: boolean }): React.ReactElement {
  /** 单步记录的评审范围不能被误读为整个场景。 */
  const isStepReview = stepReviewOverride ?? run.kind === 'step'
  /** 未通过或无法确认的判据是当前最需要处理的信息。 */
  const unresolvedCriteria = review.criteria.filter((item) => item.passed !== true)
  /** 首屏最多放三条行动信息：优先两条判据，至少给一条改进建议。 */
  const visibleCriteria = unresolvedCriteria.slice(0, 2)
  /** 判据不足两条时，把剩余名额留给建议。 */
  const visibleSuggestions = review.suggestions.slice(0, 3 - visibleCriteria.length)
  /** 未在首屏展示的内容仍可从评测细项查看。 */
  const hiddenItemCount = unresolvedCriteria.length + review.suggestions.length
    - visibleCriteria.length - visibleSuggestions.length
  /** 评审细项默认折叠，避免成功判据和指标挤占首屏。 */
  const [detailsOpen, setDetailsOpen] = React.useState(false)

  return (
    <section className="space-y-2 rounded-md border border-border/70 bg-muted/20 px-2.5 py-2.5" aria-label={isStepReview ? '当前步骤评审' : '自动评审'}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium">{isStepReview ? '当前步骤评审' : '自动评审'}</span>
        {review.finishedAt !== null ? (
          <span className="font-mono text-[10px] text-muted-foreground">{formatDuration(review.startedAt, review.finishedAt)}</span>
        ) : null}
      </div>

      {review.summary ? <p className="text-[12px] leading-relaxed">{review.summary}</p> : null}
      {review.status === 'running' ? <p className="text-[11px] text-muted-foreground">正在按本轮固定标准评测…</p> : null}
      {review.status === 'failed' ? (
        <p role="alert" className="text-[11px] leading-relaxed text-destructive">{review.error ?? '评测未完成，运行输出已保留。'}</p>
      ) : null}
      {isStepReview ? <p className="text-[10px] text-muted-foreground">结论只覆盖当前步骤，不代表整个场景已达标。</p> : null}

      {visibleCriteria.length > 0 ? (
        <ul className="space-y-1 text-[11px] leading-relaxed">
          {visibleCriteria.map((item) => (
            <li key={`${item.criterion}-${item.evidence}`} className={item.passed === false ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}>
              <span className="font-medium">{item.passed === false ? '未通过' : '待确认'}：{item.criterion}</span>
              {item.evidence ? <span className="block pl-3 text-muted-foreground">证据：{item.evidence}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {visibleSuggestions.length > 0 ? (
        <div className="rounded-sm border border-border/60 bg-background/50 px-2 py-1.5">
          <div className="text-[10px] font-medium text-muted-foreground">改进建议</div>
          <ul className="mt-0.5 space-y-0.5 text-[11px] leading-relaxed">
            {visibleSuggestions.map((suggestion) => <li key={suggestion}>· {suggestion}</li>)}
          </ul>
        </div>
      ) : null}

      {hiddenItemCount > 0 ? (
        <p className="text-[10px] text-muted-foreground">其余 {hiddenItemCount} 项在评测细项中。</p>
      ) : null}

      {(review.criteria.length > 0 || review.metrics.length > 0 || review.suggestions.length > 0 || review.modelBinding) ? (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-7 w-full justify-between px-1.5 text-[11px] text-muted-foreground">
              <span>评测细项</span>
              <ChevronDown className={cn('size-3.5 transition-transform', detailsOpen && 'rotate-180')} aria-hidden="true" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-1">
            {review.criteria.length > 0 ? (
              <ul className="space-y-1 text-[10px] leading-relaxed text-muted-foreground">
                {review.criteria.map((item) => (
                  <li key={`${item.criterion}-${item.evidence}`}>
                    <span className="font-medium text-foreground">
                      {item.passed === true ? '通过' : item.passed === false ? '未通过' : '待确认'}：{item.criterion}
                    </span>
                    {item.evidence ? <span className="block">证据：{item.evidence}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {review.metrics.length > 0 ? (
              <ul className="grid grid-cols-2 gap-1.5">
                {review.metrics.map((metric) => (
                  <li key={metric.name} className="rounded-sm border border-border/60 px-2 py-1.5">
                    <div className="text-[10px] text-muted-foreground">{metric.name}</div>
                    <div className="font-mono text-[12px] font-medium">{metric.value === null ? '无法计算' : metric.value}</div>
                    {metric.evidence ? <div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{metric.evidence}</div> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {review.suggestions.length > 0 ? (
              <div>
                <div className="text-[10px] font-medium text-muted-foreground">全部改进建议</div>
                <ul className="mt-0.5 space-y-0.5 text-[10px] leading-relaxed text-muted-foreground">
                  {review.suggestions.map((suggestion) => <li key={suggestion}>· {suggestion}</li>)}
                </ul>
              </div>
            ) : null}
            {review.modelBinding ? (
              <p className="font-mono text-[10px] text-muted-foreground">
                评审模型：{review.modelBinding.channelName}/{review.modelBinding.modelId}
              </p>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  )
}

/** 只读展示不产生业务写入，复用提交任务的编辑器。 */
const ignoreReadOnlyChange = (): void => {}

/** 标题与说明不进入正文滚动区；各详情页共用同一固定位置。 */
function DetailHeader({ title, children, actions }: { title: string; children?: React.ReactNode; actions?: React.ReactNode }): React.ReactElement {
  return <header data-run-detail-header="true" className="shrink-0 space-y-2 border-b border-border/60 p-3">
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
      <h3 className="break-words text-sm font-medium">{title}</h3>
      {actions}
    </div>
    {children}
  </header>
}

/** 仅挂载当前材料的编辑器；字符串保持原样，结构化值只做展示序列化。 */
function RunText({ value, empty = '没有产出（运行未完成）。', label = '运行内容', fillHeight = true }: {
  value: unknown; empty?: string; label?: string; fillHeight?: boolean
}): React.ReactElement {
  const id = React.useId()
  const content = React.useMemo(() => pretty(value), [value])
  const format = React.useMemo(() => {
    const detected = inspectTaskContent(content).format
    return detected === 'markdown' ? 'markdown' : detected === 'json' || /^\s*[\[{]/.test(content) ? 'json' : 'text'
  }, [content])
  return value === undefined || value === null
    ? <p className="p-3 text-xs text-muted-foreground">{empty}</p>
    : <CapabilityTaskEditor id={id} value={content} format={format} disabled={false} readOnly fillHeight={fillHeight}
        ariaLabel={label} invalid={false} describedBy="" onChange={ignoreReadOnlyChange} />
}

/** 单步详情只显示一类材料；切换步骤后回到输出，不沿用其他步骤的选择。 */
function StepDetails({ run, step, review, hideInput }: { run: CapabilityRun; step: StepTrace; review?: CapabilityRunReview; hideInput?: boolean }): React.ReactElement {
  /** 当前步骤的输出、输入、提示词与原始返回按需切换。 */
  const [view, setView] = React.useState('output')
  /** 步骤状态与耗时保留在内容上方，便于判断异常。 */
  const status = describeStepStatus(step.status)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailHeader title={step.title}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('text-[11px]', TONE_CLASS[status.tone])}>{status.label}</span>
        <span className="text-[11px] text-muted-foreground">{formatDuration(step.startedAt, step.finishedAt)}</span>
      </div>
      <p className="break-words text-[11px] text-muted-foreground">
        {step.attempts > 1 ? `尝试 ${step.attempts} 次` : '一次完成'}{step.model ? ` · ${step.model}` : ''}
      </p>
      {step.error ? <p role="alert" className="text-xs text-destructive">{step.error}</p> : null}
      {step.constraintErrors?.length ? (
        <ul className="space-y-1 text-xs text-destructive">
          {step.constraintErrors.map((message) => <li key={message}>{message}</li>)}
        </ul>
      ) : null}
      </DetailHeader>
      <Tabs value={view} onValueChange={setView} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TabsList className="m-3 h-auto max-w-full shrink-0 flex-wrap justify-start" aria-label="步骤材料">
          <TabsTrigger value="output" className="px-2 text-xs">输出</TabsTrigger>
          {review ? <TabsTrigger value="review" className="px-2 text-xs">步骤评审</TabsTrigger> : null}
          {!hideInput ? <TabsTrigger value="input" className="px-2 text-xs">输入</TabsTrigger> : null}
          {step.prompt ? <TabsTrigger value="prompt" className="px-2 text-xs">提示词</TabsTrigger> : null}
          {step.parsedOutput !== undefined && step.rawOutput !== undefined ? (
            <TabsTrigger value="raw" className="px-2 text-xs">原始返回</TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="output" className="m-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"><RunText value={stepOutput(step)} label="步骤输出" /></TabsContent>
        {review ? <TabsContent value="review" className="m-0 min-h-0 flex-1 overflow-y-auto p-3 data-[state=inactive]:hidden"><ReviewSummary run={run} review={review} isStepReview /></TabsContent> : null}
        {!hideInput ? <TabsContent value="input" className="m-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"><RunText value={step.input} label="步骤输入" empty="没有记录步骤输入。" /></TabsContent> : null}
        {step.prompt ? <TabsContent value="prompt" className="m-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"><RunText value={step.prompt} label="步骤提示词" /></TabsContent> : null}
        {step.parsedOutput !== undefined && step.rawOutput !== undefined ? (
          <TabsContent value="raw" className="m-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"><RunText value={step.rawOutput} label="步骤原始返回" /></TabsContent>
        ) : null}
      </Tabs>
    </div>
  )
}

/** 运行结果属性。 */
export interface CapabilityFactoryRunResultProps {
  run: CapabilityRun
  /** 运行结果状态行右侧的操作入口，例如开始下一轮运行。 */
  actions?: React.ReactNode
  /** 仅宿主提供当前会话时显示优化入口，不新建聊天。 */
  optimizationContext?: { sessionId: string; sceneName: string }
  /** 调用方可直接定位步骤；没有指定时优先展示评审或输出。 */
  initiallyOpenStepId?: string
  /** 调用方已展示相同输入时可隐藏步骤输入。 */
  hideStepInput?: boolean
}

/** 用记录身份隔离导航；新进度保持选择，切换历史记录重置选择。 */
export function CapabilityFactoryRunResult(props: CapabilityFactoryRunResultProps): React.ReactElement {
  return <RunDetailWorkspace key={props.run.id} {...props} />
}

/** 本轮内容与步骤组成左侧目录，右侧只挂载当前详情，避免长材料重复渲染。 */
function RunDetailWorkspace({ run, actions, initiallyOpenStepId, hideStepInput, optimizationContext }: CapabilityFactoryRunResultProps): React.ReactElement {
  /** 只有存在的步骤才能作为初始导航目标。 */
  const initialStep = run.steps.find((step) => step.stepId === initiallyOpenStepId)
  /** 未手动选择时随执行→评审阶段切换；用户点击材料后保留其阅读位置。 */
  const [selectedView, setView] = React.useState<string | null>(initialStep ? `step:${initialStep.stepId}:${run.steps.indexOf(initialStep)}` : null)
  const view = selectedView ?? (run.review ? 'review' : 'output')
  /** 输出约束、执行、内容质量三轴保持独立。 */
  const runStatus = describeRunStatus(run)
  const constraint = describeConstraintAxis(run)
  const reviewStatus = describeReviewStatus(run)
  const status = run.review?.status === 'running' ? reviewStatus : runStatus
  /** 单步历史仍以当前步骤输出为主。 */
  const focusedStep = run.kind === 'step' ? run.steps.find((step) => step.stepId === run.stepId) ?? run.steps[0] : undefined
  const outputLabel = run.kind === 'step' ? '模型返回' : '本次输出'
  /** 执行与内容评审是不同阶段；任务输入是静态材料，模型以底部标记呈现。 */
  const executionRunning = run.status === 'running'
  const reviewRunning = run.review?.status === 'running'
  /** 缺少轨迹时保留等待项；并行重复步骤使用真实索引定位详情。 */
  const navigationSteps = describeRunStepNavigation(run)
  /** 左侧菜单复用项目页签原语，键盘上下键可切换。 */
  const menuClass = 'min-h-8 w-full justify-start whitespace-normal break-words rounded-sm px-2 py-2 text-left text-xs shadow-none data-[state=active]:bg-accent data-[state=active]:shadow-none'
  /** 页签不滚动；固定标题与下方正文分别占位，代码编辑器负责自己的滚动。 */
  const panelClass = 'm-0 flex h-full min-h-0 min-w-0 flex-col overflow-hidden data-[state=inactive]:hidden [overflow-wrap:anywhere]'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" data-capability-factory-run={run.id}>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant="outline" className={cn('text-[11px]', TONE_CLASS[status.tone])}>{status.label}</Badge>
          <Badge variant="outline" className={cn('text-[11px]', TONE_CLASS[constraint.tone])}>{constraint.label}</Badge>
          {status.label !== reviewStatus.label ? <Badge variant="outline" className={cn('text-[11px]', TONE_CLASS[reviewStatus.tone])}>{reviewStatus.label}</Badge> : null}
          <span className="font-mono text-[10px] text-muted-foreground">v{run.sceneVersion}</span>
          {run.definitionTarget === 'draft' ? <Badge variant="outline" className="text-[10px]">候选草案试跑</Badge> : null}
          <span
            className="max-w-full truncate text-[10px] text-muted-foreground"
            title={`运行 ID：${run.id}`}
            aria-label={`运行记录 ${run.id}`}
          >
            记录 {run.id.slice(0, 8)} · {new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false })}
          </span>
          <span className="text-[10px] text-muted-foreground">{formatDuration(run.startedAt, run.finishedAt)}</span>
        </div>
        {actions ? <div className="ml-auto shrink-0">{actions}</div> : null}
      </div>
      {run.error ? <p role="alert" className="shrink-0 text-xs text-destructive">{run.error}</p> : null}
      {run.evidenceIssues?.length ? (
        <Collapsible className="shrink-0 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          <CollapsibleTrigger className="text-left underline underline-offset-2">证据引用待确认（{run.evidenceIssues.length} 项）：查看无法回溯的字段</CollapsibleTrigger>
          <CollapsibleContent className="max-h-36 overflow-y-auto pt-1 [overflow-wrap:anywhere]">
            <ul className="list-disc pl-4">{run.evidenceIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {run.placeholderCapabilities?.length ? (
        <p className="shrink-0 text-[11px] text-amber-600 dark:text-amber-400">{describeRunVerdict(run)} 占位桩：{run.placeholderCapabilities.join('、')}</p>
      ) : null}
      <Tabs orientation="vertical" value={view} onValueChange={setView} className="flex min-h-48 min-w-0 flex-1 overflow-hidden rounded-md border border-border/70">
        <TabsList aria-label="运行详情导航" className="h-auto w-[clamp(88px,22%,136px)] shrink-0 flex-col items-stretch justify-start gap-0.5 overflow-y-auto rounded-none border-r border-border/60 bg-muted/20 p-1.5">
          <TabsTrigger value="output" className={cn(menuClass, 'gap-1.5')}>
            <ProgressMark state={executionRunning ? 'running' : run.status === 'succeeded' ? 'done' : run.status === 'cancelled' ? 'skipped' : 'failed'} label={executionRunning ? '生成中' : runStatus.label} />
            {outputLabel}
          </TabsTrigger>
          <TabsTrigger value="review" className={cn(menuClass, 'gap-1.5')}>
            <ProgressMark state={reviewRunning ? 'running' : reviewStatus.tone === 'bad' ? 'failed' : reviewStatus.tone === 'ok' ? 'done' : executionRunning ? 'pending' : 'skipped'} label={executionRunning ? '等待评审' : reviewRunning ? '正在自动评审' : reviewStatus.label} />
            自动评审
          </TabsTrigger>
          <TabsTrigger value="input" className={menuClass}>任务输入</TabsTrigger>
          <div className="mt-2 border-t border-border/60 px-2 pb-1 pt-3 text-[10px] text-muted-foreground">
            步骤 · {navigationSteps.length}{executionRunning ? ' · 实时进度' : ''}
          </div>
          {navigationSteps.map((entry) => {
            /** 活跃项可与已完成的同 ID 并行项共存。 */
            const trace = entry.traceIndex === null ? undefined : run.steps[entry.traceIndex]
            const stepStatus = trace ? describeStepStatus(trace.status) : { label: executionRunning ? '等待' : '未执行', tone: 'idle' as const }
            /** 评审阶段在对应步骤显示进度，已完成执行的输出仍可点击阅读。 */
            const stepReview = run.stepReviews?.[entry.stepId]
            const reviewingStep = reviewRunning && stepReview?.status === 'running'
            const reviewLabel = reviewRunning && trace && (trace.type === 'llm' || trace.type === 'extract')
              ? stepReview?.status === 'running' ? '评审中' : stepReview?.status === 'succeeded' ? '评审完成' : stepReview?.status === 'failed' ? '评审失败' : stepReview?.status === 'skipped' ? '未评审' : '等待评审'
              : null
            if (!trace) {
              return (
                <div key={entry.key} className={cn(menuClass, 'flex items-start gap-1.5 text-muted-foreground', entry.active && 'bg-accent/60 text-foreground')} aria-current={entry.active ? 'step' : undefined}>
                  <span className="mt-0.5 shrink-0"><ProgressMark state={entry.active ? 'running' : executionRunning ? 'pending' : 'skipped'} label={entry.active ? '运行中' : stepStatus.label} /></span>
                  <span className="min-w-0 flex-1">{entry.title}<span className="block text-[10px] text-muted-foreground">{entry.active ? '运行中' : stepStatus.label}</span></span>
                </div>
              )
            }
            return (
              <TabsTrigger key={entry.key} value={`step:${entry.stepId}:${entry.traceIndex}`} className={cn(menuClass, 'items-start gap-1.5')} title={entry.title}>
                <span className="mt-0.5 shrink-0"><ProgressMark state={reviewingStep ? 'running' : trace.status === 'succeeded' ? 'done' : trace.status === 'skipped' ? 'skipped' : 'failed'} label={reviewingStep ? '正在评审此步骤' : stepStatus.label} /></span>
                <span className="min-w-0 flex-1">{entry.title}{reviewLabel ? <span className="block text-[10px] text-muted-foreground">{reviewLabel}</span> : null}</span>
              </TabsTrigger>
            )
          })}
        </TabsList>
        <div className="min-h-0 min-w-0 flex-1">
          <TabsContent value="output" className={panelClass}>
            <DetailHeader title={outputLabel}>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{run.review ? describeRunVerdict(run) : conciseVerdict(run)}</p>
            {run.status === 'failed' ? <p className="mb-3 text-xs text-muted-foreground">{describeRunVerdict(run)}</p> : null}
            {run.steps.length === 0 && !executionRunning ? <p className="mb-3 text-xs text-muted-foreground">没有步骤被执行。请检查输入契约、场景定义与模型配置。</p> : null}
            {focusedStep?.error ? <p className="mb-3 text-xs text-destructive">{focusedStep.error}</p> : null}
            {focusedStep?.constraintErrors?.map((error) => <p key={error} className="mb-2 text-xs text-destructive">{error}</p>)}
            </DetailHeader>
            <div className="flex min-h-0 flex-1 flex-col"><RunText value={focusedStep ? stepOutput(focusedStep) ?? run.outputs : run.outputs} label={outputLabel} empty={executionRunning ? '正在生成输出…可点击已完成步骤查看中间结果。' : undefined} /></div>
            <ModelMarker run={run} />
          </TabsContent>
          <TabsContent value="review" className={panelClass}>
            <DetailHeader title="自动评审" actions={optimizationContext ? <CapabilityFactoryOptimizeAction run={run} {...optimizationContext} /> : null} />
            <div className="min-h-0 flex-1 overflow-y-auto p-3">{run.review ? <ReviewSummary run={run} review={run.review} /> : <p className="text-xs text-muted-foreground">这条运行记录尚未评审，不能据此判断内容质量。</p>}</div>
            <ModelMarker run={run} reviewModel={run.review?.modelBinding} />
          </TabsContent>
          <TabsContent value="input" className={panelClass}>
            <DetailHeader title="任务输入" />
            <div className="flex min-h-0 flex-1 flex-col"><RunText value={run.input} label="任务输入" empty="这条记录没有保存任务输入。" /></div>
          </TabsContent>
          {run.steps.map((step, index) => (
            <TabsContent key={`${step.stepId}:${index}`} value={`step:${step.stepId}:${index}`} className={panelClass}>
              <StepDetails run={run} step={step} review={run.stepReviews?.[step.stepId]} hideInput={hideStepInput} />
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </div>
  )
}
