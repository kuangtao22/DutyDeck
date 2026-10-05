import { atom } from 'jotai'
import type { LanBridgeAutomationDto } from '@proma/shared'
import type { AgentRuntimeStatus } from '../lib/session-runtime-state'

// ===== 消息类型 =====

export interface TextBlock { type: 'text'; text: string }
export interface ThinkingBlock { type: 'thinking'; thinking: string }
export interface ToolUseContent { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export interface ToolResultContent { type: 'tool_result'; tool_use_id: string; content: string | TextBlock[]; is_error?: boolean }

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseContent | ToolResultContent

export interface Message {
  id: string
  type?: 'user' | 'assistant'
  role?: 'user' | 'assistant'
  content?: string | ContentBlock[]
  message?: { content?: string | ContentBlock[] }
  model?: string
  reasoning?: string
  createdAt?: number
}

/** 手机端实时回答与思考的独立缓冲状态。 */
export interface MobileStreamSegments {
  /** 普通回答 delta 的累计内容。 */
  answer: string
  /** 思考过程 delta 的累计内容。 */
  reasoning: string
}

// ===== 连接状态 =====
export const tokenAtom = atom<string | null>(localStorage.getItem('proma_mobile_token'))
export const pinAtom = atom('')
export const bridgeHostAtom = atom(localStorage.getItem('proma_mobile_host') || window.location.hostname)
export const bridgePortAtom = atom(localStorage.getItem('proma_mobile_port') || '29888')
export const connectedAtom = atom(false)

// ===== 视图 =====
export type View = 'auth' | 'chat'
export const viewAtom = atom<View>('auth')

// ===== 数据 =====
export interface ConvItem {
  id: string; title: string; updatedAt: number; createdAt?: number; type: 'chat' | 'agent'
  workspaceId?: string; workspaceName?: string
  pinned?: boolean; manualWorking?: boolean; archived?: boolean; starred?: boolean
  sourceAutomationId?: string
  parentSessionId?: string
  sourceDelegationId?: string
  delegationRole?: 'explore' | 'research' | 'implement' | 'review' | 'custom'
  delegationStatus?: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  delegationGoal?: string
  runtimeStatus?: AgentRuntimeStatus
}
export const conversationsAtom = atom<ConvItem[]>([])
export const workspacesAtom = atom<Array<{ id: string; name: string; slug: string }>>([])
/** 移动端计划面板使用的服务端自动计划摘要。 */
export const automationsAtom = atom<LanBridgeAutomationDto[]>([])

// ===== 当前会话 =====
export const activeConvAtom = atom<ConvItem | null>(null)
export const messagesAtom = atom<Message[]>([])
export const streamingAtom = atom(false)
/** 当前会话的实时回答与思考分别累计，避免把两类内容混成一段正文。 */
export const streamSegmentsAtom = atom<MobileStreamSegments>({ answer: '', reasoning: '' })

// ===== 抽屉 =====
export const drawerOpenAtom = atom(false)

// ===== Tab =====
export type TabType = 'agent' | 'chat' | 'automation'
export const activeTabAtom = atom<TabType>('agent')

// ===== 工作区过滤 =====
export const currentWorkspaceIdAtom = atom<string | null>(null) // null = 全部工作区

// ===== 下拉对话切换器 =====
export const convDropdownOpenAtom = atom(false)

// ===== 设置（全局共享） =====
export const settingsModelIdAtom = atom<string | null>(null)
export const settingsChannelBaseUrlAtom = atom<string | null>(null)
export const settingsChannelIdAtom = atom<string | null>(null)

// ===== 权限模式 =====
export type PermissionMode = 'auto' | 'bypassPermissions' | 'plan'
export const PERMISSION_MODE_ORDER: PermissionMode[] = ['auto', 'bypassPermissions', 'plan']
export const PERMISSION_MODE_CONFIG: Record<PermissionMode, { label: string; description: string; icon: string }> = {
  auto: { label: '自动审批', description: 'SDK 内置审批器自动判断', icon: 'compass' },
  bypassPermissions: { label: '完全自动', description: '所有工具调用自动允许', icon: 'zap' },
  plan: { label: '计划模式', description: '仅规划不执行', icon: 'map' },
}
export const permissionModeAtom = atom<PermissionMode>('auto')

// ===== 渠道+模型列表 =====
export interface ChannelInfo {
  id: string; name: string; provider: string; baseUrl: string
  models: Array<{ id: string; name: string }>
}
export const channelsAtom = atom<ChannelInfo[]>([])

// ===== 派生 atoms =====

export interface SessionGroup {
  key: string
  label: string
  convs: ConvItem[]
}

/** Agent 对话按桌面端分组：置顶 → 工作中 → 今天 → 昨天 → 更早 */
export const agentSessionGroupsAtom = atom((get) => {
  const convs = get(conversationsAtom)
  const workspaces = get(workspacesAtom)
  const currentWsId = get(currentWorkspaceIdAtom)
  const agentConvs = convs
    .filter(c => c.type === 'agent' && !c.archived)
    /** 自动计划产生的会话归计划面板管理；置顶后才回到普通列表。 */
    .filter(c => !c.sourceAutomationId || c.pinned)
    .filter(c => !currentWsId || c.workspaceId === currentWsId)

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000

  const pinned: ConvItem[] = []
  const working: ConvItem[] = []
  const today: ConvItem[] = []
  const yesterday: ConvItem[] = []
  const earlier: ConvItem[] = []

  for (const c of agentConvs) {
    /** 子 Agent 随父会话展示，避免同一会话在列表中出现两次。 */
    if (c.parentSessionId && c.sourceDelegationId) continue
    if (c.pinned) { pinned.push(c); continue }
    if (c.manualWorking) { working.push(c); continue }
    const ts = c.updatedAt ?? 0
    if (ts >= todayStart) { today.push(c) }
    else if (ts >= yesterdayStart) { yesterday.push(c) }
    else { earlier.push(c) }
  }

  const sortFn = (a: ConvItem, b: ConvItem) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  pinned.sort(sortFn); working.sort(sortFn); today.sort(sortFn); yesterday.sort(sortFn); earlier.sort(sortFn)

  const groups: SessionGroup[] = []
  if (pinned.length > 0) groups.push({ key: 'pinned', label: '置顶', convs: pinned })
  if (working.length > 0) groups.push({ key: 'working', label: '工作中', convs: working })
  if (today.length > 0) groups.push({ key: 'today', label: '今天', convs: today })
  if (yesterday.length > 0) groups.push({ key: 'yesterday', label: '昨天', convs: yesterday })
  if (earlier.length > 0) groups.push({ key: 'earlier', label: '更早', convs: earlier })

  return { groups, workspaces }
})

/** Chat 类型对话平铺 */
export const chatConvsAtom = atom((get) => {
  return get(conversationsAtom)
    .filter(c => c.type === 'chat')
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
})

/** 当前工作区的对话（Chat 顶栏下拉用） */
export const currentWorkspaceConvsAtom = atom((get) => {
  const active = get(activeConvAtom)
  if (!active) return []
  if (active.type === 'agent') {
    return get(conversationsAtom)
      .filter(c => c.type === 'agent' && c.workspaceId === active.workspaceId && (!c.sourceAutomationId || c.pinned || c.id === active.id))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }
  return get(conversationsAtom)
    .filter(c => c.type === 'chat')
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
})
