import type { Store } from 'jotai/vanilla/store'
import type { PromaEvent } from '@proma/shared'
import { isOrdinaryTopLevelAgentSession } from '@proma/shared'
import { activeViewAtom } from '@/atoms/active-view'
import { appModeAtom } from '@/atoms/app-mode'
import { mobileMirrorDeviceRequestsAtom } from '@/atoms/mobile-mirror-atoms'
import {
  agentDiffPanelTabAtom, agentSessionsAtom, agentWorkspacesAtom,
  agentSessionComponentOpenMapAtom, agentSessionComponentTabsAtomFamily, agentSessionStreamingStateAtomFamily,
  agentSidePanelOpenAtomFamily, agentSidePanelOpenMapAtom, agentSidePanelSplitMapAtom, currentAgentSessionIdAtom,
} from '@/atoms/agent-atoms'
import { getFocusedRightWorkspaceTab, selectRightWorkspaceSplitTab } from './right-workspace-split'

/** 读取仍在执行且有完整身份的运行；旧客户端或终态不触发自动展示。 */
function currentRunKey(store: Store, sessionId: string): string | null {
  /** 仅在导航和设备执行事件发生时读取，不订阅逐 token 更新。 */
  const state = store.get(agentSessionStreamingStateAtomFamily(sessionId))
  return state?.running && Number.isSafeInteger(state.runGeneration) && Number.isFinite(state.startedAt)
    ? JSON.stringify([state.startedAt, state.runGeneration]) : null
}

/** 导航快照用于识别主动关闭，避免在多个按钮中散落关闭标记。 */
function readNavigation(store: Store) {
  /** 当前会话与右侧布局，分屏任一侧显示手机均算可见。 */
  const sessionId = store.get(currentAgentSessionIdAtom)
  const foreground = store.get(appModeAtom) === 'agent' && store.get(activeViewAtom) === 'conversations'
  const open = !!sessionId && store.get(agentSidePanelOpenAtomFamily(sessionId))
  const hasTab = !!sessionId && store.get(agentSessionComponentTabsAtomFamily(sessionId)).includes('mobile-mirror')
  const split = sessionId ? store.get(agentSidePanelSplitMapAtom).get(sessionId) : undefined
  const mobileVisible = foreground && open && hasTab && (split
    ? split.leftTab === 'mobile-mirror' || split.rightTab === 'mobile-mirror'
    : store.get(agentDiffPanelTabAtom).get(sessionId!) === 'mobile-mirror')
  /** 窄分屏只渲染焦点 Pane；宽分屏也尊重用户主动离开手机的焦点选择。 */
  const mobileFocused = mobileVisible && (!split || getFocusedRightWorkspaceTab(split) === 'mobile-mirror')
  return { sessionId, foreground, open, hasTab, mobileVisible, mobileFocused }
}

/**
 * 消费主进程权限通过后的 Mobile 执行事件；后台事件消耗本轮机会，切回不补弹。
 * @param store 全局 Jotai store，保持导航与会话状态一致。
 * @param isWindowVisible 测试可注入窗口可见性，生产不唤醒隐藏窗口。
 * @returns 执行事件处理器及订阅清理函数。
 */
export function createMobileMirrorAutoOpenConsumer(
  store: Store,
  isWindowVisible: () => boolean = () => typeof document !== 'undefined' && document.visibilityState === 'visible',
) {
  /** 每个会话仅保留最新已处理或被用户抑制的运行，容量有界。 */
  const consumedRuns = new Map<string, string>()
  /** 释放后拒绝异步迟到事件。 */
  let disposed = false
  /** 上一次导航快照不含高频流式内容。 */
  let previous = readNavigation(store)
  /** 标记该轮不再自动展示；新一轮身份不同，自然恢复机会。 */
  const consume = (sessionId: string, runKey: string): void => {
    consumedRuns.delete(sessionId)
    consumedRuns.set(sessionId, runKey)
    if (consumedRuns.size > 256) consumedRuns.delete(consumedRuns.keys().next().value!)
  }
  /** 用户在本轮关栏、关手机标签、离开手机或离开当前会话后不再抢焦点。 */
  const onNavigation = (): void => {
    const next = readNavigation(store)
    const sameSession = previous.sessionId === next.sessionId
    if (previous.sessionId && previous.foreground && (!sameSession || !next.foreground
      || (previous.open && !next.open) || (previous.hasTab && !next.hasTab)
      || (previous.mobileVisible && !next.mobileVisible) || (previous.mobileFocused && !next.mobileFocused))) {
      const runKey = currentRunKey(store, previous.sessionId)
      if (runKey) consume(previous.sessionId, runKey)
    }
    previous = next
  }
  /** 只订阅低频导航原子；不增加定时器或每 token 的全会话扫描。 */
  const releases = [currentAgentSessionIdAtom, appModeAtom, activeViewAtom, agentSidePanelOpenMapAtom,
    agentSessionComponentOpenMapAtom, agentDiffPanelTabAtom, agentSidePanelSplitMapAtom]
    .map(navigationAtom => store.sub(navigationAtom, onNavigation))

  return {
    /** 主进程已签发的执行通知；重复、过期、后台或隐藏会话均不改前台。 */
    handle(sessionId: string, event: Extract<PromaEvent, { type: 'mobile_device_activity' }>): void {
      if (disposed) return
      const runKey = currentRunKey(store, sessionId)
      if (!runKey || runKey !== JSON.stringify([event.runStartedAt, event.runGeneration])
        || consumedRuns.get(sessionId) === runKey) return
      consume(sessionId, runKey)
      const session = store.get(agentSessionsAtom).find(item => item.id === sessionId)
      if (!isWindowVisible() || store.get(currentAgentSessionIdAtom) !== sessionId
        || store.get(appModeAtom) !== 'agent' || store.get(activeViewAtom) !== 'conversations'
        || !isOrdinaryTopLevelAgentSession(session) || session.archived || session.explorationParentSessionId !== undefined
        || !session.workspaceId || !store.get(agentWorkspacesAtom).some(workspace => workspace.id === session.workspaceId)) return
      store.set(mobileMirrorDeviceRequestsAtom, previousRequests => {
        const next = new Map(previousRequests)
        next.delete(sessionId)
        next.set(sessionId, { deviceId: event.deviceId, runKey })
        if (next.size > 256) next.delete(next.keys().next().value!)
        return next
      })
      store.set(agentSessionComponentTabsAtomFamily(sessionId), tabs => tabs.includes('mobile-mirror') ? tabs : [...tabs, 'mobile-mirror'])
      store.set(agentSidePanelSplitMapAtom, splits => {
        const split = splits.get(sessionId)
        return split ? new Map(splits).set(sessionId, selectRightWorkspaceSplitTab(split, 'mobile-mirror')) : splits
      })
      store.set(agentDiffPanelTabAtom, tabs => new Map(tabs).set(sessionId, 'mobile-mirror'))
      store.set(agentSidePanelOpenAtomFamily(sessionId), true)
    },
    /** 卸载只清理本消费者订阅，设备连接由面板自身生命周期回收。 */
    dispose(): void { disposed = true; releases.forEach(release => release()); consumedRuns.clear() },
  }
}
