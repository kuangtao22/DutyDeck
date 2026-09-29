/**
 * 工作区实体切换菜单（运维项目 / 编排场景共用）。
 *
 * 为什么是「触发器由调用方渲染、菜单完全共用」：
 * 两个调用点的触发器外观本就该不同——运维在工具栏里用带边框的小按钮，
 * 能力工厂在面板标题里用无边框的标题式按钮——但**菜单必须一模一样**，
 * 否则同一种交互在不同模块里长得不一样，用户会怀疑是两个功能。
 *
 * 因此这里只统一菜单：单选语义、宽度跟随触发器、层级、滚动上限、分隔与尾随操作。
 */
import * as React from 'react'
import { Plus, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** 菜单中的一个条目。 */
export interface WorkspaceEntitySelectorItem {
  id: string
  name: string
  /** 右侧次要标记，例如版本号；省略时只显示名称。 */
  meta?: React.ReactNode
}

/** 菜单尾部的「管理」入口；省略时不渲染。 */
export interface WorkspaceEntitySelectorManage {
  label: string
  onSelect: () => void
}

/**
 * 菜单尾部的「新建」入口。
 *
 * 输入状态由调用方持有：调用方同时还负责错误处理与刷新列表，
 * 把状态留在它那里比在这里维护一份影子状态更不容易出现不一致。
 */
export interface WorkspaceEntitySelectorCreate {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  placeholder: string
  ariaLabel: string
  /** 提交进行中或名称为空时禁用按钮。 */
  disabled: boolean
}

/** 切换菜单属性。 */
export interface WorkspaceEntitySelectorProps {
  items: readonly WorkspaceEntitySelectorItem[]
  /** 当前选中项；为空表示未选中。 */
  value: string | null
  onSelect: (id: string) => void
  /**
   * 触发器由调用方渲染，同时拿到 **回调 ref** 以便菜单关闭后还能把焦点还给它。
   *
   * 用回调 ref 而不是 `RefObject`：`LegacyRef` 与 React 19 的 `RefObject<T | null>`
   * 对 `current` 的可空性要求相反，回调 ref 在两种类型下都成立。
   */
  trigger: (ref: (node: HTMLButtonElement | null) => void) => React.ReactElement
  /** 没有条目时显示的禁用项。 */
  emptyLabel: string
  manage?: WorkspaceEntitySelectorManage
  create?: WorkspaceEntitySelectorCreate
}

/**
 * 渲染统一的实体切换菜单。

 * @param props 条目、当前值、触发器渲染函数与可选的尾随操作
 * @returns 与运维项目切换完全一致的菜单
 */
export function WorkspaceEntitySelector({
  items, value, onSelect, trigger, emptyLabel, manage, create,
}: WorkspaceEntitySelectorProps): React.ReactElement {
  /** 抽屉类操作在菜单关闭后才执行，需要一个稳定的焦点回退目标。 */
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  /** 稳定的回调 ref：避免每次渲染都重新挂载触发器的 ref。 */
  const assignTriggerRef = React.useCallback((node: HTMLButtonElement | null): void => { triggerRef.current = node }, [])
  /** 记录本次关闭是否由「管理」触发，只有它需要先还原焦点。 */
  const manageRequestedRef = React.useRef(false)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{trigger(assignTriggerRef)}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="z-[240] min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[calc(100vw-2rem)]"
        onCloseAutoFocus={(event) => {
          if (!manageRequestedRef.current) return
          /** 先阻止 Radix 的默认聚焦，再把焦点还给触发器，最后才打开下一层界面。 */
          event.preventDefault()
          manageRequestedRef.current = false
          triggerRef.current?.focus()
          manage?.onSelect()
        }}
      >
        <div className="max-h-72 overflow-y-auto">
          <DropdownMenuRadioGroup value={value ?? ''} onValueChange={(id) => { if (id !== value) onSelect(id) }}>
            {items.map((entry) => (
              <DropdownMenuRadioItem key={entry.id} value={entry.id} title={entry.name} className="text-xs">
                <span className="flex-1 truncate">{entry.name}</span>
                {entry.meta ? <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{entry.meta}</span> : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {items.length === 0 ? <DropdownMenuItem disabled className="text-xs">{emptyLabel}</DropdownMenuItem> : null}
        </div>
        {manage || create ? <DropdownMenuSeparator /> : null}
        {manage ? (
          <DropdownMenuItem className="text-xs" onSelect={() => { manageRequestedRef.current = true }}>
            <Settings2 className="size-3.5" aria-hidden="true" />
            {manage.label}
          </DropdownMenuItem>
        ) : null}
        {create ? (
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <input
              value={create.value}
              onChange={(event) => create.onChange(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !create.disabled) create.onSubmit() }}
              placeholder={create.placeholder}
              className="h-7 min-w-0 flex-1 rounded-sm border border-input bg-background px-2 text-xs outline-none focus-visible:border-foreground/35"
            />
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={create.ariaLabel}
              disabled={create.disabled}
              onClick={create.onSubmit}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
