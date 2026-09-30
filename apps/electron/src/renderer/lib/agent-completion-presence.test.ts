import { describe, expect, mock, test } from 'bun:test'
import {
  getDelegatedCompletionAttention,
  getAgentCompletionMarkers,
  isAgentSessionActiveForCompletion,
  notifyAgentCompletionWarning,
  shouldNotifyAgentCompletion,
} from './agent-completion-presence'
import type { TabItem } from '@/atoms/tab-atoms'

describe('Agent 完成归属判断', () => {
  test('Given 当前激活的是同一个 Agent Tab When Agent 完成 Then 视为用户仍在查看', () => {
    const tabs: TabItem[] = [
      { id: 'chat-1', type: 'chat', sessionId: 'chat-1', title: '普通对话' },
      { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: '当前任务' },
    ]
    const input = {
      tabs,
      activeTabId: 'agent-1',
      currentAgentSessionId: 'agent-1',
      sessionId: 'agent-1',
      documentHasFocus: true,
    }

    expect(isAgentSessionActiveForCompletion(input)).toBe(true)
    expect(getAgentCompletionMarkers(input)).toEqual({
      markUnviewedCompleted: false,
    })
  })

  test('Given 当前激活的是普通对话 When 旧 Agent 完成 Then 视为后台完成', () => {
    const tabs: TabItem[] = [
      { id: 'chat-1', type: 'chat', sessionId: 'chat-1', title: '普通对话' },
      { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: '后台任务' },
    ]
    const input = {
      tabs,
      activeTabId: 'chat-1',
      currentAgentSessionId: 'agent-1',
      sessionId: 'agent-1',
      documentHasFocus: true,
    }

    expect(isAgentSessionActiveForCompletion(input)).toBe(false)
    expect(getAgentCompletionMarkers(input)).toEqual({
      markUnviewedCompleted: true,
    })
  })

  test('Given Tab 状态尚未恢复但 currentAgentSessionId 匹配 When Agent 完成 Then 使用兼容判断', () => {
    expect(isAgentSessionActiveForCompletion({
      tabs: [],
      activeTabId: null,
      currentAgentSessionId: 'agent-1',
      sessionId: 'agent-1',
      documentHasFocus: true,
    })).toBe(true)
  })

  test('Given 当前激活的就是该 Agent Tab 但窗口在后台 When Agent 完成 Then 视为未查看并入账角标', () => {
    const tabs: TabItem[] = [
      { id: 'chat-1', type: 'chat', sessionId: 'chat-1', title: '普通对话' },
      { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: '当前任务' },
    ]
    const input = {
      tabs,
      activeTabId: 'agent-1',
      currentAgentSessionId: 'agent-1',
      sessionId: 'agent-1',
      documentHasFocus: false,
    }

    expect(isAgentSessionActiveForCompletion(input)).toBe(false)
    expect(getAgentCompletionMarkers(input)).toEqual({
      markUnviewedCompleted: true,
    })
  })

  test('Given Canvas Agent 完成 When 计算普通提醒和未读 Then 不进入普通 Agent 表面', () => {
    const session = {
      sourceCanvasProjectId: 'project-1',
      sourceCanvasId: 'canvas-1',
      sourceCanvasNodeId: 'node-1',
    }
    expect(shouldNotifyAgentCompletion({
      completion: { sessionId: 'session-1', stoppedByUser: false },
      session,
    })).toBe(false)
    expect(getAgentCompletionMarkers({
      tabs: [],
      activeTabId: null,
      currentAgentSessionId: null,
      sessionId: 'session-1',
      session,
      documentHasFocus: false,
    })).toEqual({ markUnviewedCompleted: false })
  })

  test('Given Canvas 完成混入 delegation 触发标记 When 计算委派提醒 Then fail closed', () => {
    expect(getDelegatedCompletionAttention({
      completion: {
        sessionId: 'canvas-session',
        triggeredBy: 'delegation',
        stoppedByUser: false,
      },
      session: {
        sourceCanvasProjectId: 'project-1',
        sourceDelegationId: 'delegation-1',
        parentSessionId: 'parent-1',
      },
      hasStreamError: false,
      activeSessionId: null,
      selectedDelegationSessionId: null,
      activeSidePanelTab: undefined,
      split: null,
      sidePanelOpen: false,
      windowHasFocus: false,
    })).toBeNull()
  })

  test.each(['canvas', 'internal-invalid'] as const)(
    'Given %s error completion When 分派警告 Then 不调用普通 toast',
    (routeKind) => {
      /** 模拟真实 listener 传入的 toast.warning 分派函数。 */
      const warn = mock((_message: string): void => undefined)
      notifyAgentCompletionWarning(routeKind, {
        sessionId: 'session-1', resultSubtype: 'error_during_execution', resultErrors: ['模型失败'],
      }, warn)
      expect(warn).toHaveBeenCalledTimes(0)
    },
  )

  test('Given 普通 Agent error completion When 分派警告 Then 调用一次具体错误 toast', () => {
    /** 模拟真实 listener 传入的 toast.warning 分派函数。 */
    const warn = mock((_message: string): void => undefined)
    notifyAgentCompletionWarning('agent', {
      sessionId: 'session-1', resultSubtype: 'error_during_execution', resultErrors: ['模型失败'],
    }, warn)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('任务执行出错：模型失败 详情见对应回复。')
  })
})

describe('完成提醒的真实终态与有界文案', () => {
  test.each([
    ['completion_blocked', '交付检查尚未通过'],
    ['completion_check_failed', '交付检查失败'],
    ['completion_continuation_limit', '自动续行已达上限'],
    ['completion_continuation_unavailable', '当前无法继续完成任务'],
  ])('Given %s When 接收完成通知 Then 使用准确标题且不展开模型阻塞报告', (terminalReason, title) => {
    /** 模拟实际 toast 分派。 */
    const warn = mock((_message: string): void => undefined)
    notifyAgentCompletionWarning('agent', {
      sessionId: 'session-1', resultSubtype: 'error_during_execution', terminalReason,
      resultErrors: ['已恢复并完成，Host 仍未通过。'.repeat(80)],
    }, warn)
    expect(warn).toHaveBeenCalledWith(`${title}。本轮已结束，详情见对应回复。`)
  })

  test('Given 后台工作尚未结束 When 收到轻量完成 Then 不提示最终错误', () => {
    /** 等待态不能被用户误认为真正终止。 */
    const warn = mock((_message: string): void => undefined)
    notifyAgentCompletionWarning('agent', {
      sessionId: 'session-1', resultSubtype: 'error_during_execution', backgroundTasksPending: true,
    }, warn)
    expect(warn).not.toHaveBeenCalled()
  })

  test('Given 普通异常含长错误正文 When 分派 toast Then 有界显示并引导查看回复', () => {
    /** 捕获提示，完整错误仍由会话消息保留。 */
    const messages: string[] = []
    notifyAgentCompletionWarning('agent', {
      sessionId: 'session-1', resultSubtype: 'error_during_execution', resultErrors: ['错误原因'.repeat(200)],
    }, message => { messages.push(message) })
    expect(messages[0]!.length).toBeLessThan(220)
    expect(messages[0]).toContain('详情见对应回复')
  })
})
