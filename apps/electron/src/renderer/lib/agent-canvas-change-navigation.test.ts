import { canvasAgentOwnersAtom } from '@/atoms/native-canvas-atoms'
import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentCanvasBinding } from '@proma/shared'
import { agentDiffPanelTabAtom, agentSessionsAtom, agentSidePanelOpenAtomFamily, agentSidePanelSplitMapAtom, agentStreamingStatesAtom, currentAgentSessionIdAtom, getCanvasWorkspaceTab } from '@/atoms/agent-atoms'
import { agentCanvasFocusRequestsAtom, interruptAgentCanvasNavigationAtom, createAgentCanvasViewKey, initializeAgentCanvasViewStateAtom, updateAgentCanvasViewStateAtom } from '@/atoms/agent-canvas-atoms'
import { agentCanvasChangeNoticesAtom, createAgentCanvasChangeConsumer, openAgentCanvasChange, parseCanvasChangeNavigation } from './agent-canvas-change-navigation'

/** 等待权威关联 Promise 及消费回执微任务完成。 */
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

/** 创建隔离聊天、运行与已关联画布，不连接真实客户端。 */
function fixture() {
  const store = createStore()
  store.set(currentAgentSessionIdAtom, 'chat')
  store.set(agentSessionsAtom, [{ id: 'chat', workspaceId: 'project', title: '聊天', createdAt: 1, updatedAt: 1 }])
  store.set(agentSidePanelOpenAtomFamily('chat'), false)
  const bindings: AgentCanvasBinding[] = [{ projectId: 'project', sessionId: 'chat', linkedCanvasIds: ['canvas'], updatedAt: 1 }]
  const dependencies = { listBindings: async () => bindings }
  const consumer = createAgentCanvasChangeConsumer(store, dependencies)
  store.set(agentSidePanelOpenAtomFamily('chat'), false)
  const key = createAgentCanvasViewKey('chat', 'project', 'canvas')
  /** 模拟主进程成功回执，工具调用 ID 与源身份保持一致。 */
  const result = (toolUseId: string, nodeIds = ['node'], deletedNodeIds: string[] = [], revision = 1) => consumer.handle('chat', {
    type: 'tool_result', toolUseId, isError: false,
    result: JSON.stringify({ navigation: { status: 'changed', projectId: 'project', canvasId: 'canvas', nodeIds, deletedNodeIds, revision, sourceToolCallId: toolUseId } }),
  })
  const start = (toolUseId: string, toolName = 'canvas_update_artifact') => consumer.handle('chat', { type: 'tool_start', toolUseId, toolName, input: {} })
  return { store, consumer, dependencies, bindings, key, start, result }
}

