/**
 * 「提交任务」弹窗：把一份输入交给场景跑一次。
 *
 * 一个编辑框承载任务内容；按输入契约映射正文或解析完整 JSON，失败原因就地显示。
 * 表单与弹窗外壳拆两层是为了能测：Radix 弹窗走 Portal，SSR 下取不到内容。
 */
import * as React from 'react'
import { LoaderCircle, Play } from 'lucide-react'
import type { CapabilitySavedTask, CapabilitySceneDefinition } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CapabilityTaskEditor } from './CapabilityTaskEditor'
import { namedFields } from './capability-factory-run-view'
import { inspectTaskContent, parseSavedTaskInput, savedTaskDraft, savedTaskLabel, taskInputMapping, taskInputTemplate, taskTextField } from './capability-factory-task-input'

/** 提交表单属性。 */
export interface CapabilityFactorySubmitFormProps {
  definition: CapabilitySceneDefinition
  submitting: boolean
  /** 上一次运行失败的原因（来自运行记录，不是表单错误）。 */
  error: string | null
  onSubmit: (input: Record<string, unknown>) => void
  onClose: () => void
  /** 当前场景保存的任务，按最近提交排序。 */
  savedTasks?: CapabilitySavedTask[]
}

/**
 * 渲染提交表单。
 *
 * @param props 场景定义、提交状态与回调
 * @returns 可直接渲染验证的表单内容
 */
