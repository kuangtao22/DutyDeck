import * as React from 'react'
import type { CapabilityRun } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { insertAgentInputText } from '@/lib/agent-input-text'
import { buildOptimizationRequest, canRequestOptimization } from './capability-factory-optimize-request'

/** 将这轮结果衔接到现有会话；只追加草稿，反馈必须基于编辑器实际应答。 */
export function CapabilityFactoryOptimizeAction({ run, sessionId, sceneName }: {
  run: CapabilityRun; sessionId: string; sceneName: string
}): React.ReactElement | null {
  /** 成功后禁用重复点击；失败保留重试入口，切换运行时由父组件重建。 */
  const [state, setState] = React.useState<'idle' | 'inserted' | 'unavailable'>('idle')
  if (!canRequestOptimization(run)) return null
  // 借用标题区网格：按钮占右上角，状态说明独占下一行并与标题对齐。
  return <div className="contents">
    <Button type="button" variant="outline" size="sm" className="col-start-2 row-start-1 justify-self-end" disabled={state === 'inserted'}
      onClick={() => setState(insertAgentInputText(sessionId, buildOptimizationRequest(sceneName, run)) ? 'inserted' : 'unavailable')}>
      {state === 'inserted' ? '已填入当前会话' : '基于本轮优化'}
    </Button>
    <p role={state === 'unavailable' ? 'alert' : 'status'} className="col-span-2 row-start-2 text-left text-[11px] leading-5 text-muted-foreground">
      {state === 'inserted' ? '已追加到输入框，可补充要求后发送。' : state === 'unavailable'
        ? '当前会话输入框暂不可用，请打开对应会话后重试。' : '填入当前会话，由你补充后发送。'}
    </p>
  </div>
}
