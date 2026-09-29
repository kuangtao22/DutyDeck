/**
 * 新建场景弹窗。
 *
 * 为什么是弹窗、不是抽屉底部的常驻输入行：新建是低频动作，却会让抽屉永远多出一行
 * 「列表 + 表单」两层结构，焦点从浏览场景被拉到填表上；弹窗还天然带上遮罩，
 * 填名字时不会误点别的场景。运维的「添加项目」也是弹窗（`ServerOpsProjectDialog`），保持一致。
 *
 * 输入草稿只在这一次弹窗内存活：打开时清空，提交失败时保留（人不用重打一遍）。
 */
import * as React from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** 新建场景表单属性。 */
export interface CapabilityFactorySceneFormProps {
  /** 提交进行中：输入禁用、按钮转圈，并且**不允许 Esc / 点遮罩关掉**，避免刚填的名字半途丢掉。 */
  submitting: boolean
  /** 上一次提交失败的原因；面板传入，弹窗只负责显示。 */
  error: string | null
  onSubmit: (name: string) => void
  onClose: () => void
}

/**
 * 渲染新建场景表单（名称 + 取消 / 创建）。
 *
 * 单独导出**不是**为了复用，而是为了能测：Radix 弹窗走 Portal，SSR 下取不到内容
 * （仓库里 `ConfirmDialog` 的测试同样绕开 Portal）。表单被弹窗卸载时输入草稿自然清空，
 * 所以这里不需要"打开时重置"这类副作用。
 *
 * @param props 提交状态、错误与回调
 * @returns 可直接渲染验证的表单内容
 */
export function CapabilityFactorySceneForm({
  submitting, error, onSubmit, onClose,
}: CapabilityFactorySceneFormProps): React.ReactElement {
  /** 场景名草稿；弹窗关闭时整个表单被卸载，下次打开自然是空的。 */
  const [name, setName] = React.useState('')
  /** 稳定的字段标识，多 Pane 并存时不会串到另一个弹窗。 */
  const nameId = React.useId()
  /** 中文输入法确认候选时会带一个 Enter，这个 Enter 不能当成提交。 */
  const composingRef = React.useRef(false)

  return (
    <form
      className="space-y-4"
      aria-busy={submitting}
      onSubmit={(event) => {
        event.preventDefault()
        if (submitting || composingRef.current) return
        const trimmed = name.trim()
        if (trimmed.length === 0) return
        onSubmit(trimmed)
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={nameId}>场景名称</Label>
        <Input
          id={nameId}
          name="sceneName"
          autoFocus
          required
          maxLength={60}
          value={name}
          placeholder="例如：小说角色提取"
          disabled={submitting}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${nameId}-error` : undefined}
          onChange={(event) => setName(event.target.value)}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || composingRef.current)) event.preventDefault()
          }}
        />
        <p className="text-xs text-muted-foreground">最多 60 个字符；重名不拦，但列表里不好分辨。</p>
      </div>
      {error ? (
        <p id={`${nameId}-error`} role="alert" className="text-xs leading-5 text-destructive">{error}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={onClose}>
          取消
        </Button>
        <Button type="submit" size="sm" disabled={submitting || name.trim().length === 0}>
          {submitting ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          创建场景
        </Button>
      </div>
    </form>
  )
}

/** 新建场景弹窗属性。 */
export interface CapabilityFactorySceneDialogProps {
  open: boolean
  /** 提交进行中时不允许 Esc / 点遮罩关掉，避免刚填的名字半途丢掉。 */
  submitting: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => void
}

/**
 * 渲染新建场景弹窗。
 *
 * @param props 开关、提交状态、错误与提交回调
 * @returns 受控弹窗；关闭时不产生任何可见内容
 */
export function CapabilityFactorySceneDialog({
  open, submitting, error, onOpenChange, onSubmit,
}: CapabilityFactorySceneDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && submitting) return; onOpenChange(next) }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>新建编排场景</DialogTitle>
          <DialogDescription>
            先给场景起个名字，流程与提示词可以让左侧 Agent 来设计。
          </DialogDescription>
        </DialogHeader>
        <CapabilityFactorySceneForm
          submitting={submitting}
          error={error}
          onSubmit={onSubmit}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
