import { atom } from 'jotai'
import type { createStore } from 'jotai'
import { atomFamily } from 'jotai-family'
import {
  agentDiffPanelTabAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
  agentSidePanelOpenAtomFamily,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  currentSessionSidePanelOpenAtom,
  isWorkspaceComponentTab,
  openWorkspaceComponentAtom,
} from './agent-atoms'
import { activeViewAtom, agentSkillsTabAtom } from './active-view'
import { appModeAtom } from './app-mode'
import { automationFormAtom } from './automation-atoms'
import { planningTabAtom } from './planning-atoms'
import { productivityToolsAtom } from './ui-preferences'
import type { WorkspaceComponentTab } from './agent-atoms'

/** 工作区工具入口：4 个动态工作区加上 10 个项目组件。 */
export type WorkspaceToolId = 'browser' | 'files' | 'terminal' | 'canvas' | WorkspaceComponentTab

export const WORKSPACE_TOOLS_COLLAPSED_WIDTH = 78
export const WORKSPACE_TOOLS_EXPANDED_WIDTH = 208

/** 常驻工作区工具栏是否展开，默认收起以减少主界面占用。 */
export const workspaceToolsExpandedAtom = atom(false)

/** 根据展开状态计算工具栏宽度，保证布局只依赖一个稳定尺寸。 */
export const workspaceToolsWidthAtom = atom((get) => (
  get(workspaceToolsExpandedAtom)
    ? WORKSPACE_TOOLS_EXPANDED_WIDTH
    : WORKSPACE_TOOLS_COLLAPSED_WIDTH
))

export interface WorkspaceToolAvailability {
  visible: boolean
  disabledReason?: string
}

/** 当前会话优先使用会话所属项目；无会话时回退到当前选中项目。 */
export const workspaceProjectAtom = atom((get) => {
  const sessionId = get(appModeAtom) === 'agent' ? get(currentAgentSessionIdAtom) : null
  const workspaces = get(agentWorkspacesAtom)
  if (sessionId) {
    const workspaceId = get(agentSessionsAtom).find((session) => session.id === sessionId)?.workspaceId
    return workspaceId && workspaces.some((workspace) => workspace.id === workspaceId) ? workspaceId : null
  }
  const selectedId = get(currentAgentWorkspaceIdAtom)
  return workspaces.some((workspace) => workspace.id === selectedId) ? selectedId : null
})

interface WorkspaceToolRequest {
  tool: 'browser' | 'terminal' | 'canvas'
}

/** 动态工作区请求按 Agent session 隔离，避免切会话后迟到请求污染新会话。 */
const workspaceToolRequestsAtom = atom<Map<string, WorkspaceToolRequest>>(new Map())

/** 当前会话发起动态工作区请求，并清掉其它会话的旧请求。 */
export const requestWorkspaceToolAtom = atom(
  null,
  (get, set, request: { sessionId: string; tool: WorkspaceToolRequest['tool'] }) => {
    const next = new Map<string, WorkspaceToolRequest>()
    next.set(request.sessionId, { tool: request.tool })
    set(workspaceToolRequestsAtom, next)
  },
)

/** 用户导航代次使已交付但尚未完成的资源动作失去前台焦点权限。 */
export const workspaceToolNavigationRevisionAtom = atom(0)

/** 指定会话时仅撤销该会话请求；不传会话时供全局导航清理所有请求。 */
export const clearWorkspaceToolRequestAtom = atom(null, (get, set, sessionId?: string) => {
  if (!sessionId || get(currentAgentSessionIdAtom) === sessionId) {
    set(workspaceToolNavigationRevisionAtom, (revision) => revision + 1)
  }
  /** 后台会话的延迟关闭不能撤销当前会话的资源请求和焦点权限。 */
  const current = get(workspaceToolRequestsAtom)
  if (sessionId) {
    if (!current.has(sessionId)) return
    const next = new Map(current)
    next.delete(sessionId)
    set(workspaceToolRequestsAtom, next)
  } else if (current.size > 0) set(workspaceToolRequestsAtom, new Map())
})

/** 读取指定 session 尚未处理的动态请求。 */
export const pendingWorkspaceToolRequestAtom = atomFamily((sessionId: string) => atom(
  (get) => get(workspaceToolRequestsAtom).get(sessionId) ?? null,
))

/** 原子取走指定 session 的动态请求；调用后对应 pending atom 立即为空。 */
export const consumeWorkspaceToolRequestAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const current = get(workspaceToolRequestsAtom).get(sessionId)
    if (!current || get(currentAgentSessionIdAtom) !== sessionId || get(appModeAtom) !== 'agent') return null
    const next = new Map(get(workspaceToolRequestsAtom))
    next.delete(sessionId)
    set(workspaceToolRequestsAtom, next)
    return current
  },
)

/** 固定工具清单用于共享导航守卫，避免展示与命令校验漂移。 */
const ALL_WORKSPACE_TOOLS: readonly WorkspaceToolId[] = ['browser', 'files', 'terminal', 'canvas', 'todos', 'calendar', 'automations', 'skills', 'mcp', 'memory', 'vault', 'server-ops', 'api-workbench', 'capability-factory']
/** 这些入口必须拥有 Agent 会话才能维持资源归属。 */
const SESSION_TOOLS: readonly WorkspaceToolId[] = ['browser', 'files', 'terminal', 'canvas', 'server-ops', 'api-workbench', 'capability-factory']
/** Chat 继续只提供原有的效率工具与 Obsidian 整页入口。 */
const CAPABILITY_TOOLS: readonly WorkspaceToolId[] = ['skills', 'mcp', 'memory']

