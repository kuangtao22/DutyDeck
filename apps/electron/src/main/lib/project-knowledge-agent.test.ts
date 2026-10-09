import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, KnowledgeEntry, KnowledgeSearchInput, KnowledgeSnapshot } from '@proma/shared'
import { createProjectKnowledgeAgent } from './project-knowledge-agent'
import { compactKnowledgeWorkflowStatus } from './project-knowledge-agent-maintenance'

/** 使用真实公开合同模拟一次普通前台回合；文件访问在服务层另有真实文件测试。 */
function fixture() {
  /** 可在异步操作中改变的权威会话记录。 */
  const state: {
    session: AgentSessionMeta
    initialized: boolean
    pendingTurns: number
    binding: string
    calls: string[]
  } = {
    session: { id: 'session-1', title: '项目对话', workspaceId: 'workspace-1', createdAt: 1, updatedAt: 1 },
    initialized: true, pendingTurns: 0, binding: 'root-1', calls: [],
  }
  /** 一条有明确来源的已确认决定。 */
  const entry: KnowledgeEntry = {
    id: 'entry-1', revision: 'rev-1', title: '登录方式', category: 'decisions', kind: 'decision',
    state: 'confirmed', freshness: 'current', summary: '使用短信登录',
    source: { kind: 'project-file', id: 'file-1', relativePath: 'docs/login.md', revision: 'hash-1' },
    byteSize: 18, indexedBytes: 18, truncated: false, metadataOnly: false, updatedAt: 1,
  }
  /** 测试可制造完成前的归属变化。 */
  let beforeReturn = (): void => undefined
  const options = {
    sessionId: 'session-1', toolMode: 'standard',
    getSession: () => state.session,
    getBinding: (workspaceId: string) => `${workspaceId}:${state.binding}`,
    assertRunActive: () => undefined,
    service: {
      getSnapshot: async (): Promise<KnowledgeSnapshot> => ({
        projectId: 'workspace-1', initialized: state.initialized, revision: 1, entries: [entry], totalEntries: 1,
        scan: { status: 'idle', discovered: 1, indexed: 1, skipped: 0, changed: 0 },
        maintenance: { enabled: false, dailyJobLimit: 20, generation: 0 }, pendingTurns: state.pendingTurns,
      }),
      search: async () => { state.calls.push('search'); beforeReturn(); return { revision: 1, items: [{ entry, snippet: '使用短信登录', line: 1, score: 10 }], total: 1, indexStatus: 'ready' as const } },
      read: async () => { state.calls.push('read'); beforeReturn(); return { entry, content: '使用短信登录', status: 'readable' as const, offset: 0, truncated: false } },
    },
  }
  return { state, options, entry, setBeforeReturn: (callback: () => void) => { beforeReturn = callback } }
}