describe('普通聊天修改画布自动定位', () => {
  test('Given 当前聊天首次成功写入 When 回执通过关联复验 Then 打开具体画布并等待LOAD后定位', async () => {
    const f = fixture(); f.start('one'); f.result('one'); await flush()
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(true)
    expect(f.store.get(agentDiffPanelTabAtom).get('chat')).toBe(getCanvasWorkspaceTab('canvas'))
    expect(f.store.get(agentCanvasFocusRequestsAtom).get(f.key)).toEqual({ nodeIds: ['node'], revision: 1 })
    expect(f.store.get(agentCanvasChangeNoticesAtom).get(f.key)?.changes).toBe(1)
  })

  test('Given 后台聊天 When 成功写入 Then 仅记录摘要而不改变选区或打开面板', async () => {
    const f = fixture(); f.store.set(currentAgentSessionIdAtom, 'another'); f.start('one'); f.result('one'); await flush()
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
    expect(f.store.get(agentCanvasFocusRequestsAtom).size).toBe(0)
    expect(f.store.get(agentCanvasChangeNoticesAtom).get(f.key)?.nodeIds).toEqual(['node'])
  })

  test('Given 当前轮已自动展示 When 后续节点修改 Then 合并摘要而不再次跳转', async () => {
    const f = fixture(); f.start('one'); f.result('one'); await flush()
    f.store.set(agentCanvasFocusRequestsAtom, new Map())
    f.store.set(agentDiffPanelTabAtom, new Map([['chat', 'files']]))
    f.start('two'); f.result('two', ['second'], [], 2); await flush()
    expect(f.store.get(agentCanvasChangeNoticesAtom).get(f.key)?.nodeIds).toEqual(['node', 'second'])
    expect(f.store.get(agentCanvasChangeNoticesAtom).get(f.key)?.changes).toBe(2)
    expect(f.store.get(agentCanvasFocusRequestsAtom).size).toBe(0)
    expect(f.store.get(agentDiffPanelTabAtom).get('chat')).toBe('files')
  })

  test('Given 用户在工具执行期间切换界面或平移 When 回执到达 Then 保留手动位置', async () => {
    const f = fixture()
    f.store.set(initializeAgentCanvasViewStateAtom, { key: f.key, viewport: { x: 0, y: 0, zoom: 1 } })
    f.start('one')
    f.store.set(updateAgentCanvasViewStateAtom, { key: f.key, update: { viewport: { x: 20, y: 10, zoom: 0.5 } } })
    f.result('one'); await flush()
    expect(f.store.get(agentCanvasFocusRequestsAtom).size).toBe(0)
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
  })

  test('Given 节点未保存草稿 When 自动或显式导航 Then 保留草稿和编辑位置', async () => {
    const f = fixture()
    f.store.set(initializeAgentCanvasViewStateAtom, { key: f.key, viewport: { x: 0, y: 0, zoom: 1 } })
    f.store.set(updateAgentCanvasViewStateAtom, { key: f.key, update: { expandedNodeId: 'draft', workbenchDraft: { nodeId: 'draft', dirty: true } } })
    f.start('one'); f.result('one'); await flush()
    expect(f.store.get(agentCanvasFocusRequestsAtom).size).toBe(0)
    expect(await openAgentCanvasChange(f.store, f.store.get(agentCanvasChangeNoticesAtom).get(f.key)!, undefined, f.dependencies)).toBe(false)
  })

  test('Given 分屏已显示目标画布 When 修改成功 Then 聚焦已有Pane并保留另一侧', async () => {
    const f = fixture()
    f.store.set(agentSidePanelSplitMapAtom, new Map([['chat', { leftTab: 'files', rightTab: getCanvasWorkspaceTab('canvas'), focusedPane: 'left', ratio: 0.6 }]]))
    f.start('one'); f.result('one'); await flush()
    expect(f.store.get(agentSidePanelSplitMapAtom).get('chat')).toEqual({ leftTab: 'files', rightTab: getCanvasWorkspaceTab('canvas'), focusedPane: 'right', ratio: 0.6 })
  })

  test('Given 正在查看节点详情 When 点击修改位置并触发外部关闭 Then 允许定位目标', async () => {
    const f = fixture(); f.start('one'); f.result('one'); await flush()
    f.store.set(initializeAgentCanvasViewStateAtom, { key: f.key, viewport: { x: 0, y: 0, zoom: 1 } })
    f.store.set(updateAgentCanvasViewStateAtom, { key: f.key, update: { selectedNodeId: 'old', expandedNodeId: 'old' } })
    /** 按钮处理先开始异步验权，随后同一次 click 冒泡关闭旧详情。 */
    const opening = openAgentCanvasChange(f.store, f.store.get(agentCanvasChangeNoticesAtom).get(f.key)!, undefined, f.dependencies)
    f.store.set(updateAgentCanvasViewStateAtom, { key: f.key, update: { expandedNodeId: null } })
    expect(await opening).toBe(true)
    expect(f.store.get(agentCanvasFocusRequestsAtom).get(f.key)?.nodeIds).toEqual(['node'])
  })

  test('Given 显式定位等待验权 When 用户另选节点或移动视口 Then 取消迟到定位', async () => {
    for (const update of [{ selectedNodeId: 'another' }, { viewport: { x: 50, y: 0, zoom: 1 } }]) {
      const f = fixture(); f.start('one'); f.result('one'); await flush()
      f.store.set(initializeAgentCanvasViewStateAtom, { key: f.key, viewport: { x: 0, y: 0, zoom: 1 } })
      /** 复验期间的真实位置变化与同次点击关闭详情分别处理。 */
      const opening = openAgentCanvasChange(f.store, f.store.get(agentCanvasChangeNoticesAtom).get(f.key)!, undefined, f.dependencies)
      f.store.set(updateAgentCanvasViewStateAtom, { key: f.key, update })
      expect(await opening).toBe(false)
    }
  })

  test('Given 节点删除或批量更新 When 回执到达 Then 摘要移除已删除定位且保留删除事实', async () => {
    const f = fixture(); f.start('one'); f.result('one', ['node', 'second']); await flush()
    f.start('two', 'canvas_apply_changes'); f.result('two', ['second'], ['node'], 2); await flush()
    expect(f.store.get(agentCanvasChangeNoticesAtom).get(f.key)).toMatchObject({ nodeIds: ['second'], deletedNodeIds: ['node'], revision: 2 })
  })

  test('Given 只读、失败、重复及跨会话结果 When 返回 Then 不误导航', async () => {
    const f = fixture(); f.start('read', 'canvas_read'); f.result('read')
    f.start('error'); f.consumer.handle('chat', { type: 'tool_result', toolUseId: 'error', result: '{}', isError: true })
    f.start('other'); f.consumer.handle('another', { type: 'tool_result', toolUseId: 'other', result: '{}', isError: false })
    await flush(); expect(f.store.get(agentCanvasChangeNoticesAtom).size).toBe(0)
    f.start('one'); f.result('one'); f.result('one'); await flush()
    expect(f.store.get(agentCanvasChangeNoticesAtom).get(f.key)?.changes).toBe(1)
  })

  test('Given 关联已撤销 When 回执或点击旧摘要 Then 不打开画布', async () => {
    const f = fixture(); f.start('one'); f.result('one'); await flush()
    const notice = f.store.get(agentCanvasChangeNoticesAtom).get(f.key)!
    f.bindings.length = 0
    expect(await openAgentCanvasChange(f.store, notice, undefined, f.dependencies)).toBe(false)
    f.start('two'); f.result('two'); await flush()
    expect(f.store.get(agentCanvasChangeNoticesAtom).get(f.key)?.changes).toBe(1)
  })

  test('Given 校验返回前开始新轮或卸载 When 旧回执晚回 Then 不导航', async () => {
    const f = fixture(); f.start('one'); f.result('one')
    f.store.set(agentStreamingStatesAtom, new Map([['chat', { running: true, startedAt: 99 }]]))
    await flush(); expect(f.store.get(agentCanvasChangeNoticesAtom).size).toBe(0)
    f.start('two'); f.result('two'); f.consumer.dispose(); await flush()
    expect(f.store.get(agentCanvasChangeNoticesAtom).size).toBe(0)
  })

  test('Given 不同项目或伪造工具调用来源 When 回执到达 Then 拒绝定位', async () => {
    const f = fixture()
    for (const [projectId, sourceToolCallId] of [['wrong', 'one'], ['project', 'wrong']]) {
      f.start('one'); f.consumer.handle('chat', { type: 'tool_result', toolUseId: 'one', isError: false,
        result: JSON.stringify({ navigation: { status: 'changed', projectId, canvasId: 'canvas', nodeIds: ['node'], sourceToolCallId } }) })
    }
    await flush(); expect(f.store.get(agentCanvasChangeNoticesAtom).size).toBe(0)
  })

  test('Given 文本块结果与损坏输入 When 解析 Then 只接受有界成功回执', () => {
    const value = { navigation: { status: 'changed', projectId: 'project', canvasId: 'canvas', nodeIds: ['a', 'a'], revision: 0 } }
    expect(parseCanvasChangeNavigation(JSON.stringify([{ type: 'text', text: JSON.stringify(value) }]))?.nodeIds).toEqual(['a'])
    for (const patch of [{ status: 'running' }, { nodeIds: [42] }, { revision: -1 }, { deletedNodeIds: [null] }, { projectId: '' }]) {
      expect(parseCanvasChangeNavigation(JSON.stringify({ navigation: { ...value.navigation, ...patch } }))).toBeNull()
    }
  })
})


