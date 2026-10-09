import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  AgentSessionMeta,
  KnowledgeEntry,
  KnowledgeReadResult,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
  KnowledgeWorkflow,
} from '@proma/shared'
import {
  buildKnowledgeGenerationPendingPrompt,
  buildKnowledgeMaintenancePendingPrompt,
  buildKnowledgePlanAdjustmentPendingPrompt,
  ProjectKnowledgeResourcesView,
  ProjectKnowledgeTabShell,
  selectKnowledgeMaintenanceSession,
} from './ProjectKnowledgeTab'
import { buildKnowledgePlanSelection, KnowledgeWorkflowPanel } from './KnowledgeWorkflowPanel'

/** 创建固定知识条目，测试只覆盖用户可观察的目录信息。 */
function createEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: 'entry-1',
    revision: 'rev-1',
    title: '产品路线图',
    category: 'planning',
    kind: 'document',
    state: 'confirmed',
    freshness: 'current',
    summary: '记录当前季度的产品目标与交付顺序。',
    source: {
      kind: 'project-file',
      id: 'docs/roadmap.md',
      relativePath: 'docs/roadmap.md',
      revision: 'source-1',
    },
    byteSize: 4096,
    indexedBytes: 4096,
    truncated: false,
    metadataOnly: false,
    updatedAt: Date.UTC(2026, 9, 7),
    ...overrides,
  }
}

/** 创建固定知识库快照。 */
function createSnapshot(overrides: Partial<KnowledgeSnapshot> = {}): KnowledgeSnapshot {
  return {
    projectId: 'workspace-1',
    initialized: true,
    revision: 3,
    entries: [],
    totalEntries: 0,
    scan: {
      status: 'idle',
      discovered: 0,
      indexed: 0,
      skipped: 0,
      changed: 0,
    },
    maintenance: {
      enabled: false,
      dailyJobLimit: 0,
      generation: 0,
    },
    pendingTurns: 0,
    ...overrides,
  }
}

/** 创建固定分页目录结果。 */
function createSearchResult(entries: KnowledgeEntry[]): KnowledgeSearchResult {
  return {
    revision: 3,
    items: entries.map((entry) => ({ entry, snippet: entry.summary, line: 1, score: 1 })),
    total: entries.length,
    indexStatus: 'ready',
  }
}

const noop = (): void => undefined

describe('项目知识库 Agent 提炼', () => {
  test('Given 整理会话属于同项目且为标准普通会话 When 继续生成 Then 复用整理会话', () => {
    const session: AgentSessionMeta = {
      id: 'agent-1',
      title: '当前会话',
      workspaceId: 'workspace-1',
      toolMode: 'standard',
      createdAt: 1,
      updatedAt: 1,
    }

    expect(selectKnowledgeMaintenanceSession([session], 'agent-1', 'workspace-1')).toBe('agent-1')
  })

  test('Given 整理会话不属于项目或不是标准普通会话 When 继续生成 Then 要求新建项目会话', () => {
    const sessions: AgentSessionMeta[] = [{
      id: 'agent-1',
      title: '运维会话',
      workspaceId: 'workspace-2',
      toolMode: 'server-ops-read',
      createdAt: 1,
      updatedAt: 1,
    }]

    expect(selectKnowledgeMaintenanceSession(sessions, 'agent-1', 'workspace-1')).toBeNull()
  })

  test('Given 已选择目标会话 When 构造维护任务 Then 自动发送并显式调用知识维护 Skill', () => {
    const prompt = buildKnowledgeMaintenancePendingPrompt('agent-1')
    expect(prompt).toEqual(expect.objectContaining({
      sessionId: 'agent-1',
      autoSend: true,
      mentionedSkills: ['knowledge-maintenance'],
    }))
    expect(prompt.message).toContain('提交分组 proposal')
    expect(prompt.message).toContain('停下来等待用户确认')
    expect(prompt.message).toContain('不要保存大纲')
  })

  test('Given 用户已确认分组 When 构造生成任务 Then 复用原会话并一次完成大纲和真实文件', () => {
    const prompt = buildKnowledgeGenerationPendingPrompt('agent-1', 4)
    expect(prompt).toEqual(expect.objectContaining({ sessionId: 'agent-1', autoSend: true }))
    expect(prompt.message).toContain('approved')
    expect(prompt.message).toContain('保存 outline')
    expect(prompt.message).toContain('逐项读取必要来源并写入真实 Markdown 文件')
    expect(prompt.message).toContain('无需逐篇等待审批')
  })

  test('Given 用户要求调整清单 When 构造任务 Then 绑定当前版本并要求重新提案而不自动确认', () => {
    const prompt = buildKnowledgePlanAdjustmentPendingPrompt('agent-1', 'plan-1', 2, '合并产品与上线分组，并把根目录改为 docs/handbook')
    expect(prompt).toEqual(expect.objectContaining({ sessionId: 'agent-1', autoSend: true }))
    expect(prompt.message).toContain('plan-1')
    expect(prompt.message).toContain('版本 2')
    expect(prompt.message).toContain('合并产品与上线分组')
    expect(prompt.message).toContain('重新提交 proposal')
    expect(prompt.message).toContain('不要确认计划')
  })
})

