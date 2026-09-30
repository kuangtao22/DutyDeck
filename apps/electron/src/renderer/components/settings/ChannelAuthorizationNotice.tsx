import * as React from 'react'
import { CheckCircle2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** 授权成功后的持续反馈；模型数量来自保存后的当前渠道。 */
interface ChannelAuthorizationNoticeProps {
  /** 当前账号已启用模型数量，零表示授权成功但暂无模型权限。 */
  enabledModelCount: number
  /** 用户进入渠道详情查看模型。 */
  onViewModels: () => void
  /** 用户关闭本次成功反馈。 */
  onDismiss: () => void
}

/** 显示 Copilot 已保存状态，区分有模型与空目录，避免误导用户。 */
export function ChannelAuthorizationNotice({ enabledModelCount, onViewModels, onDismiss }: ChannelAuthorizationNoticeProps): React.ReactElement {
  return (
    <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">GitHub Copilot 已授权并保存</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {enabledModelCount > 0
            ? `${enabledModelCount} 个模型已启用，现在可在 Agent 的模型选择器中使用。`
            : '当前订阅暂无可用模型，请检查 GitHub 套餐或组织模型权限。'}
        </p>
        <Button type="button" variant="link" size="sm" className="h-7 px-0" onClick={onViewModels}>查看模型</Button>
      </div>
      <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label="关闭授权反馈" onClick={onDismiss}>
        <X className="size-4" />
      </Button>
    </div>
  )
}