describe('画布修改导航的运行与手势边界', () => {
  test('Given 模型思考期间用户已切页 When 首个写工具开始并成功 Then 不覆盖新页面', async () => {
    const f = fixture(); f.consumer.beginRun('chat')
    f.store.set(agentDiffPanelTabAtom, new Map([['chat', 'skills']]))
    f.start('one'); f.result('one'); await flush()
    expect(f.store.get(agentCanvasFocusRequestsAtom).size).toBe(0)
    expect(f.store.get(agentDiffPanelTabAtom).get('chat')).toBe('skills')
  })
  test('Given 用户正在平移且尚未提交视口 When 工具回执到达 Then 保留手势并取消等待的定位', async () => {
    const f = fixture(); f.consumer.beginRun('chat'); f.start('one')
    f.store.set(interruptAgentCanvasNavigationAtom, { sessionId: 'chat', key: f.key })
    f.result('one'); await flush()
    expect(f.store.get(agentCanvasFocusRequestsAtom).size).toBe(0)
  })
  test('Given 新版本删除节点已到达 When 旧版本更新回执晚回 Then 不复活已删节点摘要', async () => {
    const f = fixture(); f.start('delete'); f.result('delete', [], ['node'], 3); await flush()
    f.start('old'); f.result('old', ['node'], [], 2); await flush()
    expect(f.store.get(agentCanvasChangeNoticesAtom).get(f.key)).toMatchObject({ nodeIds: [], deletedNodeIds: ['node'], revision: 3, changes: 1 })
  })
})


