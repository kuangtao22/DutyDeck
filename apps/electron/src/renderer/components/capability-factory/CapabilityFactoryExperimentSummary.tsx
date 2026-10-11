/** 优化实验只读摘要；运行完成与采纳资格分开，不把未知费用显示为零。 */
import * as React from 'react'
import type { CapabilityFactoryExperimentView, CapabilityExperimentStatus } from '@proma/shared'

/** 三组顺序固定，避免事后选择更好看的集合。 */
const splits = [{ id: 'optimization', label: '优化' }, { id: 'validation', label: '验证' }, { id: 'held-out', label: '留出' }] as const
/** 宿主终态对应可读名称。 */
const statusLabels: Record<CapabilityExperimentStatus, string> = {
  prepared: '待执行', optimizing: '优化组', validating: '验证组', 'held-out': '留出组', completed: '已完成',
  failed: '已停止', cancelled: '已取消', interrupted: '已中断',
}
/** 百分比只有实际数值时才显示；缺失证据不填零。 */
function percent(value: number | null): string { return value === null ? '未知' : `${(value * 100).toFixed(1)}%` }
/** 只读输入支持旧场景空状态、加载中及读取错误。 */
export interface CapabilityFactoryExperimentSummaryProps {
  experiments: readonly CapabilityFactoryExperimentView[] | null
  error?: string | null
}
/** 展示宿主冻结记录；不生成候选、不启动模型、不修改实验状态。 */
export function CapabilityFactoryExperimentSummary({ experiments, error }: CapabilityFactoryExperimentSummaryProps): React.ReactElement {
  return <section aria-label="优化实验" className="min-w-0 space-y-2 rounded-lg border border-border bg-background p-3 text-xs">
    <h3 className="font-medium">优化实验</h3>
    {error ? <p role="alert" className="break-words text-destructive">{error}</p> : null}
    {!error && experiments === null ? <p role="status" className="text-muted-foreground">正在读取实验…</p> : null}
    {experiments?.length === 0 ? <p className="text-muted-foreground">暂无优化实验。可在当前会话中让 Agent 准备样本和比较方案。</p> : null}
    {experiments?.map((experiment) => {
      /** 只累计可观察的实际传输，供应商隐藏重试另行披露。 */
      const transports = experiment.calls.reduce((sum, call) => sum + call.transportAttempts, 0)
      const completeLabels = experiment.samples.filter((sample) => sample.labelStatus === 'complete').length
      const heldOutSize = experiment.samples.filter((sample) => sample.split === 'held-out').length
      /** 最终评测开始时的暴露状态是历史事实；事后看报告仅影响后续复用资格。 */
      const evaluatedExposure = experiment.heldOutExposureAtStart ?? experiment.heldOutExposure
      const latestQuality = experiment.stages.at(-1)?.quality
      /** 留出只能引用验证冻结的同一候选，不能用两个候选拼接收益。 */
      const validationStage = experiment.stages.find((stage) => stage.split === 'validation')
      const heldOutStage = experiment.stages.find((stage) => stage.split === 'held-out')
      const sameFrozenCandidate = !!validationStage && !!heldOutStage
        && validationStage.candidateFingerprint === heldOutStage.candidateFingerprint
        && validationStage.candidateId === heldOutStage.candidateId
      return <details key={experiment.id} className="group rounded-md border border-border/70 bg-muted/20">
        <summary className="cursor-pointer list-inside break-words px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="font-medium">{statusLabels[experiment.status]}{experiment.running ? ' · 运行中' : ''}</span>
          <span className="ml-2 text-muted-foreground">v{experiment.sceneVersion} · 比较批次 {experiment.roundsUsed} / 3 · 整链额度 {experiment.runUnitsReserved} / 60</span>
        </summary>
        <div className="space-y-3 border-t border-border/60 p-3">
          {experiment.stopReason ? <p role="status" className="break-words font-medium text-foreground">停止原因：{experiment.stopReason}</p> : null}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
            {splits.map((split) => <span key={split.id}>{split.label} {experiment.samples.filter((sample) => sample.split === split.id).length} 条</span>)}
            <span>完整标签 {completeLabels} / {experiment.samples.length}</span>
          </div>
          {heldOutSize > 0 && heldOutSize <= 10 ? <p className="text-muted-foreground">小样本初步结果：留出仅 {heldOutSize} 条，不能据此承诺泛化改善。</p> : null}
          <p className="text-muted-foreground">{evaluatedExposure === 'declared-unseen'
            ? '流程留出：评测开始时声明未见；普通文件读取旁路不在隔离证明范围内。' : '留出已暴露或来源是否已见不明，仅作回归验证。'}</p>
          {experiment.heldOutExposureAtStart === 'declared-unseen' && experiment.heldOutExposure === 'exposed'
            ? <p className="text-muted-foreground">本次评测后已查看留出材料；不改变本次历史结论，但后续调参实验必须将该集合退役为已见数据。</p> : null}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <dt className="text-muted-foreground">模型调用</dt><dd>{experiment.calls.length} / {experiment.limits.maxCalls}（执行 {experiment.calls.filter((call) => call.purpose === 'execution').length}，评审 {experiment.calls.filter((call) => call.purpose === 'review').length}，重试 {experiment.calls.filter((call) => call.purpose === 'retry').length}）</dd>
            <dt className="text-muted-foreground">可观察传输</dt><dd>{transports} / {experiment.limits.maxTransportAttempts}</dd>
            <dt className="text-muted-foreground">截止时间</dt><dd>{experiment.deadlineAt === null ? '尚未启动' : new Date(experiment.deadlineAt).toLocaleString('zh-CN', { hour12: false })}</dd>
            <dt className="text-muted-foreground">实际模型</dt><dd className="break-words">{experiment.modelBindings.map((binding) => `${binding.channelName} · ${binding.modelId}`).join('；') || '未知'}</dd>
            <dt className="text-muted-foreground">评审模型</dt><dd className="break-words">{experiment.reviewModelBinding ? `${experiment.reviewModelBinding.channelName} · ${experiment.reviewModelBinding.modelId}` : '跟随执行步骤'}</dd>
            <dt className="text-muted-foreground">费用</dt><dd>费用未知；订阅不等于免费。提案 Agent 费用未归因。</dd>
            <dt className="text-muted-foreground">用量可得</dt><dd>{experiment.calls.filter((call) => call.usage !== null).length} / {experiment.calls.length} 次调用</dd>
          </dl>
          {experiment.calls.some((call) => call.hiddenRetriesPossible) ? <p className="text-muted-foreground">Pi / 供应商内部重试无法完整观测；传输次数不代表完整账单。</p> : null}
          <p className="text-muted-foreground">供应商模型修订未知；当前记录不保证跨日期完全复现。</p>
          {experiment.stages.map((stage) => <div key={stage.split} className="space-y-2 border-t border-border/60 pt-2">
            <h4 className="font-medium">{splits.find((split) => split.id === stage.split)?.label}组 · 候选 {stage.candidateId} · {stage.finishedAt === null ? '未完成' : '已结束'}</h4>
            {stage.quality ? <>
              <p>F1：{percent(stage.quality.baselineMacroF1)} → {percent(stage.quality.candidateMacroF1)}；变化 {stage.quality.f1Delta === null ? '未知' : `${(stage.quality.f1Delta * 100).toFixed(1)} 个百分点`}</p>
              <p>完整配对 {stage.quality.paired} / {stage.quality.planned}；未知 {stage.quality.unknown} / {stage.quality.planned}</p>
              <p>业务错误率范围：{percent(stage.quality.baselineErrorBounds[0])}–{percent(stage.quality.baselineErrorBounds[1])} → {percent(stage.quality.candidateErrorBounds[0])}–{percent(stage.quality.candidateErrorBounds[1])}</p>
              {stage.quality.reasons.length > 0 ? <p className="break-words text-muted-foreground">{stage.quality.reasons.join('；')}</p> : null}
            </> : <p className="text-muted-foreground">尚无完整质量结论。</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <caption className="sr-only">{stage.split} 组运行证据</caption>
                <thead><tr className="text-muted-foreground"><th scope="col" className="p-1">样本</th><th scope="col" className="p-1">基线运行</th><th scope="col" className="p-1">候选运行</th></tr></thead>
                <tbody>{stage.pairs.map((pair) => <tr key={pair.caseId} className="border-t border-border/50">
                  <th scope="row" className="max-w-40 break-all p-1 font-normal">{pair.caseId}</th>
                  <td className="max-w-40 break-all p-1">{pair.baselineRunId ?? '未完成'}</td><td className="max-w-40 break-all p-1">{pair.candidateRunId ?? '未完成'}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </div>)}
          {heldOutStage ? <p className="text-muted-foreground">{sameFrozenCandidate
            ? `验证与留出使用同一冻结候选 ${heldOutStage.candidateId}。`
            : '验证与留出的候选身份无法确认一致，不能合并收益证据。'}</p> : null}
          <p className="font-medium">{sameFrozenCandidate && experiment.status === 'completed' && latestQuality?.adoptionEligible
            ? '满足当前证据门槛；采纳仍需审核实际合并快照。' : '当前证据不能作为采纳认证。'}</p>
        </div>
      </details>
    })}
  </section>
}