/** 根据模式、有效项目和功能开关计算显示与禁用状态，供界面与写入动作共同使用。 */
export const workspaceToolAvailabilityAtom = atom<Record<WorkspaceToolId, WorkspaceToolAvailability>>((get) => {
  const agentMode = get(appModeAtom) === 'agent'
  const sessionId = agentMode ? get(currentAgentSessionIdAtom) : null
  const projectId = get(workspaceProjectAtom)
  const settings = get(productivityToolsAtom)
  const availability = {} as Record<WorkspaceToolId, WorkspaceToolAvailability>
  for (const tool of ALL_WORKSPACE_TOOLS) {
    if ((tool === 'todos' && !settings.todosEnabled) || (tool === 'calendar' && !settings.calendarEnabled) || (tool === 'vault' && !settings.obsidianEnabled) || (!agentMode && CAPABILITY_TOOLS.includes(tool))) {
      availability[tool] = { visible: false }
    } else if (!sessionId && SESSION_TOOLS.includes(tool)) {
      availability[tool] = { visible: true, disabledReason: '需要先打开 Agent 会话' }
    } else if (sessionId && !projectId && !['files', 'browser', 'terminal', 'server-ops'].includes(tool)) {
      availability[tool] = { visible: true, disabledReason: '当前会话没有有效的所属项目' }
    } else {
      availability[tool] = { visible: true }
    }
  }
  return availability
})

/** 处理常驻工具栏动作；动态资源入口交给 SidePanel 现有回调消费。 */
export const openWorkspaceToolAtom = atom(
  null,
  (get, set, tool: WorkspaceToolId) => {
    const availability = get(workspaceToolAvailabilityAtom)[tool]
    if (!availability.visible || availability.disabledReason) return
    const sessionId = get(appModeAtom) === 'agent' ? get(currentAgentSessionIdAtom) : null
    set(clearWorkspaceToolRequestAtom)
    set(automationFormAtom, { open: false, draft: null })
    if (!sessionId) {
      if (tool === 'todos' || tool === 'calendar' || tool === 'automations') {
        set(planningTabAtom, tool)
        set(activeViewAtom, 'planning')
      } else if (tool === 'skills' || tool === 'mcp' || tool === 'memory') {
        set(agentSkillsTabAtom, tool)
        set(activeViewAtom, 'agent-skills')
      } else if (tool === 'vault') {
        set(activeViewAtom, 'vault')
      }
      return
    }
    set(activeViewAtom, 'conversations')
    set(currentSessionSidePanelOpenAtom, true)
    if (tool === 'files') {
      set(agentDiffPanelTabAtom, (previous) => new Map(previous).set(sessionId, 'files'))
    } else if (tool === 'browser' || tool === 'terminal' || tool === 'canvas') {
      set(requestWorkspaceToolAtom, { sessionId, tool })
    } else {
      set(openWorkspaceComponentAtom, tool)
    }
  },
)

/**
 * 在 AppShell 生命周期内同步撤销已离开的上下文请求。
 * 返回清理订阅的函数；进入 conversations 是菜单导航本身，不清除刚写入的新请求。
 */
export function subscribeWorkspaceToolRequestContext(store: ReturnType<typeof createStore>): () => void {
  const clearPending = () => store.set(clearWorkspaceToolRequestAtom)
  const unsubscribeSession = store.sub(currentAgentSessionIdAtom, clearPending)
  const unsubscribeMode = store.sub(appModeAtom, clearPending)
  const unsubscribeView = store.sub(activeViewAtom, () => {
    if (store.get(activeViewAtom) !== 'conversations') clearPending()
  })
  const unsubscribePanel = store.sub(currentSessionSidePanelOpenAtom, () => {
    if (!store.get(currentSessionSidePanelOpenAtom)) clearPending()
  })
  return () => { unsubscribeSession(); unsubscribeMode(); unsubscribeView(); unsubscribePanel(); clearPending() }
}

/** 从当前 view、planning/skills 子页和右侧动态 Tab 派生当前入口。 */
export const activeWorkspaceToolAtom = atom<WorkspaceToolId | null>((get) => {
  const view = get(activeViewAtom)
  if (view === 'planning') return get(planningTabAtom)
  if (view === 'agent-skills') return get(agentSkillsTabAtom)
  if (view === 'vault') return 'vault'
  if (get(appModeAtom) !== 'agent') return null
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId || !get(agentSidePanelOpenAtomFamily(sessionId))) return null
  const tab = get(agentDiffPanelTabAtom).get(sessionId) ?? 'files'
  if (tab.startsWith('browser:')) return 'browser'
  if (tab.startsWith('terminal:')) return 'terminal'
  if (tab === 'canvas' || tab.startsWith('canvas:')) return 'canvas'
  if (tab === 'preview' || tab.startsWith('preview:')) return 'files'
  return isWorkspaceComponentTab(tab) ? tab : tab === 'files' ? 'files' : null
})
