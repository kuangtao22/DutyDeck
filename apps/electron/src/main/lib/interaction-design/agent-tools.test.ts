import { expect, test } from 'bun:test'
import { buildInteractionDesignAgentTools, INTERACTION_DESIGN_AGENT_READ_TOOL_NAMES } from './agent-tools'

/** 使用真实工具执行入口记录受控命令，不访问用户项目。 */
function fixture(denyWrites = false) {
  const calls: Array<{ method: string; input: unknown }> = []
  const tools = buildInteractionDesignAgentTools({
    sessionId: 'session-fixed',
    sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildInteractionDesignAgentTools>[0]['sdk'],
    assertAccess(write) { if (write && denyWrites) throw new Error('计划模式只读') },
    execute: (async (method: string, input: unknown) => { calls.push({ method, input }); return [] }) as Parameters<typeof buildInteractionDesignAgentTools>[0]['execute'],
  })
  return { calls, tools }
}

test('Given 固定会话工具 When 模型读取源码 Then 服务收到绑定会话且拒绝伪造session', async () => {
  const { tools, calls } = fixture()
  const tool = tools.find((item) => item.name === 'prototype_read_source')!
  await tool.execute('call', { paths: ['src/App.tsx'] }, undefined, undefined, {} as never)
  expect(calls).toEqual([{ method: 'readSource', input: { sessionId: 'session-fixed', paths: ['src/App.tsx'] } }])
  await expect(tool.execute('call', { paths: ['src/App.tsx'], sessionId: 'forged' }, undefined, undefined, {} as never)).rejects.toThrow()
  await expect(tool.execute('call', { paths: ['../private'] }, undefined, undefined, {} as never)).rejects.toThrow()
  expect(calls).toHaveLength(1)
})

test('Given 计划模式 When 调用写工具 Then 每次执行拒绝且不暴露采纳与体验伪造工具', async () => {
  const { tools, calls } = fixture(true)
  await expect(tools.find((item) => item.name === 'prototype_validate')!.execute('call', { prototypeId: 'p', revision: 1 }, undefined, undefined, {} as never)).rejects.toThrow('计划模式只读')
  await tools.find((item) => item.name === 'prototype_list')!.execute('call', {}, undefined, undefined, {} as never)
  expect(calls).toHaveLength(1)
  expect(tools.map((item) => item.name)).not.toContain('prototype_adopt')
  expect(tools.map((item) => item.name)).not.toContain('prototype_save')
  expect(tools.map((item) => item.name)).not.toContain('prototype_record_experience')
  expect(INTERACTION_DESIGN_AGENT_READ_TOOL_NAMES as readonly string[]).not.toContain('prototype_validate')
})

test('Given 生成候选 When 未绑定job Then 在服务前拒绝', async () => {
  const { tools, calls } = fixture()
  await expect(tools.find((item) => item.name === 'prototype_propose')!.execute('call', { prototypeId: 'p', baseRevision: 1, summary: '候选', draft: {} }, undefined, undefined, {} as never)).rejects.toThrow()
  expect(calls).toHaveLength(0)
})

test('Given 单工具信号已取消 When 调用创建 Then 不进入执行器', async () => {
  const { tools, calls } = fixture()
  await expect(tools.find((item) => item.name === 'prototype_create')!.execute('cancelled', { name: '测试', platform: 'mobile' }, AbortSignal.abort(new Error('工具已取消')), undefined, {} as never)).rejects.toThrow('工具已取消')
  expect(calls).toHaveLength(0)
})

test('Given 工具异步准备中 When 取消 Then 信号传到服务并阻止后续提交', async () => {
  /** 模拟一次准备与提交之间的可控异步边界。 */
  let release: (() => void) | undefined
  const ready = new Promise<void>((resolve) => { release = resolve })
  const controller = new AbortController()
  let committed = false
  let receivedSignal: AbortSignal | undefined
  const tools = buildInteractionDesignAgentTools({
    sessionId: 'session-fixed',
    sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildInteractionDesignAgentTools>[0]['sdk'],
    assertAccess() {},
    execute: (async (_method: string, _input: unknown, signal?: AbortSignal) => {
      receivedSignal = signal
      await ready
      signal?.throwIfAborted()
      committed = true
      return []
    }) as Parameters<typeof buildInteractionDesignAgentTools>[0]['execute'],
  })
  const pending = tools.find((item) => item.name === 'prototype_create')!.execute('running', { name: '测试', platform: 'mobile' }, controller.signal, undefined, {} as never)
  await Promise.resolve()
  controller.abort(new Error('准备期间取消'))
  release!()
  await expect(pending).rejects.toThrow('准备期间取消')
  expect(receivedSignal).toBe(controller.signal)
  expect(committed).toBe(false)
})

