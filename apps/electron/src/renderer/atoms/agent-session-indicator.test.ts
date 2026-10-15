import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { AgentStreamCompletePayload } from '@proma/shared'
import {
  agentSessionIndicatorMapAtom,
  agentSessionStreamingStateAtomFamily,
  agentStreamErrorsAtom,
  unviewedCompletedSessionIdsAtom,
  type SessionIndicatorStatus,
} from './agent-atoms'
import { recordAgentTerminalRun } from '@/lib/agent-active-session-snapshot'
import { getAgentSessionTreeIndicatorStatus } from '@/lib/agent-session-list'
import { getCollapsedAgentRailTreeStatus } from '@/lib/collapsed-agent-rail'
import { applyAgentQueuedMessageStatus, recordAgentCompletionOutcome } from '@/hooks/useGlobalAgentListeners'

describe('会话失败状态条', () => {
  test.each([
    { completion: { resultSubtype: 'error_during_execution' }, expected: 'failed' },
    { completion: { resultSubtype: 'empty_response' }, expected: 'failed' },
    { completion: { resultSubtype: 'success' }, expected: undefined },
    { completion: { resultSubtype: 'error_during_execution', stoppedByUser: true }, expected: undefined },
    { completion: { resultSubtype: 'error_during_execution', backgroundTasksPending: true }, expected: undefined },
  ] satisfies Array<{ completion: Partial<AgentStreamCompletePayload>; expected: SessionIndicatorStatus | undefined }>)(
    'Given 完成载荷 $completion When 未收到独立错误事件 Then 指示状态为 $expected',
    ({ completion, expected }) => {
      /** 直接驱动监听器使用的完成处理，覆盖只有 completion 携带错误的真实链路。 */
      const store = createStore()
      recordAgentCompletionOutcome(store, 'agent', { sessionId: 'session', startedAt: 100, ...completion })
      expect(store.get(agentSessionIndicatorMapAtom).get('session')).toBe(expected)
    },
  )

  test('Given 本轮收到独立错误 When 完成事件没有 subtype Then 仍标记失败', () => {
    /** 兼容只经 STREAM_ERROR 报错、最终 completion 不携 result 的运行。 */
    const store = createStore()
    store.set(agentStreamErrorsAtom, new Map([['session', '连接失败']]))
    recordAgentCompletionOutcome(store, 'agent', { sessionId: 'session', startedAt: 100 })
    expect(store.get(agentSessionIndicatorMapAtom).get('session')).toBe('failed')
  })

  test('Given 上轮流式错误仍留存 When 后台队列启动新一轮并成功 Then 清除旧错并显示完成', () => {
    /** 使用真实后台启动与完成处理，避免只手工写 failed:false 掩盖旧错误污染。 */
    const store = createStore()
    store.set(agentStreamErrorsAtom, new Map([['session', '上一轮连接失败']]))
    recordAgentCompletionOutcome(store, 'agent', { sessionId: 'session', startedAt: 100, runGeneration: 1 })
    applyAgentQueuedMessageStatus(store, {
      status: 'started', sessionId: 'session', messageId: 'next-message',
      userMessage: '重新执行', startedAt: 200, runGeneration: 2,
    })
    expect(store.get(agentStreamErrorsAtom).has('session')).toBe(false)
    expect(store.get(agentSessionIndicatorMapAtom).get('session')).toBe('running')
    recordAgentCompletionOutcome(store, 'agent', {
      sessionId: 'session', startedAt: 200, runGeneration: 2, resultSubtype: 'success',
    })
    store.set(agentSessionStreamingStateAtomFamily('session'), undefined)
    store.set(unviewedCompletedSessionIdsAtom, new Set(['session']))
    expect(store.get(agentSessionIndicatorMapAtom).get('session')).toBe('completed')
  })

  test.each(['canvas', 'internal-invalid'] as const)(
    'Given %s 内部会话失败 When 记录终态 Then 不污染普通侧栏',
    (routeKind) => {
      /** 内部会话保留运行身份用于恢复，但不生成普通会话失败提示。 */
      const store = createStore()
      recordAgentCompletionOutcome(store, routeKind, {
        sessionId: 'internal', startedAt: 100, resultSubtype: 'error_during_execution',
      })
      expect(store.get(agentSessionIndicatorMapAtom).has('internal')).toBe(false)
    },
  )

  test('Given 同毫秒新一轮已开始 When 旧轮失败完成迟到 Then 不写入失败结果', () => {
    /** 使用 runGeneration 验证同毫秒运行仍可隔离旧终态。 */
    const store = createStore()
    store.set(agentSessionStreamingStateAtomFamily('session'), {
      running: true, startedAt: 100, runGeneration: 2,
    })
    recordAgentCompletionOutcome(store, 'agent', {
      sessionId: 'session', startedAt: 100, runGeneration: 1, resultSubtype: 'error_during_execution',
    })
    store.set(agentSessionStreamingStateAtomFamily('session'), undefined)
    expect(store.get(agentSessionIndicatorMapAtom).has('session')).toBe(false)
  })

  test('Given 运行失败且已有未查看完成标记 When 派生状态 Then 失败优先于绿色完成态', () => {
    /** 独立状态容器模拟全局监听器收到本轮失败终态。 */
    const store = createStore()
    store.set(unviewedCompletedSessionIdsAtom, new Set(['failed', 'success']))
    recordAgentTerminalRun(store, 'failed', { startedAt: 100, runGeneration: 1, failed: true })

    expect(store.get(agentSessionIndicatorMapAtom).get('failed')).toBe('failed')
    expect(store.get(agentSessionIndicatorMapAtom).get('success')).toBe('completed')
  })

  test('Given 前台会话失败 When 消息展示状态被回收 Then 仍保留失败状态', () => {
    /** 模拟前台会话没有未读标记且 stream state 已被消息交接清理。 */
    const store = createStore()
    recordAgentTerminalRun(store, 'session', { startedAt: 100, failed: true })

    expect(store.get(agentSessionIndicatorMapAtom).get('session')).toBe('failed')
  })

  test('Given 上轮失败 When 新一轮运行并成功 Then 先显示运行态再恢复绿色完成态', () => {
    /** 同一会话跨轮复用容器，验证失败不会污染新一轮。 */
    const store = createStore()
    recordAgentTerminalRun(store, 'session', { startedAt: 100, runGeneration: 1, failed: true })
    store.set(agentSessionStreamingStateAtomFamily('session'), {
      running: true, startedAt: 200, runGeneration: 2,
    })
    expect(store.get(agentSessionIndicatorMapAtom).get('session')).toBe('running')

    recordAgentTerminalRun(store, 'session', { startedAt: 200, runGeneration: 2, failed: false })
    store.set(agentSessionStreamingStateAtomFamily('session'), undefined)
    store.set(unviewedCompletedSessionIdsAtom, new Set(['session']))
    expect(store.get(agentSessionIndicatorMapAtom).get('session')).toBe('completed')

    recordAgentTerminalRun(store, 'session', { startedAt: 100, runGeneration: 1, failed: true })
    expect(store.get(agentSessionIndicatorMapAtom).get('session')).toBe('completed')
  })

  test('Given 上轮失败 When 新一轮进入后台等待 Then 不显示上轮失败', () => {
    /** 后台等待并不是失败，也不能回退到上一轮失败。 */
    const store = createStore()
    recordAgentTerminalRun(store, 'session', { startedAt: 100, runGeneration: 1, failed: true })
    store.set(agentSessionStreamingStateAtomFamily('session'), {
      running: false, backgroundWaiting: true, startedAt: 200, runGeneration: 2,
    })
    expect(store.get(agentSessionIndicatorMapAtom).has('session')).toBe(false)
  })

  test('Given 上轮失败 When 主动停止新一轮 Then 不保留失败色', () => {
    /** 主动停止沿用既有无失败结果的终态记录。 */
    const store = createStore()
    recordAgentTerminalRun(store, 'session', { startedAt: 100, failed: true })
    recordAgentTerminalRun(store, 'session', { startedAt: 200 })
    expect(store.get(agentSessionIndicatorMapAtom).has('session')).toBe(false)
  })

  test('Given 父会话成功而子会话失败 When 汇总展开与折叠侧栏 Then 都显示失败', () => {
    /** 真实状态派生与会话树汇总串联，覆盖截图中的父子会话入口。 */
    const store = createStore()
    /** 最小父子会话元数据，不读取真实用户会话。 */
    const parent = { id: 'parent', title: '父会话', createdAt: 0, updatedAt: 0 }
    const child = { ...parent, id: 'child', parentSessionId: 'parent', sourceDelegationId: 'delegation' }
    store.set(unviewedCompletedSessionIdsAtom, new Set(['parent']))
    recordAgentTerminalRun(store, 'child', { startedAt: 100, failed: true })
    /** 共享派生状态同时供展开与折叠侧栏消费。 */
    const indicators = store.get(agentSessionIndicatorMapAtom)
    expect(getAgentSessionTreeIndicatorStatus(parent, [child], indicators)).toBe('failed')
    expect(getCollapsedAgentRailTreeStatus({ session: parent, childSessions: [child] }, indicators, new Set())).toBe('failed')

    store.set(agentSessionStreamingStateAtomFamily('parent'), { running: true, startedAt: 200 })
    expect(getAgentSessionTreeIndicatorStatus(parent, [child], store.get(agentSessionIndicatorMapAtom))).toBe('running')
  })
})
