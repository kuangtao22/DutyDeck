/**
 * 「交付」这一整段：导出能力包 → 让用户拿到文件 → 记录导出历史。
 *
 * 三条刻意的设计：
 * ① **导出前先体检**：这份包有没有在真实数据上跑通过（`describePackageReadiness`）。
 *    未验证**不拦**（包的内容本身是完整的），但必须让人先看见风险并显式确认一次 ——
 *    否则"没验证过"会被当成"已经验过"。
 * ② **交付物真的落盘**，并给路径与「在文件夹中显示」：只有一条导出记录是拿不走东西的。
 * ③ 导出历史里记下**验证状态**：过了几周回头看，才说得清哪份包是验过的。
 */
import * as React from 'react'
import { Download, FolderOpen } from 'lucide-react'
import { describePackageReadiness } from '@proma/shared'
import type { CapabilityDelivery, CapabilityRun, CapabilityScene } from '@proma/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { describeDeliveryHint, suggestedPackageFileName } from './capability-factory-delivery-view'

/** 从任意异常里取出可读文本。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 交付区属性。 */
export interface CapabilityFactoryDeliverySectionProps {
  sessionId: string
  scene: CapabilityScene
}

/**
 * 渲染交付区。
 *
 * @param props 会话与当前场景
 * @returns 导出表单、体检结论与导出历史
 */
export function CapabilityFactoryDeliverySection({
  sessionId, scene,
}: CapabilityFactoryDeliverySectionProps): React.ReactElement {
  const [runs, setRuns] = React.useState<CapabilityRun[] | null>(null)
  const [deliveries, setDeliveries] = React.useState<CapabilityDelivery[] | null>(null)
  const [packageVersion, setPackageVersion] = React.useState('1.0.0')
  const [fileName, setFileName] = React.useState(() => suggestedPackageFileName(scene.definition.name, scene.currentVersion))
  /** 未验证时必须显式勾选才能导出 —— 让"我知道它没验证过"是一次真实的决定。 */
  const [acknowledged, setAcknowledged] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [exported, setExported] = React.useState<CapabilityDelivery | null>(null)

  /** 拉取整链运行（判断验证状态）与导出历史。 */
  const refresh = React.useCallback(async () => {
    try {
      const [history, delivered] = await Promise.all([
        window.electronAPI.capabilityFactory.invoke('listRuns', {
          sessionId, sceneId: scene.id, kind: 'full', limit: 100,
        }),
        window.electronAPI.capabilityFactory.invoke('listDeliveries', { sessionId }),
      ])
      setRuns(history)
      setDeliveries(delivered.filter((item) => item.sceneId === scene.id).reverse())
    } catch (cause) {
      setError(errorText(cause))
      setRuns([])
      setDeliveries([])
    }
  }, [scene.id, sessionId])

  React.useEffect(() => { void refresh() }, [refresh])

  const readiness = describePackageReadiness({ sceneVersion: scene.currentVersion, runs: runs ?? [] })
  const hint = describeDeliveryHint(readiness)
  const canExport = !exporting && (readiness.verified || acknowledged) && packageVersion.trim().length > 0 && fileName.trim().length > 0

  /** 导出：主进程写文件 + 记一条带验证状态的导出记录。 */
  const exportPackage = React.useCallback(async () => {
    if (!canExport) return
    setExporting(true)
    try {
      const result = await window.electronAPI.capabilityFactory.invoke('exportPackage', {
        sessionId, sceneId: scene.id, packageVersion: packageVersion.trim(), fileName: fileName.trim(),
      })
      setExported(result.delivery)
      setError(null)
      await refresh()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setExporting(false)
    }
  }, [canExport, fileName, packageVersion, refresh, scene.id, sessionId])

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[11px]">v{scene.currentVersion}</Badge>
          <span className="text-[11px] text-muted-foreground">导出的是当前生效版本的定义与提示词</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="package-version" className="text-[11px]">包版本</Label>
            <Input
              id="package-version" value={packageVersion} disabled={exporting}
              className="h-8 font-mono text-[11px]"
              onChange={(event) => setPackageVersion(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="package-file" className="text-[11px]">文件名</Label>
            <Input
              id="package-file" value={fileName} disabled={exporting}
              className="h-8 font-mono text-[11px]"
              onChange={(event) => setFileName(event.target.value)}
            />
          </div>
        </div>

        <p
          data-capability-factory-delivery-hint
          className={cn(
            'rounded-sm border px-2 py-1.5 text-[11px] leading-relaxed',
            hint.tone === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-400'
              : 'border-amber-500/45 bg-amber-500/[0.06] text-amber-700 dark:text-amber-400',
          )}
        >
          {hint.text}
        </p>

        {!readiness.verified ? (
          <label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
            <input
              type="checkbox" checked={acknowledged} disabled={exporting}
              className="mt-0.5"
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            我知道这份包还没有在真实数据上验证过，仍然导出
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
            {error}
          </p>
        ) : null}

        <Button type="button" size="sm" disabled={!canExport} onClick={() => { void exportPackage() }}>
          <Download className="size-3.5" aria-hidden="true" />
          导出能力包
        </Button>
      </div>

      {exported ? (
        <section className="space-y-1 rounded-sm border border-border/70 px-2 py-1.5" aria-label="导出结果">
          <div className="text-[11px] font-medium">已导出到</div>
          <div className="break-all font-mono text-[10px] text-muted-foreground">{exported.filePath ?? exported.fileName}</div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={cn('text-[10px]', exported.verified
              ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
              : 'border-amber-500/45 text-amber-600 dark:text-amber-400')}>
              {exported.verified ? '已验证' : '未验证'}
            </Badge>
            <Button
              type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
              onClick={() => { void window.electronAPI.capabilityFactory.invoke('revealDelivery', { sessionId, fileName: exported.fileName }) }}
            >
              <FolderOpen className="size-3" aria-hidden="true" />
              在文件夹中显示
            </Button>
          </div>
        </section>
      ) : null}

      <section className="space-y-1" aria-label="导出历史">
        <div className="text-[11px] font-medium text-muted-foreground">导出历史</div>
        {deliveries === null ? (
          <p className="text-[11px] text-muted-foreground">正在读取导出历史…</p>
        ) : deliveries.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">还没有导出过。第一次导出会把包写在本机工作区里，你再去交给关联项目。</p>
        ) : (
          <ul className="space-y-1" data-capability-factory-deliveries>
            {deliveries.map((delivery) => (
              <li key={delivery.id} className="rounded-sm border border-border/70 px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{delivery.fileName}</span>
                  <Badge variant="outline" className={cn('text-[10px]', delivery.verified
                    ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                    : 'border-amber-500/45 text-amber-600 dark:text-amber-400')}>
                    {delivery.verified ? '已验证' : '未验证'}
                  </Badge>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-muted-foreground">
                  <span>包 {delivery.packageVersion}</span>
                  <span>场景 v{delivery.sceneVersion}</span>
                  <span>{new Date(delivery.exportedAt).toLocaleString('zh-CN', { hour12: false })}</span>
                </div>
                {!delivery.verified && delivery.unverifiedReason ? (
                  <p className="mt-0.5 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">{delivery.unverifiedReason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