/** 多页固定版本用于验证投影与宿主合成，不访问真实项目。 */
function pageFixture(cancelOnRead?: AbortController) {
  /** 第二页正文刻意独特，便于发现上下文泄漏或意外覆盖。 */
  const document = {
    schemaVersion: 1 as const, id: 'prototype-1', revision: 3, createdAt: 1, updatedAt: 3,
    name: '多页原型', platform: 'mobile' as const, brief: '说明', groups: [{ id: 'g', name: '分组' }], entryPageId: 'home',
    pages: [{ id: 'home', groupId: 'g', name: '首页', html: '<h1>原正文</h1>' }, { id: 'other', groupId: 'g', name: '其他页', html: '<h1>OTHER_PAGE_BODY_NOT_FOR_CONTEXT</h1>', source: { path: 'src/other.html', hash: 'a'.repeat(64), kind: 'html' as const } }],
    flows: [{ id: 'next', fromPageId: 'home', elementId: 'go', targetPageId: 'other' }],
  }
  /** 记录真实领域命令和取消信号；返回固定快照模拟宿主读取。 */
  const calls: Array<{ method: string; input: unknown; signal?: AbortSignal }> = []
  const permissions: boolean[] = []
  const tools = buildInteractionDesignAgentTools({
    sessionId: 'session-fixed',
    sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildInteractionDesignAgentTools>[0]['sdk'],
    assertAccess(write) { permissions.push(write) },
    execute: (async (method: string, input: unknown, signal?: AbortSignal) => {
      calls.push({ method, input, signal })
      if (method === 'getVersion') { cancelOnRead?.abort(new Error('读取后取消')); return document }
      return { id: 'candidate-1', status: 'ready' }
    }) as Parameters<typeof buildInteractionDesignAgentTools>[0]['execute'],
  })
  return { document, calls, permissions, tools }
}

test('Given 多页原型 When 读取单页 Then 返回目录和目标正文而不返回其他页面HTML', async () => {
  const { tools, calls } = pageFixture()
  const result = await tools.find((item) => item.name === 'prototype_read_page')!.execute('read', { prototypeId: 'prototype-1', revision: 3, pageId: 'home' }, undefined, undefined, {} as never)
  const text = JSON.stringify(result)
  expect(text).toContain('原正文')
  expect(text).toContain('其他页')
  expect(text).not.toContain('OTHER_PAGE_BODY_NOT_FOR_CONTEXT')
  expect(calls).toEqual([{ method: 'getVersion', input: { sessionId: 'session-fixed', prototypeId: 'prototype-1', revision: 3 }, signal: undefined }])
  expect(INTERACTION_DESIGN_AGENT_READ_TOOL_NAMES as readonly string[]).toContain('prototype_read_page')
})

test('Given 固定基线与单页修改 When 提交单页候选 Then 宿主仅替换目标正文且两阶段贯穿权限信号', async () => {
  const { tools, document, calls, permissions } = pageFixture()
  const controller = new AbortController()
  const input = { prototypeId: 'prototype-1', baseRevision: 3, jobId: 'job-1', pageId: 'home', html: '<h1>修改</h1>', summary: '修改首页' }
  await tools.find((item) => item.name === 'prototype_propose_page')!.execute('propose', input, controller.signal, undefined, {} as never)
  expect(calls.map((call) => call.method)).toEqual(['getVersion', 'propose'])
  expect(calls.every((call) => call.signal === controller.signal)).toBe(true)
  expect(permissions).toEqual([true, true])
  /** 从领域请求检查完整候选，原版本对象必须保持不可变。 */
  const proposed = calls[1]!.input as { draft: { pages: typeof document.pages; groups: typeof document.groups; flows: typeof document.flows }; baseRevision: number; jobId: string; sessionId: string }
  expect(proposed.draft.pages[0]!.html).toBe(input.html)
  expect(proposed.draft.pages[1]).toEqual(document.pages[1]!)
  expect(proposed.draft.groups).toEqual(document.groups)
  expect(proposed.draft.flows).toEqual(document.flows)
  expect(proposed.baseRevision).toBe(3)
  expect(proposed.jobId).toBe('job-1')
  expect(proposed.sessionId).toBe('session-fixed')
  expect(document.pages[0]!.html).toBe('<h1>原正文</h1>')
})

test('Given 读取基线后单工具取消 When 提交单页候选 Then 不调用propose', async () => {
  const controller = new AbortController()
  const { tools, calls } = pageFixture(controller)
  await expect(tools.find((item) => item.name === 'prototype_propose_page')!.execute('cancel', { prototypeId: 'prototype-1', baseRevision: 3, jobId: 'job-1', pageId: 'home', html: '新正文', summary: '修改' }, controller.signal, undefined, {} as never)).rejects.toThrow('读取后取消')
  expect(calls.map((call) => call.method)).toEqual(['getVersion'])
})

test('Given 不存在页面或伪造额外字段 When 单页工具执行 Then 不创建候选', async () => {
  const { tools, calls } = pageFixture()
  const tool = tools.find((item) => item.name === 'prototype_propose_page')!
  const input = { prototypeId: 'prototype-1', baseRevision: 3, jobId: 'job-1', pageId: 'missing', html: '内容', summary: '修改' }
  await expect(tool.execute('missing', input, undefined, undefined, {} as never)).rejects.toThrow('页面不存在')
  await expect(tool.execute('forged', { ...input, sessionId: 'forged' }, undefined, undefined, {} as never)).rejects.toThrow('INVALID_INPUT')
  expect(calls.map((call) => call.method)).toEqual(['getVersion'])
})
