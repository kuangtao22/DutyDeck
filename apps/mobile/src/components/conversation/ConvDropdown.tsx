import type { ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Check, PanelLeftOpen, Pin, PinOff, Plus } from 'lucide-react'
import {
  currentWorkspaceConvsAtom, activeConvAtom, convDropdownOpenAtom,
  tokenAtom, conversationsAtom, drawerOpenAtom, type ConvItem,
} from '../../atoms'
import { loadData } from '../../App'
import { createAgentConversation, saveActiveConv } from '../../utils/session'
import { formatRelativeTime } from '../../utils/format'
import { wsReq } from '../../lib/ws-client'
import {
  readAgentStarUpdate,
  readAgentPinUpdate,
  readConversationPinUpdate,
  updateActiveAgentPinned,
  updateActiveAgentStarred,
  updateAgentPinned,
  updateAgentStarred,
  updateActiveConversationPinned,
  updateConversationPinned,
} from '../../lib/session-runtime-state'
import { AgentSessionRow } from './AgentSessionRow'

interface Props {
  onClose: () => void
}

export function ConvDropdown({ onClose }: Props) {
  const convs = useAtomValue(currentWorkspaceConvsAtom)
  const active = useAtomValue(activeConvAtom)
  const setActive = useSetAtom(activeConvAtom)
  const setOpen = useSetAtom(convDropdownOpenAtom)
  const token = useAtomValue(tokenAtom)
  const setConvs = useSetAtom(conversationsAtom)
  const setDrawerOpen = useSetAtom(drawerOpenAtom)

  /** 当前工作区 Agent 快照，用于在快速切换器中重建委派树。 */
  const agentConvs = convs.filter((conversation) => conversation.type === 'agent')
  /** 返回一个 Agent 的直接子会话，并按最近活动排序。 */
  const getChildren = (parentSessionId: string): ConvItem[] => agentConvs
    .filter((conversation) => (
      conversation.parentSessionId === parentSessionId
      && !!conversation.sourceDelegationId
    ))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  /** 只把存在于当前快照中的父会话作为树根，孤立子会话仍保留为根节点。 */
  const agentRoots = agentConvs.filter((conversation) => (
    !conversation.parentSessionId
    || !conversation.sourceDelegationId
    || !agentConvs.some((parent) => parent.id === conversation.parentSessionId)
  ))

  /** 渲染快速切换器中的 Agent 子树，防止异常快照形成循环递归。 */
  const renderAgentRows = (
    session: ConvItem,
    nested = false,
    lineage: ReadonlySet<string> = new Set<string>(),
  ): ReactNode => {
    const nextLineage = new Set(lineage)
    nextLineage.add(session.id)
    return (
      <div key={session.id} className="border-b border-border/60">
        <AgentSessionRow
          session={session}
          nested={nested}
          active={active?.type === 'agent' && active.id === session.id}
          onOpen={() => handleSwitch(session)}
          onToggleStar={() => { void handleToggleStar(session) }}
          onTogglePin={() => { void handleTogglePin(session) }}
        />
        {getChildren(session.id)
          .filter((child) => !nextLineage.has(child.id))
          .map((child) => renderAgentRows(child, true, nextLineage))}
      </div>
    )
  }

  const handleSwitch = (conv: ConvItem) => {
    setActive(conv)
    saveActiveConv(conv)
    setOpen(false)
    onClose()
  }

  const handleCreate = async () => {
    if (!token || !active) return
    try {
      const newConv = await createAgentConversation(token, active.workspaceId)
      setActive(newConv)
      saveActiveConv(newConv)
      setOpen(false)
      onClose()
      loadData(setConvs, () => {}, token)
    } catch { /* TODO: toast */ }
  }

  /** 请求服务端切换星标，并把确认结果同步到两个会话状态入口。 */
  const handleToggleStar = async (session: ConvItem): Promise<void> => {
    if (!token || session.type !== 'agent') return
    try {
      /** 星标状态只采用服务端确认值，避免失败时产生假状态。 */
      const update = readAgentStarUpdate(await wsReq('agent.sessions.toggle_star', {
        token,
        sessionId: session.id,
      }))
      if (!update) return
      setConvs(current => updateAgentStarred(current, update.sessionId, update.starred))
      setActive(current => updateActiveAgentStarred(current, update.sessionId, update.starred))
    } catch { /* TODO: toast */ }
  }

  /** 请求服务端切换置顶，并同步下拉列表与当前会话。 */
  const handleTogglePin = async (session: ConvItem): Promise<void> => {
    if (!token || session.type !== 'agent') return
    try {
      const update = readAgentPinUpdate(await wsReq('agent.sessions.toggle_pin', {
        token,
        sessionId: session.id,
      }))
      if (!update) return
      setConvs(current => updateAgentPinned(current, update.sessionId, update.pinned))
      setActive(current => updateActiveAgentPinned(current, update.sessionId, update.pinned))
    } catch { /* TODO: toast */ }
  }

  /** 请求服务端切换 Chat 置顶，并同步下拉列表与当前会话。 */
  const handleToggleChatPin = async (conversation: ConvItem): Promise<void> => {
    if (!token || conversation.type !== 'chat') return
    try {
      const update = readConversationPinUpdate(await wsReq('conversations.toggle_pin', {
        token,
        conversationId: conversation.id,
      }))
      if (!update) return
      setConvs(current => updateConversationPinned(current, update.conversationId, update.pinned))
      setActive(current => updateActiveConversationPinned(current, update.conversationId, update.pinned))
    } catch { /* TODO: toast */ }
  }

  const handleViewAll = () => {
    setOpen(false)
    setDrawerOpen(true)
    onClose()
  }

  return (
    <>
      {/* 遮罩 */}
      <div className="fixed inset-0 z-30 transition-opacity duration-200 opacity-100"
        onClick={() => { setOpen(false); onClose() }}
        style={{ top: 'var(--safe-t)', bottom: 'var(--safe-b)' }} />

      {/* 下拉面板 */}
      <div className="absolute left-0 right-0 top-full z-40 mx-2 mt-0 overflow-hidden rounded-b-md border border-t-0 border-border bg-popover text-popover-foreground shadow-lg animate-dropdown-in"
        style={{ maxHeight: '60vh' }}>
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(60vh - 48px)' }}>
          {agentRoots.map((session) => renderAgentRows(session))}
          {convs.filter((conversation) => conversation.type === 'chat').map(c => (
            <div
              key={c.id}
              className={`relative flex min-h-10 w-full items-center gap-2 border-b border-border/60 px-3.5 py-2 text-left text-sm transition-colors hover:bg-accent ${active?.id === c.id ? 'bg-accent' : ''}`}
            >
              <button type="button" aria-label={`打开会话：${c.title || '新对话'}`} onClick={() => handleSwitch(c)} className="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" />
              <span className="min-w-0 flex-1 truncate text-foreground">{c.title || '新对话'}</span>
              {c.updatedAt ? (
                <span className="flex-shrink-0 text-[10px] text-muted-foreground">
                  {formatRelativeTime(c.updatedAt)}
                </span>
              ) : null}
              {active?.id === c.id && (
                <Check
                  aria-label="当前会话"
                  className="h-3.5 w-3.5 flex-shrink-0 text-foreground"
                  strokeWidth={2.2}
                />
              )}
              <button
                type="button"
                aria-label={c.pinned ? '取消置顶' : '置顶会话'}
                aria-pressed={Boolean(c.pinned)}
                onClick={(event) => { event.stopPropagation(); void handleToggleChatPin(c) }}
                className={`relative z-10 flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground ${c.pinned ? 'text-foreground' : 'opacity-45'}`}
              >
                {c.pinned ? <Pin aria-hidden="true" className="h-3 w-3" fill="currentColor" /> : <PinOff aria-hidden="true" className="h-3 w-3" />}
              </button>
            </div>
          ))}
          {convs.length === 0 && (
            <p className="text-center text-muted-foreground text-xs py-4">暂无对话</p>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-3 py-2">
          <button onClick={handleCreate}
            className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90">
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            新建对话
          </button>
          <button onClick={handleViewAll}
            className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md bg-sidebar-control px-2 text-xs text-muted-foreground transition-colors hover:bg-sidebar-control-hover hover:text-foreground">
            <PanelLeftOpen aria-hidden="true" className="h-3.5 w-3.5" />
            查看全部
          </button>
        </div>
      </div>
    </>
  )
}
