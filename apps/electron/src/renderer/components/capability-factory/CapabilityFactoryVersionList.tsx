/**
 * 版本历史列表：**让人认出"我调好的那版"并能回到它**。
 *
 * 只列版本号没有意义（"v4" 本身不含任何信息），所以每行都带"相对上一版改了什么"。
 * 回滚按钮在当前生效版本上不出现 —— 那一版不需要回去。
 */
import * as React from 'react'
import { RotateCcw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { describeVersionHistory } from './capability-factory-version-view'
import type { CapabilitySceneVersion } from '@proma/shared'

/** 版本列表属性。 */
export interface CapabilityFactoryVersionListProps {
  versions: readonly CapabilitySceneVersion[]
  currentVersion: number
  /** 回滚进行中：按钮锁住，避免连点。 */
  busy: boolean
  onRequestRollback: (targetVersion: number) => void
}

/**
 * 渲染版本历史。
 *
 * @param props 版本历史、当前版本与回滚回调
 * @returns 新版本在前；每一版带来源、时间与相对上一版的改动
 */
export function CapabilityFactoryVersionList({
  versions, currentVersion, busy, onRequestRollback,
}: CapabilityFactoryVersionListProps): React.ReactElement {
  const rows = describeVersionHistory(versions, currentVersion)

  if (rows.length === 0) {
    return <p className="text-[11px] leading-relaxed text-muted-foreground">还没有版本历史（场景刚建时应当有 v1）。</p>
  }

  return (
    <ol className="space-y-1" data-capability-factory-versions>
      {rows.map((row) => (
        <li key={row.version} className="rounded-sm border border-border/70 px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="font-mono text-[11px]">v{row.version}</Badge>
            <span className="text-[11px] text-muted-foreground">{row.sourceLabel}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })}
            </span>
            {row.isCurrent ? <Badge variant="secondary" className="text-[10px]">当前生效</Badge> : null}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{row.changeSummary}</p>
          {row.note ? (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{row.note}</p>
          ) : null}
          {row.isCurrent ? null : (
            <Button
              type="button" size="sm" variant="ghost" className="mt-1 h-6 px-2 text-[11px]"
              disabled={busy}
              onClick={() => onRequestRollback(row.version)}
            >
              <RotateCcw className="size-3" aria-hidden="true" />
              回到 v{row.version}
            </Button>
          )}
        </li>
      ))}
    </ol>
  )
}