describe('画布委托修改归属', () => {
  test('Given Host签发父聊天归属的子Agent写入 When 回执到达 Then 只给父聊天摘要不抢焦点', async () => {
    const f = fixture()
    f.store.set(canvasAgentOwnersAtom, new Map([['child', { sessionId: 'child', projectId: 'project', canvasId: 'canvas', nodeId: 'director', title: '导演' }]]))
    f.consumer.handle('child', { type: 'tool_start', toolName: 'canvas_update_artifact', toolUseId: 'child-tool', input: {} })
    f.consumer.handle('child', { type: 'tool_result', toolUseId: 'child-tool', isError: false,
      result: JSON.stringify({ navigation: { status: 'changed', projectId: 'project', canvasId: 'canvas', nodeIds: ['script'], ownerSessionId: 'chat', sourceToolCallId: 'child-tool' } }) })
    await flush()
    expect(f.store.get(agentCanvasChangeNoticesAtom).get(f.key)?.nodeIds).toEqual(['script'])
    expect(f.store.get(agentCanvasFocusRequestsAtom).size).toBe(0)
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
  })
  test('Given 子Agent伪造画布归属或普通聊天伪造owner When 回执到达 Then 不建立跨会话摘要', async () => {
    const f = fixture()
    f.store.set(canvasAgentOwnersAtom, new Map([['child', { sessionId: 'child', projectId: 'project', canvasId: 'other', nodeId: 'director', title: '导演' }]]))
    for (const source of ['child', 'chat']) {
      f.consumer.handle(source, { type: 'tool_start', toolName: 'canvas_update_artifact', toolUseId: 'tool', input: {} })
      f.consumer.handle(source, { type: 'tool_result', toolUseId: 'tool', isError: false,
        result: JSON.stringify({ navigation: { status: 'changed', projectId: 'project', canvasId: 'canvas', nodeIds: ['script'], ownerSessionId: source === 'child' ? 'chat' : 'another' } }) })
    }
    await flush(); expect(f.store.get(agentCanvasChangeNoticesAtom).size).toBe(0)
  })
})