describe('Agent 项目知识接入', () => {
  test('Given 当前回合具备维护能力 When 读取来源并构建上下文 Then 记录真实页并提示按Skill小批处理', async () => {
    const { options, entry } = fixture()
    let observed = 0
    const facade = createProjectKnowledgeAgent({
      ...options,
      maintenance: {
        next: async () => ({ refs: [], remaining: 1 }),
        observeRead: () => { observed += 1 },
        submit: async () => ({ status: 'unchanged', published: 0, refreshed: 0, skipped: 0, processedSources: 0, entryIds: [] }),
      },
    })
    await facade?.read(entry.id)
    expect(observed).toBe(1)
    const context = await facade?.buildContext('整理项目知识')
    expect(context).toContain('knowledge-maintenance Skill')
    expect(context).toContain('"pendingSources":1')
    expect(facade?.nextMaintenanceSources).toBeFunction()
    expect(facade?.submitMaintenance).toBeFunction()
  })

  test('Given 当前回合启用两步流程 When 构造Facade Then 只暴露proposal大纲文档与最新状态', async () => {
    const { options } = fixture()
    const calls: string[] = []
    const facade = createProjectKnowledgeAgent({
      ...options,
      maintenance: {
        next: async () => ({ refs: [], remaining: 0 }),
        observeRead: () => undefined,
        submit: async () => ({ status: 'unchanged', published: 0, refreshed: 0, skipped: 0, processedSources: 0, entryIds: [] }),
        status: async () => { calls.push('status'); return compactKnowledgeWorkflowStatus(await options.service.getSnapshot()) },
        proposePlan: async () => { calls.push('plan'); return compactKnowledgeWorkflowStatus(await options.service.getSnapshot()) },
        saveOutline: async () => { calls.push('outline'); return compactKnowledgeWorkflowStatus(await options.service.getSnapshot()) },
        writeDocument: async () => { calls.push('document'); return compactKnowledgeWorkflowStatus(await options.service.getSnapshot()) },
        copyAsset: async (input) => {
          calls.push('asset')
          return { relativePath: input.relativePath, documentRelativePath: `../${input.relativePath}`, contentRevision: 'asset', byteSize: 2 * 1024 * 1024 }
        },
      },
    })

    expect(facade?.nextMaintenanceSources).toBeUndefined()
    expect(facade?.submitMaintenance).toBeUndefined()
    await facade?.getWorkflowStatus?.()
    await facade?.proposeKnowledgePlan?.({ title: '项目知识', rootRelativePath: 'docs/knowledge', groups: [] })
    await facade?.saveKnowledgeOutline?.({ planRevision: 1, expectedRevision: 0, items: [] })
    await facade?.writeKnowledgeDocument?.({ planRevision: 1, outlineRevision: 1, itemId: 'overview', expectedRevision: null, content: '# 概览', summary: '概览', complete: false, evidence: [], userQuote: '当前用户原话' })
    await facade?.copyKnowledgeAsset?.({ planRevision: 1, outlineRevision: 1, itemId: 'overview', sourceEntryId: 'asset', sourceRevision: 'rev', relativePath: 'assets/source.psd' })
    expect(calls).toEqual(['status', 'plan', 'outline', 'document', 'asset'])
  })

  test('Given 最新快照含待确认proposal和已批准大纲 When 构建上下文 Then Agent获得真实版本与itemId', async () => {
    const { options } = fixture()
    const facade = createProjectKnowledgeAgent({ ...options, service: {
      ...options.service,
      getSnapshot: async () => ({
        ...await options.service.getSnapshot(),
        workflow: {
          paused: false,
          proposal: { id: 'plan-new', revision: 3, title: '新版', rootRelativePath: 'docs/knowledge', groups: [], createdAt: 3 },
          approved: { id: 'plan-approved', revision: 2, title: '已批准', rootRelativePath: 'docs/knowledge', groups: [], createdAt: 2, confirmedAt: 2 },
          outline: { revision: 4, planRevision: 2, relativePath: 'OUTLINE.md', items: [{ id: 'overview', groupId: 'product', title: '概览', relativePath: 'product/overview.md', summary: '概览', sections: ['范围'], status: 'pending' }] },
        },
      }),
    } })

    const context = await facade?.buildContext('更新知识库')

    expect(context).toContain('"proposal":{"id":"plan-new","revision":3')
    expect(context).toContain('"approved":{"id":"plan-approved","revision":2')
    expect(context).toContain('"id":"overview"')
    expect(context).toContain('"revision":4')
  })

  test('Given workflow包含大量来源与章节 When 构建上下文和分页状态 Then 保持有界且可继续读取', async () => {
    const { options } = fixture()
    const groups = Array.from({ length: 30 }, (_, index) => ({
      id: `group-${index}`, title: `分组${index}`, summary: '分组摘要'.repeat(100),
      sources: Array.from({ length: 80 }, (__, sourceIndex) => ({ entryId: `source-${index}-${sourceIndex}`, revision: `revision-${sourceIndex}` })),
      gaps: Array.from({ length: 20 }, () => '缺口'), outputs: Array.from({ length: 20 }, () => '文档'),
    }))
    const items = Array.from({ length: 30 }, (_, index) => ({
      id: `item-${index}`, groupId: `group-${index}`, title: `主题${index}`, relativePath: `group-${index}/item.md`,
      summary: '主题摘要'.repeat(100), sections: Array.from({ length: 40 }, (__, sectionIndex) => `章节-${index}-${sectionIndex}`),
      status: 'pending' as const,
    }))
    const largeSnapshot = {
      ...await options.service.getSnapshot(),
      workflow: {
        paused: false,
        proposal: { id: 'proposal-large', revision: 2, title: '大计划', rootRelativePath: 'docs/knowledge', groups, createdAt: 2 },
        approved: { id: 'approved-large', revision: 1, title: '已批准', rootRelativePath: 'docs/knowledge', groups, createdAt: 1, confirmedAt: 1 },
        outline: { revision: 3, planRevision: 1, relativePath: '索引.md', items },
      },
    }
    const facade = createProjectKnowledgeAgent({ ...options, service: { ...options.service, getSnapshot: async () => largeSnapshot } })

    const context = await facade?.buildContext('继续整理')
    const first = compactKnowledgeWorkflowStatus(largeSnapshot)
    const second = compactKnowledgeWorkflowStatus(largeSnapshot, first.nextOffset)

    expect(Buffer.byteLength(context ?? '', 'utf8')).toBeLessThan(24 * 1024)
    expect(context).toContain('"groupCount":30')
    expect(context).not.toContain('source-0-0')
    expect(first.proposal?.groups).toHaveLength(4)
    expect(first.outline?.items).toHaveLength(4)
    expect(first.nextOffset).toBe(4)
    expect(second.offset).toBe(4)
    expect(second.proposal?.groups[0]?.id).toBe('group-4')
  })

  test.each(['proposal', 'approved', 'paused'] as const)('Given 知识库处于%s且记忆含相关内容 When 构建上下文 Then 独立记忆作为有界协作背景', async (phase) => {
    const { options, entry } = fixture()
    entry.source = { kind: 'memory-file', id: 'memory:decision', relativePath: 'decisions.md', revision: 'memory-rev' }
    const scopes: Array<KnowledgeSearchInput['scope']> = []
    /** 记录内部来源过滤，确保记忆不会被同页高分项目文件挤出。 */
    const sourceKinds: Array<KnowledgeSearchInput['sourceKind']> = []
    const facade = createProjectKnowledgeAgent({ ...options, service: {
      ...options.service,
      getSnapshot: async () => ({
        ...await options.service.getSnapshot(), pendingTurns: 0,
        workflow: { paused: phase === 'paused', ...(phase === 'proposal'
          ? { proposal: { id: 'proposal', revision: 1, title: '知识计划', rootRelativePath: 'docs/knowledge', groups: [], createdAt: 1 } }
          : { approved: { id: 'approved', revision: 1, title: '知识计划', rootRelativePath: 'docs/knowledge', groups: [], createdAt: 1, confirmedAt: 2 } }) },
      }),
      search: async (input) => {
        scopes.push(input.scope)
        sourceKinds.push(input.sourceKind)
        return input.scope === 'sources' && input.sourceKind === 'memory-file'
          ? { revision: 1, items: [{ entry, snippet: '记忆中的本地存储决定', line: 3, score: 10 }], total: 1, indexStatus: 'ready' }
          : { revision: 1, items: [], total: 0, indexStatus: 'ready' }
      },
    } })

    const context = await facade?.buildContext('本地存储')

    expect(scopes).toEqual(['knowledge', 'sources'])
    expect(sourceKinds).toEqual([undefined, 'memory-file'])
    expect(context).toContain('记忆中的本地存储决定')
    expect(context).toContain('"relatedMemoryEvidence"')
    expect(context).not.toContain('pending-migration')
    expect(context).toContain('记忆独立维护，不代表待迁移或待同步')
  })

  test('Given 新版正文处于待核验状态 When 新回合构建上下文 Then 可用作低信任材料且保留状态', async () => {
    const { options, entry } = fixture()
    entry.source = { kind: 'managed', id: 'vault:workspace-1:overview', revision: 'source-rev' }
    entry.state = 'draft'
    entry.freshness = 'unverified'
    const facade = createProjectKnowledgeAgent(options)

    const context = await facade?.buildContext('项目概览')

    expect(context).toContain('使用短信登录')
    expect(context).toContain('"state":"draft"')
    expect(context).toContain('"freshness":"unverified"')
  })

  test('Given 原文件还未提炼 When 新回合构建上下文 Then 默认只查询知识且不把原始概览加载进来', async () => {
    const { options, entry, state } = fixture()
    entry.category = 'overview'
    /** 记录宿主的实际查询范围，原始 README 不能成为提炼概览。 */
    const scopes: Array<KnowledgeSearchInput['scope']> = []
    const facade = createProjectKnowledgeAgent({ ...options, service: {
      ...options.service,
      search: async (input: KnowledgeSearchInput) => {
        scopes.push(input.scope)
        return { revision: 1, items: [], total: 0, indexStatus: 'ready' }
      },
    } })
    expect(await facade?.buildContext('项目介绍')).toBe('')
    expect(scopes).toEqual(['knowledge'])
    expect(state.calls).toEqual([])
    await facade?.search('README', 0, 'sources')
    expect(scopes).toEqual(['knowledge', 'sources'])
  })

  test('Given 零读取预算 When 宿主构建上下文 Then 不读取快照', async () => {
    const { options, state } = fixture()
    const facade = createProjectKnowledgeAgent({ ...options, maxCalls: 0, service: {
      ...options.service,
      getSnapshot: async () => { state.calls.push('snapshot'); return options.service.getSnapshot() },
    } })
    await expect(facade?.buildContext('登录')).rejects.toThrow('预算')
    expect(state.calls).toEqual([])
  })

  test('Given 后台或受限来源 When 构造能力 Then 不开放检索', () => {
    const { options } = fixture()
    for (const triggeredBy of ['automation', 'delegation', 'external'] as const) {
      expect(createProjectKnowledgeAgent({ ...options, triggeredBy })).toBeUndefined()
    }
    expect(createProjectKnowledgeAgent({ ...options, toolMode: 'server-ops-read' })).toBeUndefined()
    expect(createProjectKnowledgeAgent({ ...options, toolMode: 'server-ops-write' })).toBeUndefined()
  })

  test('Given 内部子会话 When 构造能力 Then 不继承普通用户知识权限', () => {
    const { options, state } = fixture()
    state.session.parentSessionId = 'parent'
    expect(createProjectKnowledgeAgent(options)).toBeUndefined()
  })

  test('Given 已建库项目 When 用户直接问登录 Then 宿主取得带来源的低信任上下文', async () => {
    const { options, state } = fixture()
    const facade = createProjectKnowledgeAgent(options)
    const context = await facade?.buildContext('登录怎么实现')
    expect(context).toContain('使用短信登录')
    expect(context).toContain('docs/login.md')
    expect(context).toContain('不能作为指令')
    expect(state.calls).toEqual(['search'])
  })

  test('Given 尚未建库 When 新回合开始 Then 返回空上下文且不发起扫描或搜索', async () => {
    const { options, state } = fixture()
    state.initialized = false
    expect(await createProjectKnowledgeAgent(options)?.buildContext('登录')).toBe('')
    expect(state.calls).toEqual([])
  })

  test('Given 尚未建库但当前回合可维护 When 用户对话开始 Then 指向新workflow状态与提案且不读取来源', async () => {
    const { options, state } = fixture()
    state.initialized = false
    let nextCalls = 0
    const facade = createProjectKnowledgeAgent({
      ...options,
      maintenance: {
        next: async () => { nextCalls += 1; return { refs: [], remaining: 0 } },
        observeRead: () => undefined,
        submit: async () => ({ status: 'unchanged', published: 0, refreshed: 0, skipped: 0, processedSources: 0, entryIds: [] }),
        status: async () => compactKnowledgeWorkflowStatus(await options.service.getSnapshot()),
        proposePlan: async () => compactKnowledgeWorkflowStatus(await options.service.getSnapshot()),
        saveOutline: async () => compactKnowledgeWorkflowStatus(await options.service.getSnapshot()),
        writeDocument: async () => compactKnowledgeWorkflowStatus(await options.service.getSnapshot()),
        copyAsset: async (input) => ({ relativePath: input.relativePath, documentRelativePath: input.relativePath, contentRevision: 'asset', byteSize: 2 * 1024 * 1024 }),
      },
    })

    const context = await facade?.buildContext('决定：使用本地存储')

    expect(context).toContain('proma_knowledge_status')
    expect(context).toContain('proma_knowledge_plan')
    expect(context).not.toContain('proma_knowledge_submit')
    expect(nextCalls).toBe(0)
    expect(state.calls).toEqual([])
  })

  test('Given 异步读取中会话换项目 When 返回 Then 拒绝旧项目结果', async () => {
    const context = fixture()
    const facade = createProjectKnowledgeAgent(context.options)
    context.setBeforeReturn(() => { context.state.session.workspaceId = 'workspace-2' })
    await expect(facade?.read('entry-1')).rejects.toThrow('归属')
  })

  test('Given 当前回合预算已耗尽 When 再次读取 Then 不继续读文件', async () => {
    const { options, state } = fixture()
    const facade = createProjectKnowledgeAgent({ ...options, maxCalls: 1 })
    await facade?.read('entry-1')
    await expect(facade?.read('entry-1')).rejects.toThrow('预算')
    expect(state.calls).toEqual(['read'])
  })

  test('Given 概览来源已变化 When 构建上下文 Then 不注入缓存中的旧摘要', async () => {
    const { options, entry } = fixture()
    entry.category = 'overview'
    const facade = createProjectKnowledgeAgent({ ...options, service: {
      ...options.service,
      search: async () => ({ revision: 1, items: [], total: 0, indexStatus: 'ready' }),
      read: async () => ({ entry, content: '', status: 'changed', offset: 0, truncated: false }),
    } })
    expect(await facade?.buildContext('项目概览')).toBe('')
  })

  test('Given snapshot search recent 已消费调用预算 When 再读取 Then 共享预算阻止第四次调用', async () => {
    const { options, state } = fixture()
    state.pendingTurns = 1
    const facade = createProjectKnowledgeAgent({
      ...options,
      maxCalls: 3,
      service: {
        ...options.service,
        getSnapshot: async () => {
          state.calls.push('snapshot')
          return options.service.getSnapshot()
        },
      },
      recent: async () => {
        state.calls.push('recent')
        return [{ sessionId: 'session-1', messageId: 'message-1', text: '尚未整理的登录要求', state: 'unprocessed' }]
      },
    })

    expect(await facade?.buildContext('登录')).toContain('尚未整理的登录要求')
    await expect(facade?.read('entry-1')).rejects.toThrow('预算')
    expect(state.calls).toEqual(['snapshot', 'search', 'recent'])
  })

  test('Given recent 结果超过剩余字节预算 When 再读取 Then recent 与工具共享字节预算', async () => {
    const { options, state } = fixture()
    state.pendingTurns = 1
    const facade = createProjectKnowledgeAgent({
      ...options,
      maxBytes: 2 * 1024,
      recent: async () => {
        state.calls.push('recent')
        return [{
          sessionId: 'session-1',
          messageId: 'message-large',
          text: '待整理原文'.repeat(1_000),
          state: 'unprocessed',
        }]
      },
    })

    await expect(facade?.buildContext('登录')).rejects.toThrow('剩余读取预算')
    await expect(facade?.read('entry-1')).rejects.toThrow('预算')
    expect(state.calls).toEqual(['search', 'recent'])
  })

  test('Given 有两个待整理回合 When 构建上下文 Then pendingTurns 文本与结构化数量一致', async () => {
    const { options, state } = fixture()
    state.pendingTurns = 2
    const facade = createProjectKnowledgeAgent({
      ...options,
      recent: async () => [{
        sessionId: 'session-1',
        messageId: 'message-1',
        text: '第一条尚未整理原文',
        state: 'unprocessed',
      }],
    })

    const context = await facade?.buildContext('登录')
    expect(context).toContain('pendingTurns 只统计待处理会话队列，与记忆是否完整无关')
    expect(context).toContain('"pendingTurns":2')
    expect(context).toContain('第一条尚未整理原文')
  })

  test('Given recent 读取期间项目或来源绑定变化 When 返回 Then 拒绝迟到原文', async () => {
    for (const changeAuthority of [
      (state: ReturnType<typeof fixture>['state']) => { state.session.workspaceId = 'workspace-2' },
      (state: ReturnType<typeof fixture>['state']) => { state.binding = 'root-2' },
    ]) {
      const { options, state } = fixture()
      state.pendingTurns = 1
      const facade = createProjectKnowledgeAgent({
        ...options,
        recent: async () => {
          changeAuthority(state)
          return [{
            sessionId: 'session-1',
            messageId: 'message-late',
            text: '不应进入新项目的迟到原文',
            state: 'unprocessed',
          }]
        },
      })

      await expect(facade?.buildContext('登录')).rejects.toThrow('归属')
    }
  })
})