describe('项目知识库两步工作流', () => {
  /** 创建自由分组工作流，避免测试依赖固定业务分类。 */
  function createWorkflow(overrides: Partial<KnowledgeWorkflow> = {}): KnowledgeWorkflow {
    return {
      paused: false,
      proposal: {
        id: 'plan-1', revision: 2, title: '项目知识库', rootRelativePath: '知识库', createdAt: 1,
        groups: [
          { id: 'group-a', title: '产品规则', summary: '整理产品规则和边界。', sources: [{ entryId: 'source-1', revision: 'r1' }], gaps: ['缺少退款说明'], outputs: ['产品规则.md'] },
          { id: 'group-b', title: '上线手册', summary: '整理上线流程。', sources: [], gaps: [], outputs: ['上线手册.md'] },
        ],
      },
      ...overrides,
    }
  }

  test('Given 用户取消一个分组并修改另一个名称 When 构造确认选择 Then 只提交选中分组和新名称', () => {
    const proposal = createWorkflow().proposal!
    expect(buildKnowledgePlanSelection(
      proposal,
      new Set(['group-b']),
      { 'group-b': '发布运行手册' },
    )).toEqual([{ id: 'group-b', title: '发布运行手册' }])
  })

  test('Given Agent 已提交 proposal When 展示工作流 Then 显示具体来源、保守核对状态和调整入口', () => {
    let confirmCalls = 0
    const html = renderToStaticMarkup(<KnowledgeWorkflowPanel
      workflow={createWorkflow()}
      entries={[createEntry({
        id: 'source-1',
        title: '产品说明',
        source: { kind: 'project-file', id: 'docs/product.md', relativePath: 'docs/product.md', revision: 'r1' },
      })]}
      pendingAction={null}
      error={null}
      onConfirm={() => { confirmCalls += 1 }}
      onPause={noop}
      onSelectEntryId={noop}
      onRequestAdjustment={noop}
    />)
    expect(html).toContain('确认知识库范围')
    expect(html).toContain('产品规则')
    expect(html).toContain('整理产品规则和边界')
    expect(html).toContain('产品说明')
    expect(html).toContain('docs/product.md')
    expect(html).toContain('未核对')
    expect(html).toContain('调整清单')
    expect(html).toContain('缺少退款说明')
    expect(html).toContain('产品规则.md')
    expect(html).toContain('知识库')
    expect(confirmCalls).toBe(0)
  })

  test('Given 大纲包含各种状态及首页外条目 When 展示目录 Then 仅可读取状态按 entryId 打开', () => {
    const readyEntry = createEntry({ id: 'entry-ready', title: '发布流程' })
    const workflow = createWorkflow({
      proposal: undefined,
      approved: { ...createWorkflow().proposal!, confirmedAt: 2 },
      outline: {
        revision: 1, planRevision: 2, relativePath: '知识库/大纲.md',
        items: [
          { id: 'item-1', groupId: 'group-a', title: '产品原则', relativePath: '产品/原则.md', summary: '待生成', sections: ['目标'], status: 'pending' },
          { id: 'item-2', groupId: 'group-b', title: '发布流程', relativePath: '运维/发布.md', summary: '已生成', sections: ['步骤'], entryId: 'entry-ready', status: 'ready' },
          { id: 'item-3', groupId: 'group-b', title: '首页外文档', relativePath: '运维/扩展.md', summary: '已生成', sections: ['步骤'], entryId: 'entry-outside-page', status: 'ready' },
          { id: 'item-4', groupId: 'group-b', title: '部分文档', relativePath: '运维/部分.md', summary: '部分完成', sections: ['步骤'], entryId: 'entry-partial', status: 'partial' },
          { id: 'item-5', groupId: 'group-b', title: '缺失文档', relativePath: '运维/缺失.md', summary: '缺少依据', sections: ['步骤'], entryId: 'entry-missing', status: 'missing' },
        ],
      },
    })
    const html = renderToStaticMarkup(<KnowledgeWorkflowPanel workflow={workflow} entries={[readyEntry]} pendingAction={null} error={null} onConfirm={noop} onPause={noop} onSelectEntryId={noop} onRequestAdjustment={noop} />)
    expect(html).toContain('产品')
    expect(html).toContain('运维')
    expect(html).toContain('等待生成')
    expect(html).toContain('打开发布流程')
    expect(html).toContain('打开首页外文档')
    expect(html).toContain('打开部分文档')
    expect(html).toContain('部分完成')
    expect(html).toContain('缺少依据')
    expect(html).not.toContain('打开产品原则')
    expect(html).not.toContain('打开缺失文档')
  })

  test('Given proposal 来源仅支持元数据 When 展示覆盖状态 Then 明确标记暂不支持', () => {
    const html = renderToStaticMarkup(<KnowledgeWorkflowPanel
      workflow={createWorkflow()}
      entries={[createEntry({ id: 'source-1', title: '设计稿', metadataOnly: true, source: { kind: 'project-file', id: 'design.fig', relativePath: 'design.fig', revision: 'r1' } })]}
      pendingAction={null}
      error={null}
      onConfirm={noop}
      onPause={noop}
      onSelectEntryId={noop}
      onRequestAdjustment={noop}
    />)
    expect(html).toContain('暂不支持')
  })

  test('Given 宿主记录来源已读取 When 展示覆盖状态 Then 标记已读相关页', () => {
    const workflow = createWorkflow()
    const proposal = workflow.proposal!
    workflow.proposal = {
      ...proposal,
      groups: [{ ...proposal.groups[0]!, sources: [{ entryId: 'source-1', revision: 'r1', coverage: 'read' }] }, proposal.groups[1]!],
    }
    const html = renderToStaticMarkup(<KnowledgeWorkflowPanel
      workflow={workflow}
      entries={[createEntry({ id: 'source-1', title: '产品说明' })]}
      pendingAction={null}
      error={null}
      onConfirm={noop}
      onPause={noop}
      onSelectEntryId={noop}
      onRequestAdjustment={noop}
    />)
    expect(html).toContain('已读相关页')
  })
})

