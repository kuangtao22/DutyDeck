import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Blocks, Brain, Braces, CalendarDays, Clock, Factory, FolderOpen, Globe, ListTodo, Palette, ServerCog, SquareTerminal } from 'lucide-react'
import { WorkspaceToolRail } from './WorkspaceToolRail'
import type { WorkspaceToolRailItem } from './WorkspaceToolRail'
import { ObsidianIcon } from '@/components/obsidian/obsidian-brand'
import { activeWorkspaceToolAtom, openWorkspaceToolAtom, workspaceProjectAtom, workspaceToolAvailabilityAtom, workspaceToolsExpandedAtom } from '@/atoms/workspace-tools'
import { agentWorkspacesAtom, workspaceCapabilitiesVersionAtom } from '@/atoms/agent-atoms'
import { automationsAtom } from '@/atoms/automation-atoms'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { appModeAtom } from '@/atoms/app-mode'

/** 固定入口按已确认的四组排列；图标只作装饰，业务可用性统一来自命令 atom。 */
const TOOL_ITEMS: WorkspaceToolRailItem[] = [
  { id: 'browser', label: '新建浏览器标签', group: '工作区', icon: Globe, keywords: 'browser 网页' },
  { id: 'files', label: '打开文件', group: '工作区', icon: FolderOpen, keywords: 'files 文件夹' },
  { id: 'terminal', label: '新建终端', group: '工作区', icon: SquareTerminal, keywords: 'terminal shell' },
  { id: 'todos', label: 'Todo', group: '效率', icon: ListTodo, keywords: '待办 任务' },
  { id: 'calendar', label: '日程', group: '效率', icon: CalendarDays, keywords: 'calendar' },
  { id: 'automations', label: '定时任务', group: '效率', icon: Clock, keywords: 'automation 计划' },
  { id: 'memory', label: '项目知识库', group: '知识与能力', icon: Brain, keywords: 'memory 记忆' },
  { id: 'vault', label: 'Obsidian', group: '知识与能力', icon: ObsidianIcon, keywords: 'vault 笔记' },
  { id: 'skills', label: 'Skills', group: '知识与能力', icon: Blocks, keywords: '技能' },
  { id: 'mcp', label: 'MCP', group: '知识与能力', icon: Braces, keywords: '服务 插件' },
  { id: 'canvas', label: '画布', group: '专业工具', icon: Palette, keywords: 'canvas 设计' },
  { id: 'server-ops', label: '服务器运维', group: '专业工具', icon: ServerCog, keywords: 'server ops SSH 数据库' },
  { id: 'api-workbench', label: '接口工作台', group: '专业工具', icon: Braces, keywords: 'API HTTP' },
  { id: 'capability-factory', label: '编排工厂', group: '专业工具', icon: Factory, keywords: 'factory 能力' },
]

/** 常驻工具菜单负责显示真实可用状态，资源生命周期仍由现有工作区拥有。 */
export function WorkspaceTools(): React.ReactElement {
  /** 界面状态和导航动作共享同一 Jotai store，不使用原型独立主题缓存。 */
  const [expanded, setExpanded] = useAtom(workspaceToolsExpandedAtom)
  const availability = useAtomValue(workspaceToolAvailabilityAtom)
  const activeTool = useAtomValue(activeWorkspaceToolAtom)
  const openTool = useSetAtom(openWorkspaceToolAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const automations = useAtomValue(automationsAtom)
  const projectId = useAtomValue(workspaceProjectAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom)
  const appMode = useAtomValue(appModeAtom)
  const workspaceSlug = workspaces.find((workspace) => workspace.id === projectId)?.slug
  /** 只保留当前项目的更新提示，异步读取不能覆盖已切换的项目。 */
  const [skillsHaveUpdate, setSkillsHaveUpdate] = React.useState(false)

  React.useEffect(() => {
    /** 仅项目或能力版本变化时读取一次，沿用旧左栏查询，无轮询或资源常驻。 */
    let disposed = false
    setSkillsHaveUpdate(false)
    if (appMode !== 'agent' || !workspaceSlug) return
    void window.electronAPI.getWorkspaceCapabilities(workspaceSlug)
      .then((capabilities) => {
        if (!disposed) setSkillsHaveUpdate(capabilities.skills.some((skill) => skill.hasUpdate))
      })
      .catch((error: unknown) => console.error('[工具菜单] 读取技能更新失败:', error))
    return () => { disposed = true }
  }, [appMode, workspaceSlug, capabilitiesVersion])

  /** 轻量派生最多 14 项；开关关闭的工具不展示，失效上下文给出禁用原因。 */
  const items = TOOL_ITEMS.filter((item) => availability[item.id].visible).map((item) => ({
    ...item,
    active: activeTool === item.id,
    disabledReason: availability[item.id].disabledReason,
    badge: item.id === 'automations' && automations.length > 0 ? (automations.length > 99 ? '99+' : String(automations.length)) : undefined,
    showUpdate: item.id === 'skills' && skillsHaveUpdate,
  }))

  return <WorkspaceToolRail expanded={expanded} onExpandedChange={setExpanded} items={items} onSelect={openTool} onAppearance={() => {
    setSettingsTab('appearance')
    setSettingsOpen(true)
  }} />
}