describe('未加载定位与手动切换', () => {
  test('Given 运行期间切走后又切回 When 首个修改成功 Then 仍保留手动浏览优先权', async () => {
    const f = fixture(); f.consumer.beginRun('chat')
    f.store.set(currentAgentSessionIdAtom, 'other'); f.store.set(currentAgentSessionIdAtom, 'chat')
    f.start('one'); f.result('one'); await flush()
    expect(f.store.get(agentCanvasFocusRequestsAtom).size).toBe(0)
  })
  test('Given 回执已定位但图仍在LOAD When 用户切换标签 Then 清除待定位意图防止返回时回跳', async () => {
    const f = fixture(); f.start('one'); f.result('one'); await flush()
    expect(f.store.get(agentCanvasFocusRequestsAtom).size).toBe(1)
    f.store.set(agentDiffPanelTabAtom, new Map([['chat', 'files']]))
    expect(f.store.get(agentCanvasFocusRequestsAtom).size).toBe(0)
  })
})

describe('关联授权快照竞态', () => {
  test('Given 关联读取未返回 When 授权撤销或仅活动身份变化 Then 仅撤销使旧快照失效', async () => {
    for (const cause of ['unlinked', 'active-changed'] as const) {
      const f = fixture(); f.consumer.dispose()
      /** 用可控 Promise 固定撤销先于旧 LIST 晚回的时序。 */
      const callbacks: {
        resolve?: (bindings: AgentCanvasBinding[]) => void
        binding?: (event: import('@proma/shared').AgentCanvasBindingChangeEvent) => void
      } = {}
      const consumer = createAgentCanvasChangeConsumer(f.store, {
        listBindings: () => new Promise(resolve => { callbacks.resolve = resolve }),
        onBindingChanged: listener => { callbacks.binding = listener; return () => {} },
      })
      consumer.handle('chat', { type: 'tool_start', toolName: 'canvas_update_artifact', toolUseId: 'one', input: {} })
      consumer.handle('chat', { type: 'tool_result', toolUseId: 'one', isError: false,
        result: JSON.stringify({ navigation: { status: 'changed', projectId: 'project', canvasId: 'canvas', nodeIds: ['node'] } }) })
      callbacks.binding?.({ projectId: 'project', sessionId: 'chat', cause, binding: cause === 'unlinked' ? null : f.bindings[0]! })
      callbacks.resolve?.(f.bindings); await flush()
      expect(f.store.get(agentCanvasChangeNoticesAtom).size).toBe(cause === 'unlinked' ? 0 : 1)
      consumer.dispose()
    }
  })
})

