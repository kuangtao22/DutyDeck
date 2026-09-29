/** 草案对比复用项目的代码差异视图，仅在查看改动时加载。 */
import * as React from 'react'
import { Button } from '@/components/ui/button'

/** 较重的差异渲染器不进入场景卡片首屏。 */
const DiffView = React.lazy(() => import('@/components/diff/DiffView').then((module) => ({ default: module.DiffView })))

/** 对比属性；文本由步骤弹窗或评审弹窗提供，不读取磁盘或 Git。 */
interface CapabilityFactoryDefinitionDiffProps {
  before: string
  after: string
  currentVersion: number
  fileName: string
}

/** 显示当前与草案的红绿差异；窄窗口可切换合并视图。 */
export function CapabilityFactoryDefinitionDiff({ before, after, currentVersion, fileName }: CapabilityFactoryDefinitionDiffProps): React.ReactElement {
  /** 并排便于对照原文，用户可按阅读空间切换单列。 */
  const [mode, setMode] = React.useState<'split' | 'unified'>('split')
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/60" aria-label="当前版与草案差异">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-[11px]">
      <span>当前 v{currentVersion} → 草案 v{currentVersion + 1} · 待采纳</span>
      <div className="flex gap-1">
        <Button size="sm" variant={mode === 'split' ? 'secondary' : 'ghost'} className="h-6 px-2 text-[11px]" aria-pressed={mode === 'split'} onClick={() => setMode('split')}>并排</Button>
        <Button size="sm" variant={mode === 'unified' ? 'secondary' : 'ghost'} className="h-6 px-2 text-[11px]" aria-pressed={mode === 'unified'} onClick={() => setMode('unified')}>合并</Button>
      </div>
    </div>
    {before === after ? <p className="p-3 text-xs text-muted-foreground">这部分内容没有变化。</p> : <div className="min-h-0 flex-1">
      <React.Suspense fallback={<p className="p-3 text-xs text-muted-foreground">正在加载版本对比…</p>}>
        <DiffView oldContent={before} newContent={after} filePath={fileName} viewMode={mode} overflow="wrap" />
      </React.Suspense>
    </div>}
  </div>
}
