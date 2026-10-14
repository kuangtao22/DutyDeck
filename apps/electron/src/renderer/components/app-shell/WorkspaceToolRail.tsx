import * as React from 'react'
import { Palette, PanelRightClose, PanelRightOpen, Search, X } from 'lucide-react'
import { WORKSPACE_TOOLS_COLLAPSED_WIDTH, WORKSPACE_TOOLS_EXPANDED_WIDTH, type WorkspaceToolId } from '@/atoms/workspace-tools'
import { cn } from '@/lib/utils'

/** 展示数据由业务容器提供；禁用原因同时用于按钮状态与可访问提示。 */
export interface WorkspaceToolRailItem {
  id: WorkspaceToolId
  label: string
  group: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  active?: boolean
  disabledReason?: string
  badge?: string
  showUpdate?: boolean
  keywords?: string
}

/** 只处理菜单交互，工具生命周期和外观设置由调用方管理。 */
export interface WorkspaceToolRailProps {
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  items: WorkspaceToolRailItem[]
  onSelect: (id: WorkspaceToolId) => void
  onAppearance: () => void
}

/** 输入工具列表与查询，返回按名称、分组和别名匹配的列表，保持原始顺序。 */
export function filterWorkspaceTools(items: WorkspaceToolRailItem[], query: string): WorkspaceToolRailItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return items.filter((item) => `${item.label} ${item.group} ${item.keywords ?? ''}`.toLocaleLowerCase().includes(normalizedQuery))
}

/** 所有菜单按钮共享的主题悬停和键盘反馈，不生成会覆盖原生浏览器的浮层。 */
const buttonClass = 'group relative flex min-h-9 w-full shrink-0 items-center gap-2.5 rounded-lg text-left text-xs outline-none motion-safe:transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-40'

