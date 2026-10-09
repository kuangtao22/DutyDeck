import type * as React from 'react'
import type { CapabilityFactoryAdoptionView } from './capability-factory-approval-view'

/** 只渲染摘要内容；审批队列、按钮与提交状态沿用 Agent 的 PermissionBanner。 */
export function CapabilityFactoryAdoptionReview({ summary }: { summary: CapabilityFactoryAdoptionView }): React.ReactElement {
  return (
    <div data-testid="factory-adoption-review" className="max-h-80 space-y-3 overflow-y-auto text-xs leading-5">
      {summary.proposal ? (
        <div className="space-y-1">
          <p><span className="font-medium text-foreground">要解决的问题（Agent 判断）：</span>{summary.proposal.problem}</p>
          <p><span className="font-medium text-foreground">预期收益（待验证）：</span>{summary.proposal.expectedBenefit}</p>
          {summary.proposal.risk && <p><span className="font-medium text-foreground">取舍与风险：</span>{summary.proposal.risk}</p>}
        </div>
      ) : summary.rationale ? (
        <p><span className="font-medium text-foreground">草案说明：</span>{summary.rationale}</p>
      ) : null}
      {summary.changes.length > 0 && (
        <section className="space-y-1">
          <p className="font-medium text-foreground">本次改动</p>
          {summary.changes.slice(0, 2).map((change, index) => <p key={index} className="whitespace-pre-wrap break-words">{change}</p>)}
          {summary.changes.length > 2 && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">查看其余 {summary.changes.length - 2} 项改动</summary>
              {summary.changes.slice(2).map((change, index) => <p key={index} className="mt-1 whitespace-pre-wrap break-words">{change}</p>)}
            </details>
          )}
        </section>
      )}
      {summary.benefits.length > 0 && <p><span className="font-medium text-foreground">测试已证明：</span>{summary.benefits.join('；')}</p>}
      {summary.currentProblems.length > 0 && <p><span className="font-medium text-foreground">当前版测试问题：</span>{summary.currentProblems.join('；')}</p>}
      {summary.remainingRisks.length > 0 && <p><span className="font-medium text-foreground">仍有局限：</span>{summary.remainingRisks.join('；')}</p>}
      <p className="text-muted-foreground"><span className="font-medium">验证状态：</span>{summary.validation}</p>
    </div>
  )
}
