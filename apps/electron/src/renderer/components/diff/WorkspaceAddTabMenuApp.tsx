import * as React from 'react'
import {
  Blocks,
  Braces,
  CalendarDays,
  Clock,
  Factory,
  FolderOpen,
  Globe,
  ListTodo,
  MessageCircle,
  Server,
  ServerCog,
  SquareTerminal,
  Workflow,
  Brain,
} from 'lucide-react'
import type { WorkspaceMenuActionId, WorkspaceMenuEntryInput } from '@proma/shared'
import { ObsidianIcon } from '@/components/obsidian/obsidian-brand'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { applyThemeToDOM, initializeTheme } from '@/atoms/theme'
import { THEME_STYLES } from '@/types/settings'
import type { ThemeMode, ThemeStyle } from '@/types/settings'

/** 菜单子窗口复用应用设置与系统主题，保证特殊主题也能一致显示。 */
interface WorkspaceMenuThemeState {
  mode: ThemeMode
  style: ThemeStyle
  systemIsDark: boolean
}

/** 读取主窗口共享的主题缓存，设置无效或存储不可用时回落默认值。 */
function getInitialWorkspaceMenuTheme(): WorkspaceMenuThemeState {
  let mode: ThemeMode = 'dark'
  let style: ThemeStyle = 'default'
  try {
    /** 缓存用于首帧呈现，随后仍以主进程设置和系统主题事件为准。 */
    const cachedMode = localStorage.getItem('proma-theme-mode')
    const cachedStyle = localStorage.getItem('proma-theme-style')
    if (cachedMode === 'light' || cachedMode === 'dark' || cachedMode === 'system' || cachedMode === 'special') {
      mode = cachedMode
    }
    if ((THEME_STYLES as readonly string[]).includes(cachedStyle ?? '')) {
      style = cachedStyle as ThemeStyle
    }
  } catch {
    /** localStorage 不可用时，主题初始化会继续通过主进程读取正式设置。 */
  }
  return { mode, style, systemIsDark: window.matchMedia('(prefers-color-scheme: dark)').matches }
}

/** 显示每个菜单动作在 Proma 原菜单中使用的同款图标。 */
function getWorkspaceMenuIcon(id: WorkspaceMenuActionId): React.ReactNode {
  switch (id) {
    case 'new-browser-tab': return <Globe aria-hidden="true" />
    case 'open-file': return <FolderOpen aria-hidden="true" />
    case 'new-terminal': return <SquareTerminal aria-hidden="true" />
    case 'open-todos': return <ListTodo aria-hidden="true" />
    case 'open-calendar': return <CalendarDays aria-hidden="true" />
    case 'open-skills': return <Blocks aria-hidden="true" />
    case 'open-mcp': return <ServerCog aria-hidden="true" />
    case 'open-memory': return <Brain aria-hidden="true" />
    case 'open-chat': return <MessageCircle aria-hidden="true" />
    case 'open-automations': return <Clock aria-hidden="true" />
    case 'open-vault': return <ObsidianIcon className="size-4" aria-hidden="true" />
    case 'open-canvas': return <Workflow aria-hidden="true" />
    case 'open-server-ops': return <Server aria-hidden="true" />
    case 'open-api-workbench': return <Braces aria-hidden="true" />
    case 'open-capability-factory': return <Factory aria-hidden="true" />
    default: return null
  }
}

/** 初始化主题并在此轻量窗口关闭时解绑跨窗口主题监听。 */
function WorkspaceMenuThemeInitializer(): null {
  /** 缓存让窗口在主进程 settings IPC 返回前就使用当前主题。 */
  const [theme, setTheme] = React.useState<WorkspaceMenuThemeState>(getInitialWorkspaceMenuTheme)

  React.useEffect(() => {
    /** StrictMode 下确保第一次卸载不会遗留系统主题监听器。 */
    let mounted = true
    let dispose: (() => void) | undefined
    void initializeTheme(
      (mode) => setTheme((current) => ({ ...current, mode })),
      (systemIsDark) => setTheme((current) => ({ ...current, systemIsDark })),
      (style) => setTheme((current) => ({ ...current, style })),
    ).then((cleanup) => {
      if (mounted) dispose = cleanup
      else cleanup()
    })
    return () => {
      mounted = false
      dispose?.()
    }
  }, [])

  React.useEffect(() => {
    applyThemeToDOM(theme.mode, theme.style, theme.systemIsDark)
  }, [theme])

  return null
}

/** 使用主应用 DropdownMenu 样式呈现浮层，并把选择动作交回主窗口。 */
export function WorkspaceAddTabMenuApp(): React.ReactElement {
  /** 子窗口预热后由主进程推送本次菜单内容，避免重复加载页面。 */
  const [entries, setEntries] = React.useState<WorkspaceMenuEntryInput[]>([])
  /** 保持 Radix 菜单与主进程窗口显示状态同步。 */
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    /** 先订阅更新再回报 ready，避免预热完成前丢失第一次菜单内容。 */
    const dispose = window.electronAPI.onWorkspaceMenuEntriesChanged((nextEntries) => {
      /** null 表示主进程已隐藏菜单，renderer 同步卸载所有操作项。 */
      const visibleEntries = nextEntries ?? []
      setEntries(visibleEntries)
      setOpen(visibleEntries.length > 0)
    })
    window.electronAPI.notifyWorkspaceMenuReady()
    return dispose
  }, [])

  return (
    <>
      <WorkspaceMenuThemeInitializer />
      <DropdownMenu
        open={open}
        modal={false}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen)
          if (!nextOpen) void window.electronAPI.dismissWorkspaceMenu()
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="absolute left-3 top-3 size-px opacity-0"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={0}
          avoidCollisions={false}
          className="w-[228px] titlebar-no-drag"
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            setOpen(false)
            void window.electronAPI.dismissWorkspaceMenu()
          }}
        >
          {entries.map((entry, index) => entry.type === 'separator'
            ? <DropdownMenuSeparator key={`separator-${index}`} />
            : (
              <DropdownMenuItem
                key={entry.id}
                disabled={entry.disabled}
                data-workspace-menu-action={entry.id}
                onSelect={() => { void window.electronAPI.selectWorkspaceMenuAction(entry.id) }}
              >
                {getWorkspaceMenuIcon(entry.id)}
                {entry.label}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