/** 最右侧独立占位卡片；展开只改变自身宽度，由实际布局驱动浏览器 bounds 更新。 */
export function WorkspaceToolRail({ expanded, onExpandedChange, items, onSelect, onAppearance }: WorkspaceToolRailProps): React.ReactElement {
  /** 搜索仅属于当前菜单实例，不持久化到会话配置。 */
  const [query, setQuery] = React.useState('')
  /** 展开搜索后聚焦输入框；普通展开保持触发按钮焦点。 */
  const focusSearchOnExpand = React.useRef(false)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const toggleRef = React.useRef<HTMLButtonElement>(null)
  const navRef = React.useRef<HTMLElement>(null)
  const listId = React.useId()
  const visibleItems = filterWorkspaceTools(items, expanded ? query : '')
  const groups = [...new Set(visibleItems.map((item) => item.group))]

  React.useEffect(() => {
    if (expanded && focusSearchOnExpand.current) {
      searchRef.current?.focus()
      focusSearchOnExpand.current = false
    }
    if (!expanded) setQuery('')
  }, [expanded])

  /** 搜索入口显式展开；已展开时直接聚焦输入框。 */
  function openSearch(): void {
    if (expanded) searchRef.current?.focus()
    else {
      focusSearchOnExpand.current = true
      onExpandedChange(true)
    }
  }

  /** 方向键仅导航可用工具，Escape 先清空查询，再收起菜单并恢复触发器焦点。 */
  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (query) setQuery('')
      else {
        onExpandedChange(false)
        toggleRef.current?.focus()
      }
      return
    }
    if (event.key === '/' && event.target !== searchRef.current) {
      event.preventDefault()
      openSearch()
      return
    }
    const isSearch = event.target === searchRef.current
    if (isSearch && event.key !== 'ArrowDown') return
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (!buttons.length) return
    event.preventDefault()
    const currentIndex = buttons.findIndex((button) => button === event.target)
    const nextIndex = event.key === 'Home' || isSearch ? 0
      : event.key === 'End' ? buttons.length - 1
        : event.key === 'ArrowDown' ? (currentIndex + 1) % buttons.length
          : (currentIndex < 0 ? buttons.length - 1 : (currentIndex - 1 + buttons.length) % buttons.length)
    buttons[nextIndex]?.focus()
  }

  return (
    <aside
      aria-label="统一工具菜单"
      data-workspace-tool-rail=""
      data-expanded={expanded}
      className="relative z-[60] flex min-h-0 shrink-0 bg-content-area py-3 pl-2.5 pr-3 titlebar-no-drag"
      style={{ width: expanded ? WORKSPACE_TOOLS_EXPANDED_WIDTH : WORKSPACE_TOOLS_COLLAPSED_WIDTH }}
      onKeyDown={handleKeyDown}
    >
      {/* 外层底色与相邻内容区一致；内部保留独立的灰色圆角卡片。 */}
      <div style={{ borderRadius: 18 }} className="flex min-h-0 w-full flex-col overflow-hidden border-0 bg-card shadow-[0_6px_24px_rgba(0,0,0,0.08)]">
        <header className={cn('flex h-[45px] shrink-0 items-center', expanded ? 'gap-2 px-3' : 'justify-center')}>
          {expanded && <strong className="flex-1 text-xs font-semibold">工具</strong>}
          <button ref={toggleRef} type="button" aria-label={expanded ? '收起工具菜单' : '展开工具菜单'} title={expanded ? '收起工具菜单' : '展开工具菜单'} aria-expanded={expanded} aria-controls={listId} onClick={() => onExpandedChange(!expanded)} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent-foreground/[0.08] hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            {expanded ? <PanelRightClose className="size-4" aria-hidden="true" /> : <PanelRightOpen className="size-4" aria-hidden="true" />}
          </button>
        </header>
        {expanded ? (
          <div className="mx-2 mb-2 flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-foreground/[0.04] px-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
            <Search className="size-3.5 shrink-0" aria-hidden="true" />
            <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索工具" placeholder="搜索工具" autoComplete="off" className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none" />
            {query && <button type="button" aria-label="清空搜索" onClick={() => { setQuery(''); searchRef.current?.focus() }} className="rounded p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3" aria-hidden="true" /></button>}
          </div>
        ) : (
          <button type="button" aria-label="展开并搜索工具" title="搜索工具" onClick={openSearch} className="mx-auto mb-2 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent-foreground/[0.08] hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><Search className="size-4" aria-hidden="true" /></button>
        )}
        <nav ref={navRef} id={listId} aria-label="工作区工具" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-2 [scrollbar-width:thin]">
          {groups.map((group) => (
            <section key={group} aria-label={group} className="py-2 [&+section]:border-t [&+section]:border-border/50">
              {expanded && <h3 className="mb-1.5 px-2 text-[10px] font-normal tracking-wide text-muted-foreground">{group}</h3>}
              {visibleItems.filter((item) => item.group === group).map((item) => {
                /** 工具图标由业务描述提供，保持 SVG 只作装饰。 */
                const Icon = item.icon
                return (
                  <button key={item.id} type="button" data-tool-id={item.id} aria-label={item.label} aria-pressed={Boolean(item.active)} disabled={Boolean(item.disabledReason)} title={item.disabledReason ? `${item.label}：${item.disabledReason}` : item.label} onClick={() => onSelect(item.id)} className={cn(buttonClass, 'my-0.5', expanded ? 'px-2' : 'justify-center', item.active ? 'bg-accent-foreground/[0.10] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]' : 'text-foreground/75 enabled:hover:bg-accent-foreground/[0.08] enabled:hover:text-foreground')}>
                    <Icon className={cn('size-4 shrink-0', item.active ? 'text-accent-foreground' : 'text-foreground/60 group-hover:text-foreground')} aria-hidden="true" />
                    {expanded && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                    {expanded && item.badge && <span className="rounded bg-accent-foreground/[0.08] px-1 text-[10px] tabular-nums text-muted-foreground">{item.badge}</span>}
                    {item.showUpdate && <span className={cn('size-1 rounded-full bg-accent-foreground', !expanded && 'absolute right-1 top-1.5')} aria-label="有更新" />}
                  </button>
                )
              })}
            </section>
          ))}
          {!visibleItems.length && <p role="status" className="px-2 py-8 text-center text-xs leading-6 text-muted-foreground">没有匹配的工具</p>}
        </nav>
        <footer className="mx-1.5 shrink-0 border-t border-border/50 py-2">
          <button type="button" aria-label="外观设置" title="外观设置" onClick={onAppearance} className={cn(buttonClass, 'text-foreground/75 hover:bg-accent-foreground/[0.08] hover:text-foreground', expanded ? 'px-2' : 'justify-center')}><Palette className="size-4 shrink-0" aria-hidden="true" />{expanded && <span>外观</span>}</button>
        </footer>
      </div>
    </aside>
  )
}
