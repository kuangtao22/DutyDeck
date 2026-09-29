/**
 * 两次单步尝试的并排对比：**回答"改了这句到底好没好"**。
 *
 * 只看这一次的返回，人是无法判断改动有没有用的 —— 尤其是模型输出有随机性时。
 * 所以对比必须同时给出三件事：提示词改了哪几行、输入是不是同一份、约束结论从什么变成了什么。
 * 三件里任何一件没说清，结论都不能归因。
 */
import * as React from 'react'
import type { CapabilityRun } from '@proma/shared'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { describeAttemptComparison } from './capability-factory-attempt-diff'
import { describeConstraintAxis, describeReviewStatus, describeRunStatus, formatDuration } from './capability-factory-run-view'

/** 结构化值转文本；字符串直接显示。 */
function pretty(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 一次尝试的表头：时间、时长、两条轴。 */
function AttemptHeader({ run, label }: { run: CapabilityRun; label: string }): React.ReactElement {
  const status = describeRunStatus(run)
  const constraint = describeConstraintAxis(run)
  const review = describeReviewStatus(run)
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="text-[10px]">{status.label}</Badge>
        <Badge variant="outline" className={cn('text-[10px]', constraint.tone === 'ok' && 'text-emerald-600 dark:text-emerald-400')}>
          {constraint.label}
        </Badge>
        <Badge variant="outline" className={cn(
          'text-[10px]',
          review.tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
          review.tone === 'bad' && 'text-destructive',
          review.tone === 'warn' && 'text-amber-600 dark:text-amber-400',
          review.tone === 'idle' && 'text-muted-foreground',
        )}>
          {review.label}
        </Badge>
      </div>
      <div className="font-mono text-[10px] text-muted-foreground">
        {new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false })}
        {' · '}{formatDuration(run.startedAt, run.finishedAt)}
      </div>
    </div>
  )
}

/** 对比视图属性。 */
export interface CapabilityFactoryAttemptCompareProps {
  /** 基线尝试（较早的那次）。 */
  baseline: CapabilityRun
  /** 当前尝试（较新的那次）。 */
  current: CapabilityRun
}

/**
 * 渲染两次尝试的对比。
 *
 * @param props 基线与当前尝试
 * @returns 提示词 diff、输入差异、约束变化与两份返回
 */
export function CapabilityFactoryAttemptCompare({
  baseline, current,
}: CapabilityFactoryAttemptCompareProps): React.ReactElement {
  const comparison = describeAttemptComparison(baseline, current)
  const baselineStep = baseline.steps[0]
  const currentStep = current.steps[0]
  /** 质量结论必须单独对比，不能用约束通过代替。 */
  const baselineReview = describeReviewStatus(baseline)
  const currentReview = describeReviewStatus(current)
  /** 评审口径属于运行时固定快照；任一字段变化都意味着质量结论不可直接横比。 */
  /** 新记录按步骤比较冻结标准；旧记录回退到聚合快照。 */
  const acceptanceSnapshot = (run: CapabilityRun): unknown => {
    const entries = Object.entries(run.stepReviews ?? {})
    return entries.length > 0
      ? Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)).map(([stepId, review]) => [stepId, review.acceptance]))
      : run.review?.acceptance ?? null
  }
  const acceptanceChanged = JSON.stringify(acceptanceSnapshot(baseline)) !== JSON.stringify(acceptanceSnapshot(current))

  return (
    <div className="space-y-2.5" data-capability-factory-attempt-compare>
      <div className="grid grid-cols-2 gap-2">
        <AttemptHeader run={baseline} label="基线（较早一次）" />
        <AttemptHeader run={current} label="当前（这次）" />
      </div>

      <div>
        <div className="text-[11px] font-medium text-muted-foreground">
          提示词变化
          {comparison.promptChanged
            ? `：新增 ${comparison.promptSummary.added} 行 · 删除 ${comparison.promptSummary.removed} 行`
            : '：没有变化 —— 这次的差异不是来自提示词，要看输入或模型随机性'}
        </div>
        {comparison.promptChanged ? (
          <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-muted px-2 py-1.5 font-mono text-[10px] leading-relaxed">
            {comparison.promptDiff.map((line, index) => (
              <div
                key={`${line.kind}-${index}`}
                className={cn(
                  line.kind === 'added' && 'text-emerald-600 dark:text-emerald-400',
                  line.kind === 'removed' && 'text-destructive',
                  line.kind === 'same' && 'text-muted-foreground',
                )}
              >
                {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                {line.text}
              </div>
            ))}
          </pre>
        ) : null}
      </div>

      <div className="text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-medium">输入：</span>
        {comparison.inputChangedKeys.length === 0
          ? '两次是同一份输入'
          : `变了 ${comparison.inputChangedKeys.join('、')} —— 结果差异可能是输入造成的`}
      </div>

      <div className="text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-medium">约束：</span>
        {comparison.constraintFrom} → {comparison.constraintTo}
        {comparison.parsedOutputUnchanged ? '；两次解析结果一致，这次改动没有影响输出' : ''}
      </div>

      <div className="text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-medium">质量：{baselineReview.label} → {currentReview.label}</span>
      </div>
      {acceptanceChanged ? (
        <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          评审标准已变化，不能把结论变化直接归因于提示词。
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        {[{ label: '基线的返回', step: baselineStep }, { label: '这次的返回', step: currentStep }].map(({ label, step }) => (
          <div key={label}>
            <div className="text-[10px] font-medium text-muted-foreground">{label}</div>
            <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-muted px-2 py-1.5 font-mono text-[10px] leading-relaxed">
              {pretty(step?.rawOutput ?? step?.parsedOutput)}
            </pre>
          </div>
        ))}
      </div>
    </div>
  )
}
