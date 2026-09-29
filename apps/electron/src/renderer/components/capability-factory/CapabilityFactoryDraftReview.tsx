/**
 * 面板里的「待采纳草案」区 —— **人在这一侧做采纳决定的唯一地方**。
 *
 * 为什么它必须存在：Agent 只能写草案（facade 刻意没有 adopt 方法），所以「采纳」是人工动作；
 * 如果面板不给这个按钮，整条闭环就是死的 —— 2026-09-28 的真实故障正是如此：
 * Agent 写好了草案并让用户去面板采纳，而面板里既没有草案也没有按钮。
 *
 * 改动清单用的是**和审批卡同一个** `diffSceneDefinition`（共享层），
 * 所以「Agent 提交前看到的」与「人采纳前看到的」是同一份措辞。
 */
import * as React from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { diffSceneDefinition } from '@proma/shared'
import type { CapabilityScene } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

/** 草案来源的中文说法；Agent 与人工产生的草案要能一眼分开。 */
function sourceLabel(source: 'agent' | 'human'): string {
  return source === 'agent' ? '来自 Agent' : '来自你'
}

/** 待采纳草案区属性。 */
export interface CapabilityFactoryDraftReviewProps {
  /** 当前场景；没有草案时整块不渲染。 */
  scene: CapabilityScene
  /** 采纳 / 放弃进行中：两个按钮都锁住，避免重复提交。 */
  busy: boolean
  /** 上一次采纳或放弃失败的原因。 */
  error?: string | null
  onAdopt: () => void
  onDiscard: () => void
}

/**
 * 渲染待采纳草案：来源与说明、改动清单、草案内容、采纳 / 放弃。
 *
 * @param props 场景、提交状态与两个回调
 * @returns 没有草案时为 null
 */
export function CapabilityFactoryDraftReview({
  scene, busy, error, onAdopt, onDiscard,
}: CapabilityFactoryDraftReviewProps): React.ReactElement | null {
  const draft = scene.draft
  if (!draft) return null

  const nextVersion = scene.currentVersion + 1
  const changes = diffSceneDefinition(scene.definition, draft.definition)
  const { acceptance, steps } = draft.definition
  /** 新场景按步骤汇总数量，旧草案继续读取顶层兼容字段。 */
  const reviewCount = draft.definition.stepAcceptances === undefined
    ? { criteria: acceptance.criteria.length, metrics: acceptance.metrics.length }
    : Object.values(draft.definition.stepAcceptances).reduce((total, item) => ({
      criteria: total.criteria + item.criteria.length,
      metrics: total.metrics + item.metrics.length,
    }), { criteria: 0, metrics: 0 })

  return (
    <section
      className="rounded-lg border border-border/60 bg-muted/30 p-3"
      aria-label="待采纳草案"
      data-capability-factory-draft
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium">草案 v{nextVersion}</span>
        <span className="text-xs text-muted-foreground">{sourceLabel(draft.source)} · {changes.length} 项改动</span>
      </div>

      {draft.note ? (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{draft.note}</p>
      ) : null}

      <Collapsible className="mt-2">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="px-0 text-muted-foreground">查看改动<ChevronDown aria-hidden="true" /></Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 pb-2 pt-2">
      <div>
        <div className="text-[11px] font-medium text-muted-foreground">改了什么</div>
        {changes.length === 0 ? (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            与当前生效版本没有差异（可能是只改了评审口径之外的字段）。
          </p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {changes.map((change) => (
              <li key={`${change.kind}:${change.detail}`} className="text-[11px] leading-relaxed text-muted-foreground">
                · {change.detail}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-2.5">
        <div className="text-[11px] font-medium text-muted-foreground">
          草案内容（{steps.length} 步 · 各步骤评审共 {reviewCount.criteria} 条判据 · {reviewCount.metrics} 个指标）
        </div>
        {steps.length === 0 ? (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">草案还没有步骤。</p>
        ) : (
          <ol className="mt-1 space-y-1">
            {steps.map((step, index) => (
              <li key={step.id} className="flex items-center gap-2 rounded-sm border border-border/70 bg-background px-2 py-1.5">
                <span className="font-mono text-[10px] text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[12px]">{step.title}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{step.type}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
        </CollapsibleContent>
      </Collapsible>

      {error ? (
        <p role="alert" className="mt-2 text-[11px] leading-relaxed text-destructive">{error}</p>
      ) : null}

      <div className="mt-2.5 flex items-center gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onAdopt}>
          <Check className="size-3.5" aria-hidden="true" />
          采纳 v{nextVersion}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>
          放弃草案
        </Button>
      </div>
    </section>
  )
}