describe('当前轮真实画布读取的自动展示', () => {
  test('Given 当前会话读取具体节点 When 权威读取成功 Then 打开画布但不产生修改摘要', async () => {
    /** 真实 canvas_read 返回节点包装，正文是否截断不影响导航身份。 */
    const f = fixture()
    f.consumer.beginRun('chat')
    f.consumer.handle('chat', { type: 'tool_start', toolUseId: 'read', toolName: 'canvas_read', input: { canvasId: 'canvas', nodeIds: ['node'] } })
    f.consumer.handle('chat', { type: 'tool_result', toolUseId: 'read', isError: false,
      result: JSON.stringify({ canvasId: 'canvas', revision: 3, nodes: [{ node: { id: 'node' }, content: '部分正文' }], truncated: true }) })
    await flush()
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(true)
    expect(f.store.get(agentCanvasFocusRequestsAtom).get(f.key)).toEqual({ nodeIds: ['node'], revision: 3 })
    expect(f.store.get(agentCanvasChangeNoticesAtom).size).toBe(0)
    f.consumer.dispose()
  })

  test('Given 本轮读取历史正文 When 用户关闭自动展示的面板后继续读取 Then 不再次打开', async () => {
    const f = fixture()
    f.consumer.beginRun('chat')
    for (const toolUseId of ['first', 'second']) {
      f.consumer.handle('chat', { type: 'tool_start', toolUseId, toolName: 'canvas_read_version', input: { canvasId: 'canvas', nodeId: 'node' } })
      f.consumer.handle('chat', { type: 'tool_result', toolUseId, isError: false,
        result: JSON.stringify({ canvasId: 'canvas', nodeId: 'node', content: '正文页', version: { kind: 'webview', revision: 1 } }) })
      await flush()
      expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(toolUseId === 'first')
      f.store.set(agentSidePanelOpenAtomFamily('chat'), false)
    }
    f.consumer.dispose()
  })

  test('Given 仅历史关联的上下文 When 查询默认活动画布 Then 不自动打开', async () => {
    const f = fixture()
    f.consumer.beginRun('chat')
    f.start('context', 'canvas_get_context')
    f.consumer.handle('chat', { type: 'tool_result', toolUseId: 'context', isError: false,
      result: JSON.stringify({ projectId: 'project', activeCanvasId: 'canvas', linkedCanvasIds: ['canvas'], explicitReferences: [] }) })
    await flush()
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
    f.consumer.dispose()
  })

  test('Given 当前轮明确引用节点 When 上下文返回已授权引用 Then 自动展示引用画布', async () => {
    const f = fixture()
    f.consumer.beginRun('chat')
    f.start('context', 'canvas_get_context')
    f.consumer.handle('chat', { type: 'tool_result', toolUseId: 'context', isError: false,
      result: JSON.stringify({ projectId: 'project', activeCanvasId: 'canvas', explicitReferences: [{ canvasId: 'canvas', nodeId: 'node' }] }) })
    await flush()
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(true)
    expect(f.store.get(agentCanvasFocusRequestsAtom).get(f.key)?.nodeIds).toEqual(['node'])
    expect(f.store.get(agentCanvasChangeNoticesAtom).size).toBe(0)
    f.consumer.dispose()
  })

  test('Given 自动任务处于当前页面 When 真实修改画布 Then 不抢焦点但保留修改摘要', async () => {
    const f = fixture()
    f.store.set(agentSessionsAtom, [{ id: 'chat', workspaceId: 'project', sourceAutomationId: 'scheduled', title: '自动任务', createdAt: 1, updatedAt: 1 }])
    f.start('one'); f.result('one'); await flush()
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
    expect(f.store.get(agentCanvasChangeNoticesAtom).get(f.key)?.changes).toBe(1)
    f.consumer.dispose()
  })

  test('Given 读取结果目标不符、失败、缺失或未观察到当前轮 When 收到读取结果 Then 不展示', async () => {
    for (const scenario of ['wrong-canvas', 'error', 'missing', 'no-run', 'background', 'revoked']) {
      const f = fixture()
      if (scenario !== 'no-run') f.consumer.beginRun('chat')
      if (scenario === 'background') f.store.set(currentAgentSessionIdAtom, 'another')
      if (scenario === 'revoked') f.bindings.length = 0
      f.consumer.handle('chat', { type: 'tool_start', toolUseId: 'read', toolName: 'canvas_read', input: { canvasId: 'canvas', nodeIds: ['node'] } })
      f.consumer.handle('chat', { type: 'tool_result', toolUseId: 'read', isError: scenario === 'error',
        result: JSON.stringify({ canvasId: scenario === 'wrong-canvas' ? 'another' : 'canvas', revision: 1,
          nodes: scenario === 'missing' ? [] : [{ node: { id: 'node' } }] }) })
      await flush()
      expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
      expect(f.store.get(agentCanvasChangeNoticesAtom).size).toBe(0)
      f.consumer.dispose()
    }
  })
})