export function CapabilityFactorySubmitForm({
  definition, submitting, error, onSubmit, onClose, savedTasks = [],
}: CapabilityFactorySubmitFormProps): React.ReactElement {
  /** 再次打开默认选择最近任务；可切到新任务开始另一份输入。 */
  const [taskId, setTaskId] = React.useState(savedTasks[0]?.id ?? 'new-task')
  const selectedTask = savedTasks.find((task) => task.id === taskId)
  /** 单框原始文本与显式格式；输入过程中不猜测或改写正文。 */
  const [draft, setDraft] = React.useState(() => savedTaskDraft(definition, savedTasks[0]?.input))
  const [formErrors, setFormErrors] = React.useState<string[]>([])
  const fieldIdPrefix = React.useId()
  /** 可直接接收正文的字段；复杂场景仍在一个框中编辑完整结构。 */
  const textField = taskTextField(definition)
  /** 长文输入优先响应键盘，格式标记在延迟渲染中计算；提交仍校验最新内容。 */
  const deferredContent = React.useDeferredValue(draft.content)
  const inspection = React.useMemo(() => inspectTaskContent(deferredContent), [deferredContent])
  /** 自动识别只显示格式，变量用途另行标明，允许用户纠正有歧义的 JSON。 */
  const mapping = taskInputMapping(definition, draft, inspection)
  const formatLabel = { empty: '待识别', text: '文本', json: 'JSON', markdown: 'Markdown' }[inspection.format]

  return (
    <form
      className="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden"
      aria-busy={submitting}
      onSubmit={(event) => {
        event.preventDefault()
        if (submitting) return
        const parsed = parseSavedTaskInput(definition, draft)
        setFormErrors(parsed.errors)
        if (parsed.errors.length > 0) return
        onSubmit(parsed.input)
      }}
    >
      {/* 整个编辑区共用纵向滚动，短窗口下保留底部操作；min-w-0 允许长任务标题收缩。 */}
      <div className="min-h-0 min-w-0 space-y-4 overflow-y-auto overflow-x-hidden pr-1">
      {savedTasks.length > 0 ? (
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`${fieldIdPrefix}-task`} className="text-xs">已保存任务</Label>
          <Select value={taskId} disabled={submitting} onValueChange={(id) => {
            setTaskId(id)
            setDraft(savedTaskDraft(definition, savedTasks.find((task) => task.id === id)?.input))
            setFormErrors([])
          }}>
            <SelectTrigger id={`${fieldIdPrefix}-task`} className="min-w-0 max-w-full text-xs [&>span]:min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-64 w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] [&_[role=option]]:break-words [&_[role=option]]:[overflow-wrap:anywhere]">
              <SelectItem value="new-task">新任务</SelectItem>
              {savedTasks.map((task) => (
                <SelectItem key={task.id} value={task.id} className="text-xs">
                  {savedTaskLabel(task.input)} · {new Date(task.updatedAt).toLocaleDateString('zh-CN')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="space-y-1 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
        <p>{selectedTask ? '使用当前提示词和评审标准重新运行；修改内容会另存任务。' : '提交后自动保存，下次可直接选择运行。'}</p>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor={`${fieldIdPrefix}-content`} className="text-xs">任务内容</Label>
          <div className="flex items-center gap-2">
            <span role="status" className="text-[11px] text-muted-foreground">{formatLabel}</span>
            <Select value={draft.format} disabled={submitting} onValueChange={(format) => {
              if (format !== 'auto' && format !== 'text' && format !== 'json') return
              /** 切换解释方式不改写原文，错误由提交校验反馈。 */
              setDraft({ ...draft, format })
              setFormErrors([])
            }}>
              <SelectTrigger aria-label="输入识别方式" className="h-7 w-auto gap-1 border-0 px-2 text-[11px] shadow-none"><SelectValue>{{ auto: '自动识别', text: '作为正文', json: '完整输入' }[draft.format]}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">自动识别</SelectItem>
                {textField ? <SelectItem value="text">作为正文</SelectItem> : null}
                <SelectItem value="json">完整输入</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <CapabilityTaskEditor
          key={taskId}
          id={`${fieldIdPrefix}-content`}
          describedBy={`${fieldIdPrefix}-hint`}
          invalid={formErrors.length > 0}
          value={draft.content}
          disabled={submitting}
          format={inspection.format === 'markdown' ? 'markdown' : draft.format === 'json' || inspection.format === 'json' || /^\s*[\[{]/.test(deferredContent) ? 'json' : 'text'}
          onChange={(content) => {
            setDraft({ ...draft, content })
            setFormErrors([])
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-1">
          <p id={`${fieldIdPrefix}-hint`} className="text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {mapping === 'text'
              ? '内容将原样作为正文传入，保留格式与换行。'
              : '完整输入 · JSON：按场景字段传入；可粘贴 JSON 代码块。'}
          </p>
          {mapping === 'text' && textField && namedFields(definition.inputs).length > 1 ? (
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-muted-foreground" disabled={submitting}
              onClick={() => {
                /** 展开同一编辑框中的完整结构，正文与可选字段都保留。 */
                setDraft({ format: 'json', content: JSON.stringify({ ...taskInputTemplate(definition), [textField.name]: draft.content }, null, 2) })
                setFormErrors([])
              }}>
              补充其他输入
            </Button>
          ) : null}
        </div>
        {mapping === 'json' ? (
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">输入说明</summary>
            <ul className="mt-2 space-y-1 [overflow-wrap:anywhere]">
              {namedFields(definition.inputs).map((field) => (
                <li key={field.name}>{field.name} · {field.type} · {field.required !== false && !field.nullable ? '必填' : '可选'}{field.description ? `：${field.description}` : ''}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      {formErrors.length > 0 ? (
        <ul role="alert" className="space-y-0.5 text-[11px] leading-relaxed text-destructive [overflow-wrap:anywhere]">
          {formErrors.map((message) => <li key={message}>· {message}</li>)}
        </ul>
      ) : null}
      {error ? <p role="alert" className="text-[11px] leading-relaxed text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={onClose}>
          取消
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <Play className="size-3.5" aria-hidden="true" />}
          开始运行
        </Button>
      </div>
    </form>
  )
}

/** 提交弹窗属性。 */
export interface CapabilityFactorySubmitDialogProps {
  open: boolean
  definition: CapabilitySceneDefinition
  submitting: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (input: Record<string, unknown>) => void
  /** null 表示仍在读取，避免表单初始化后才拿到最近任务。 */
  savedTasks?: CapabilitySavedTask[] | null
  tasksError?: string | null
  onRetryTasks?: () => void
}

/**
 * 渲染提交弹窗。
 *
 * @param props 开关、场景定义、提交状态与回调
 * @returns 受控弹窗；关闭时不产生任何可见内容
 */
export function CapabilityFactorySubmitDialog({
  open, definition, submitting, error, onOpenChange, onSubmit, savedTasks = [], tasksError, onRetryTasks,
}: CapabilityFactorySubmitDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && submitting) return; onOpenChange(next) }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden">
        <DialogHeader className="min-w-0 shrink-0 pr-6">
          <DialogTitle>提交任务</DialogTitle>
          <DialogDescription>
            任务保存在当前场景，每次运行与评测的结果独立记录。
          </DialogDescription>
        </DialogHeader>
        {tasksError ? (
          <div className="min-h-0 space-y-2 overflow-y-auto">
            <p role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">{tasksError}</p>
            <Button type="button" variant="outline" size="sm" onClick={onRetryTasks}>重新读取</Button>
          </div>
        ) : savedTasks === null ? (
          <p role="status" className="text-xs text-muted-foreground">正在读取已保存任务…</p>
        ) : <CapabilityFactorySubmitForm
          definition={definition}
          submitting={submitting}
          error={error}
          onSubmit={onSubmit}
          onClose={() => onOpenChange(false)}
          savedTasks={savedTasks}
        />}
      </DialogContent>
    </Dialog>
  )
}
