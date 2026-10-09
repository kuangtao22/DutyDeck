import type { CapabilityFactoryBatchSummary } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { describeFactoryBatchStatus } from './capability-factory-batch-view'

/** 同时展示人工和 Agent 批次；选历史只读取证据，不自动重跑。 */
export function CapabilityFactoryBatchHistory({ batches, selectedId, running, onSelect, onCancel }: {
  batches: CapabilityFactoryBatchSummary[]
  selectedId?: string
  running?: CapabilityFactoryBatchSummary
  onSelect: (batchId: string) => void
  onCancel: () => Promise<void>
}): React.ReactElement | null {
  if (!batches.length) return null
  return <section className="space-y-2" aria-label="测试批次">
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="font-medium">测试批次</span>
      {running ? <div className="flex items-center gap-2"><span className="text-muted-foreground">已完成 {running.completedCount} / {running.itemCount} 条</span><Button type="button" size="sm" variant="outline" onClick={() => { void onCancel() }}>停止批次</Button></div> : null}
    </div>
    <div className="max-h-36 space-y-1 overflow-y-auto">
      {batches.map((batch) => <button type="button" key={batch.id} aria-pressed={selectedId === batch.id}
        className="flex w-full items-center justify-between gap-3 rounded-sm border border-border/60 px-2 py-1.5 text-left text-[11px] aria-pressed:bg-muted/60 hover:bg-muted/30"
        onClick={() => onSelect(batch.id)}>
        <span>{describeFactoryBatchStatus(batch.status)} · {batch.itemCount} 条{batch.adoptable ? ' · 已验证可采纳' : ''}</span>
        <span className="text-muted-foreground">{new Date(batch.startedAt).toLocaleString('zh-CN', { hour12: false })}</span>
      </button>)}
    </div>
  </section>
}