describe('画布读取导航与写入共享展示机会', () => {
  test('Given 空画布的有界枚举成功 When 文本块回执到达 Then 打开具体画布且不创建修改摘要', async () => {
    const f = fixture()
    f.consumer.beginRun('chat')
    f.consumer.handle('chat', { type: 'tool_start', toolUseId: 'list', toolName: 'canvas_list_nodes', input: { canvasId: 'canvas' } })
    f.consumer.handle('chat', { type: 'tool_result', toolUseId: 'list', isError: false,
      result: JSON.stringify([{ type: 'text', text: JSON.stringify({ canvasId: 'canvas', revision: 0, nodes: [], total: 0 }) }]) })
    await flush()
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(true)
    expect(f.store.get(agentDiffPanelTabAtom).get('chat')).toBe('canvas:canvas')
    expect(f.store.get(agentCanvasChangeNoticesAtom).size).toBe(0)
    f.store.set(agentSidePanelOpenAtomFamily('chat'), false)
    f.start('write'); f.result('write'); await flush()
    expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
    expect(f.store.get(agentCanvasChangeNoticesAtom).get(f.key)?.changes).toBe(1)
    f.consumer.dispose()
  })

  test('Given 多个显式画布引用或跨项目上下文 When 响应没有唯一可信目标 Then 不猜测打开', async () => {
    for (const projectId of ['project', 'another']) {
      const f = fixture()
      f.consumer.beginRun('chat')
      f.start('context', 'canvas_get_context')
      f.consumer.handle('chat', { type: 'tool_result', toolUseId: 'context', isError: false,
        result: JSON.stringify({ projectId, explicitReferences: [
          { canvasId: 'canvas', nodeId: 'node' }, { canvasId: 'another', nodeId: 'node-2' },
        ] }) })
      await flush()
      expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
      f.consumer.dispose()
    }
  })
})