describe('项目知识库知识与来源视图', () => {
  test('Given 打开项目知识库 When 渲染统一容器 Then 顶部提供独立知识库和记忆Tabs', () => {
    const html = renderToStaticMarkup(
      <ProjectKnowledgeTabShell
        activeView="knowledge"
        onActiveViewChange={noop}
        knowledge={<div>提炼知识内容</div>}
        sources={<div>来源目录内容</div>}
        memory={<div>原记忆编辑器</div>}
      />,
    )

    expect(html).toContain('知识')
    expect(html).not.toContain('原始资料与历史')
    expect(html).toContain('来源资料')
    expect(html).not.toContain('旧记忆')
    expect((html.match(/role="tab"/g) ?? []).length).toBe(2)
    expect(html).toContain('提炼知识内容')
    expect(html).not.toContain('来源目录内容')
    expect(html).not.toContain('原记忆编辑器')
  })

  test('Given 尚未建库 When 打开知识页 Then 提供显式建库入口与空态说明', () => {
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="knowledge"
        snapshot={createSnapshot({ initialized: false })}
        result={null}
        selectedRead={null}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
      />,
    )

    expect(html).toContain('建立知识库')
    expect(html).toContain('尚未建立项目知识库')
    expect(html).not.toContain('取消扫描')
    expect(html).not.toContain('全部分类')
    expect(html).not.toContain('按业务分类筛选')
  })

  test('Given 来源已扫描但尚无提炼结果 When 打开知识页 Then 不展示原文件并引导 Agent 提炼', () => {
    const sourceEntry = createEntry({ title: '项目路线图源文件' })
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="knowledge"
        snapshot={createSnapshot({ totalEntries: 18, knowledgeCount: 0, sourceCount: 18 })}
        result={createSearchResult([])}
        selectedRead={null}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        workflow={<div>待确认知识方案</div>}
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
      />,
    )

    expect(html).toContain('尚未提炼知识')
    expect(html).toContain('新建当前项目的 Agent 对话')
    expect(html).toContain('知识维护 Skill')
    expect(html).toContain('待确认知识方案')
    expect(html).not.toContain('知识库操作')
    expect(html).not.toContain('整理受管资料')
    expect(html).not.toContain('预览记忆整理建议')
    expect(html).not.toContain('渠道')
    expect(html).not.toContain('每日预算')
    expect(html).not.toContain(sourceEntry.title)
  })

  test('Given 快照已更新但目录仍是旧空结果 When 渲染知识页 Then 展示刷新态而不误报尚未提炼', () => {
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="knowledge"
        snapshot={createSnapshot({ revision: 4, knowledgeCount: 6 })}
        result={{ ...createSearchResult([]), revision: 3 }}
        selectedRead={null}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
      />,
    )

    expect(html).toContain('正在更新知识')
    expect(html).not.toContain('尚未提炼知识')
  })

  test('Given 快照已更新且旧目录有内容 When 等待新搜索 Then 保留旧列表并标明正在更新', () => {
    const entry = createEntry({ title: '仍可阅读的旧目录项' })
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="knowledge"
        snapshot={createSnapshot({ revision: 4, knowledgeCount: 2 })}
        result={{ ...createSearchResult([entry]), revision: 3 }}
        selectedRead={null}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
      />,
    )

    expect(html).toContain('仍可阅读的旧目录项')
    expect(html).toContain('正在更新知识')
  })

  test('Given 同版本搜索为空但快照已有知识 When 无筛选 Then 提示待核验而非尚未提炼', () => {
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="knowledge"
        snapshot={createSnapshot({ knowledgeCount: 6 })}
        result={createSearchResult([])}
        selectedRead={null}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
      />,
    )

    expect(html).toContain('已有知识待核验')
    expect(html).not.toContain('尚未提炼知识')
  })

  test('Given 扫描正在运行 When 展示进度 Then 分别显示发现、已读取文本、跳过和取消动作', () => {
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="sources"
        snapshot={createSnapshot({
          scan: {
            status: 'running',
            discovered: 8,
            indexed: 3,
            skipped: 2,
            changed: 1,
            message: '已跳过 2 个凭据文件',
          },
        })}
        result={createSearchResult([])}
        selectedRead={null}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
      />,
    )

    expect(html).toContain('发现 8')
    expect(html).toContain('已读取文本 3')
    expect(html).toContain('跳过 2')
    expect(html).toContain('已跳过 2 个凭据文件')
    expect(html).toContain('取消扫描')
    expect(html).toContain('来源更新 1 个')
    expect(html).not.toContain('%')
  })

  test('Given 仅元数据资产 When 浏览并打开 Then 明确说明没有可读取正文', () => {
    const entry = createEntry({
      title: '首页视觉稿',
      kind: 'asset',
      category: 'design',
      state: 'indexed',
      metadataOnly: true,
      indexedBytes: 0,
      source: {
        kind: 'project-file',
        id: 'design/home.png',
        relativePath: 'design/home.png',
        revision: 'image-1',
      },
    })
    const selectedRead: KnowledgeReadResult = {
      entry,
      content: '',
      status: 'metadata-only',
      offset: 0,
      truncated: false,
    }
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="sources"
        snapshot={createSnapshot({ entries: [entry], totalEntries: 1 })}
        result={createSearchResult([entry])}
        selectedRead={selectedRead}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
      />,
    )

    expect(html).toContain('仅元数据')
    expect(html).toContain('该来源只登记了元数据，尚无可读取的正文')
    expect(html).not.toContain('已确认')
    expect(html).not.toContain('加载下一页正文')
  })

  test('Given 来源正文已建立索引 When 浏览来源资料 Then 显示已索引而不冒充提炼知识', () => {
    const entry = createEntry({ state: 'indexed', source: { kind: 'project-file', id: 'README.md', relativePath: 'README.md', revision: 'source-2' } })
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="sources"
        snapshot={createSnapshot({ entries: [entry], totalEntries: 1, sourceCount: 1 })}
        result={createSearchResult([entry])}
        selectedRead={null}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
      />,
    )

    expect(html).toContain('已索引')
    expect(html).not.toContain('已确认')
    expect(html).not.toContain('已提取')
  })

  test('Given 提炼知识带有证据 When 打开知识正文 Then 展示可追溯依据', () => {
    const entry = createEntry({
      title: '离线优先是当前架构原则',
      kind: 'decision',
      source: { kind: 'managed', id: 'architecture/offline-first', revision: 'managed-1' },
      evidence: [{ entryId: 'source-1', revision: 'source-rev-1', quote: '业务数据优先保存在本地。' }],
    })
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="knowledge"
        snapshot={createSnapshot({ entries: [entry], totalEntries: 2, knowledgeCount: 1, sourceCount: 1 })}
        result={createSearchResult([entry])}
        selectedRead={{ entry, content: '离线优先是当前架构原则。', status: 'readable', offset: 0, truncated: false }}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
        onSelectEvidence={noop}
      />,
    )

    expect(html).toContain('提炼依据')
    expect(html).toContain('业务数据优先保存在本地')
  })

  test('Given 同一来源版本有多段引文且含完全重复项 When 查看提炼依据 Then 多段保留且完全重复只显示一次', () => {
    const entry = createEntry({
      source: { kind: 'managed', id: 'architecture/multi-evidence', revision: 'managed-2' },
      evidence: [
        { entryId: 'source-1', revision: 'source-rev-1', quote: '第一段依据。' },
        { entryId: 'source-1', revision: 'source-rev-1', quote: '第二段依据。' },
        { entryId: 'source-1', revision: 'source-rev-1', quote: '第一段依据。' },
      ],
    })
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="knowledge"
        snapshot={createSnapshot({ knowledgeCount: 1 })}
        result={createSearchResult([entry])}
        selectedRead={{ entry, content: '提炼正文', status: 'readable', offset: 0, truncated: false }}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
      />,
    )

    expect(html.split('第一段依据').length - 1).toBe(1)
    expect(html.split('第二段依据').length - 1).toBe(1)
  })

  test('Given 提炼知识仅分析了部分来源正文 When 查看知识详情 Then 提示查看来源全文', () => {
    const entry = createEntry({
      source: { kind: 'managed', id: 'architecture/partial', revision: 'managed-partial' },
      truncated: true,
      evidence: [{ entryId: 'source-1', revision: 'source-rev-1', quote: '前段可核验内容。' }],
    })
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="knowledge"
        snapshot={createSnapshot({ knowledgeCount: 1, sourceCount: 1 })}
        result={createSearchResult([entry])}
        selectedRead={{ entry, content: '提炼正文', status: 'readable', offset: 0, truncated: false }}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
      />,
    )

    expect(html).toContain('部分依据仅分析了前段，可查看来源全文')
  })

  test('Given 来源版本已变化且正文被清空 When 查看详情 Then 引导更新知识库重新核验', () => {
    const entry = createEntry({ freshness: 'changed' })
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="sources"
        snapshot={createSnapshot({ sourceCount: 1 })}
        result={createSearchResult([entry])}
        selectedRead={{ entry, content: '', status: 'changed', offset: 0, truncated: false }}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
      />,
    )

    expect(html).toContain('来源已发生变化，请更新知识库后重新核验')
    expect(html).not.toContain('下方内容来自当前可读取版本')
  })

  test('Given 从知识证据打开真实来源 When 顶层仍在知识页 Then 按来源状态展示且不提供知识审核', () => {
    const sourceEntry = createEntry({
      title: '架构说明原文',
      state: 'confirmed',
      source: { kind: 'project-file', id: 'docs/architecture.md', relativePath: 'docs/architecture.md', revision: 'source-rev-2' },
    })
    const html = renderToStaticMarkup(
      <ProjectKnowledgeResourcesView
        scope="knowledge"
        snapshot={createSnapshot({ knowledgeCount: 1, sourceCount: 1, totalEntries: 2 })}
        result={createSearchResult([])}
        selectedRead={{ entry: sourceEntry, content: '本地优先架构说明。', status: 'readable', offset: 0, truncated: false }}
        loading={false}
        searching={false}
        reading={false}
        actionPending={false}
        error={null}
        query=""
        category="all"
        onQueryChange={noop}
        onCategoryChange={noop}
        onScan={noop}
        onCancelScan={noop}
        onRetry={noop}
        onSelectEntry={noop}
        onLoadMore={noop}
        onLoadMoreContent={noop}
        onClosePreview={noop}
        onReviewEntry={noop}
      />,
    )

    expect(html).toContain('已读取文本')
    expect(html).not.toContain('已确认')
    expect(html).not.toContain('确认资料')
    expect(html).not.toContain('排除条目')
  })

  test('Given 用户切换到记忆文件 When 渲染统一容器 Then 原记忆入口仍然可达', () => {
    const html = renderToStaticMarkup(
      <ProjectKnowledgeTabShell
        activeView="memory"
        onActiveViewChange={noop}
        knowledge={<div>知识内容</div>}
        sources={<div>来源资料内容</div>}
        memory={<div>原记忆编辑器</div>}
      />,
    )

    expect(html).toContain('知识')
    expect(html).toContain('记忆')
    expect(html).not.toContain('原始资料与历史')
    expect(html).not.toContain('旧记忆')
    expect(html).toContain('原记忆编辑器')
    expect(html).toContain('知识内容')
    expect(html).toContain('hidden=""')
    expect(html).not.toContain('来源资料内容')
  })
})
