import { ArrowRight, FolderOpen, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { DefaultRootMigrationPreloadApi } from '../../../preload/default-root-migration-preload'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** 默认数据根迁移确认窗口读取的启动参数。 */
interface DefaultRootMigrationPromptProps {
  /** 当前窗口地址中的旧数据根。 */
  legacyRoot: string
  /** 当前窗口地址中的新数据根。 */
  targetRoot: string
  /** 主进程注入的最小确认 API。 */
  api: DefaultRootMigrationPreloadApi
}

/** 使用项目 Dialog 样式确认旧版数据目录是否直接移动。 */
export function DefaultRootMigrationPrompt({
  legacyRoot,
  targetRoot,
  api,
}: DefaultRootMigrationPromptProps): React.JSX.Element {
  /** 防止窗口关闭前重复提交确认结果。 */
  const [isBusy, setIsBusy] = useState(false)
  /** IPC 失败时保留弹窗，让用户可以重试或取消。 */
  const [error, setError] = useState<string | null>(null)
  /** 只有明确选择旧目录才记住拒绝；关闭手势仅结束本次提示。 */
  const choose = async (confirmed: boolean | null): Promise<void> => {
    if (isBusy) return
    setIsBusy(true)
    setError(null)
    try {
      await api.choose(confirmed)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法提交迁移选择')
      setIsBusy(false)
    }
  }
  /** 路径文本保持稳定，避免长路径撑开弹窗。 */
  const display = useMemo(() => ({ legacyRoot, targetRoot }), [legacyRoot, targetRoot])

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-8 text-foreground">
      <Dialog open onOpenChange={(open) => { if (!open) void choose(null) }}>
        <DialogContent
          hideClose
          className="max-w-lg rounded-xl"
          aria-describedby="default-root-migration-description"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl">
              <FolderOpen className="h-5 w-5 text-primary" aria-hidden="true" />
              迁移 DutyDeck 数据
            </DialogTitle>
            <DialogDescription id="default-root-migration-description" className="leading-relaxed">
              检测到旧版 Proma 数据目录。你可以把它直接移动到新的 DutyDeck 目录，应用会继续使用原有数据。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
            <PathRow label="当前目录" path={display.legacyRoot} />
            <div className="flex justify-center text-muted-foreground" aria-hidden="true">
              <ArrowRight className="h-4 w-4 rotate-90" />
            </div>
            <PathRow label="新目录" path={display.targetRoot} />
          </div>

          <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span>确认后会直接移动目录，不会复制第二份数据。你也可以继续使用旧目录，之后在设置中再处理。</span>
          </div>

          {error !== null && (
            <p role="alert" className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter className="gap-2 sm:space-x-0">
            <Button type="button" variant="outline" disabled={isBusy} onClick={() => void choose(false)}>
              继续使用旧目录
            </Button>
            <Button type="button" disabled={isBusy} onClick={() => void choose(true)}>
              {isBusy ? '正在处理…' : '移动到新目录'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

/** 展示单个数据根路径，长路径允许换行但不改变内容。 */
function PathRow({ label, path }: { label: string; path: string }): React.JSX.Element {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <code className="block break-all rounded-md bg-background/70 px-2.5 py-2 text-xs text-foreground/80">{path}</code>
    </div>
  )
}