describe('直接进入画布媒体与交付业务', () => {
  /** 从生产工具返回结构提取导航，测试不先调用 canvas_read。 */
  const cases = [
    { name: 'canvas_inspect_images', input: { nodeIds: ['node'], expectedRevision: 4 }, result: [
      { type: 'text', text: JSON.stringify({ nodeId: 'node', status: 'ready', evidenceId: 'image-proof' }) },
      { type: 'image', mimeType: 'image/png', data: 'sample' },
    ] },
    { name: 'canvas_run_nodes', input: { nodeIds: ['node'] }, result: { canvasId: 'canvas', revision: 4,
      tasks: [{ nodeId: 'node', taskId: 'job', status: 'queued' }, { nodeId: 'failed', taskId: 'bad', status: 'failed' }] } },
    { name: 'canvas_inspect_media_content', input: { nodeId: 'node' }, result: [
      { type: 'text', text: JSON.stringify({ canvasId: 'canvas', nodeId: 'node', inspectionEvidenceId: 'media-proof', inspection: {} }) },
      { type: 'text', text: '抽样时间：100 ms（仅此帧）' },
      { type: 'image', mimeType: 'image/png', data: 'sample' },
    ] },
    ...['start', 'resume'].map(action => ({ name: 'canvas_task', input: { action, taskId: 'task' },
      result: { canvasId: 'canvas', taskId: 'task', phase: 'working', requirements: [] } })),
  ]
  for (const scenario of cases) {
    test(`Given 本轮直接调用 ${scenario.name} ${'action' in scenario.input ? scenario.input.action : ''} When 真实结果成功 Then 自动展示且不伪造修改`, async () => {
      const f = fixture()
      f.consumer.beginRun('chat')
      f.consumer.handle('chat', { type: 'tool_start', toolName: scenario.name, toolUseId: 'business', input: { canvasId: 'canvas', ...scenario.input } })
      f.consumer.handle('chat', { type: 'tool_result', toolUseId: 'business', isError: false, result: JSON.stringify(scenario.result) })
      await flush()
      expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(true)
      expect(f.store.get(agentCanvasChangeNoticesAtom).size).toBe(0)
      expect(f.store.get(agentCanvasFocusRequestsAtom).get(f.key)?.nodeIds).toEqual(scenario.name === 'canvas_task' ? [] : ['node'])
      f.store.set(agentSidePanelOpenAtomFamily('chat'), false)
      f.consumer.handle('chat', { type: 'tool_start', toolName: scenario.name, toolUseId: 'again', input: { canvasId: 'canvas', ...scenario.input } })
      f.consumer.handle('chat', { type: 'tool_result', toolUseId: 'again', isError: false, result: JSON.stringify(scenario.result) })
      await flush()
      expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
      f.consumer.dispose()
    })
  }

  test('Given 媒体业务来自后台、自动任务或撤销绑定 When 成功回执到达 Then 不抢焦点', async () => {
    for (const scenario of cases) {
      for (const boundary of ['background', 'automation', 'revoked']) {
        const f = fixture()
        f.consumer.beginRun('chat')
        if (boundary === 'background') f.store.set(currentAgentSessionIdAtom, 'another')
        if (boundary === 'automation') f.store.set(agentSessionsAtom, [{ id: 'chat', workspaceId: 'project', sourceAutomationId: 'scheduled', title: '自动', createdAt: 1, updatedAt: 1 }])
        if (boundary === 'revoked') f.bindings.length = 0
        f.consumer.handle('chat', { type: 'tool_start', toolName: scenario.name, toolUseId: 'business', input: { canvasId: 'canvas', ...scenario.input } })
        f.consumer.handle('chat', { type: 'tool_result', toolUseId: 'business', isError: false, result: JSON.stringify(scenario.result) })
        await flush()
        expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
        f.consumer.dispose()
      }
    }
  })

  test('Given 状态探测、失败生成、无可读图片或返回其它节点 When 结果到达 Then 不打开画布', async () => {
    const rejected = [
      { name: 'canvas_task', input: { action: 'status' }, result: { canvasId: 'canvas', taskId: 'task', phase: 'working' } },
      { name: 'canvas_task', input: { action: 'resume', taskId: 'expected' }, result: { canvasId: 'canvas', taskId: 'another', phase: 'working' } },
      { name: 'canvas_run_nodes', input: { nodeIds: ['node'] }, result: { canvasId: 'canvas', revision: 4, tasks: [{ nodeId: 'node', status: 'failed' }] } },
      { name: 'canvas_inspect_images', input: { nodeIds: ['node'] }, result: [{ type: 'text', text: JSON.stringify({ nodeId: 'node', status: 'image-unavailable' }) }] },
      { name: 'canvas_inspect_images', input: { nodeIds: ['node'] }, result: [{ type: 'text', text: JSON.stringify({ nodeId: 'another', status: 'ready' }) }] },
      { name: 'canvas_inspect_media_content', input: { nodeId: 'node' }, result: [{ type: 'text', text: JSON.stringify({ canvasId: 'other', nodeId: 'node', inspectionEvidenceId: 'proof' }) }] },
    ]
    for (const scenario of rejected) {
      const f = fixture()
      f.consumer.beginRun('chat')
      f.consumer.handle('chat', { type: 'tool_start', toolName: scenario.name, toolUseId: 'business', input: { canvasId: 'canvas', ...scenario.input } })
      f.consumer.handle('chat', { type: 'tool_result', toolUseId: 'business', isError: false, result: JSON.stringify(scenario.result) })
      await flush()
      expect(f.store.get(agentSidePanelOpenAtomFamily('chat'))).toBe(false)
      f.consumer.dispose()
    }
  })
})
