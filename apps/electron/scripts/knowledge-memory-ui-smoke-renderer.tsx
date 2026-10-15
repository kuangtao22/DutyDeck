import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import { EditorView } from '@codemirror/view'
import type {
  AgentWorkspace,
  AgentSessionMeta,
  KnowledgeEntry,
  KnowledgeExecutionStartInput,
  KnowledgeReadResult,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
  ProjectKnowledgeApi,
  SkillFileNode,
  WorkspaceMemoryFileChange,
  WorkspaceMemorySummary,
} from '@proma/shared'
import { agentPendingPromptAtom, agentSessionDraftsAtom, agentSessionsAtom, agentWorkspacesAtom, currentAgentSessionIdAtom } from '../src/renderer/atoms/agent-atoms'
import { memoryFileNavigationAtom, workspaceMemoryChangesAtom } from '../src/renderer/atoms/memory-change-atoms'
import { TooltipProvider } from '../src/renderer/components/ui/tooltip'
import { Toaster } from '../src/renderer/components/ui/sonner'
import '../src/renderer/styles/globals.css'

const workspace: AgentWorkspace = {
  id: 'workspace-knowledge-memory-smoke',
  name: '知识与记忆 Smoke',
  slug: 'knowledge-memory-smoke',
  projectRootPath: '/fixtures/knowledge-memory-smoke',
  projectRootStatus: 'available',
  createdAt: 1,
  updatedAt: 2,
}
const sessionId = 'session-knowledge-memory-smoke'
/** 持久化整理会话区别于用户当前对话，覆盖重启后 ref 为空的恢复。 */
const executionSessionId = 'persisted-knowledge-session'
/** 宿主通知订阅仅在 fixture 内存中运行。 */
const knowledgeListeners = new Set<(event: { workspaceId: string; generation?: number }) => void>()
const profilePath = 'user-profile.md'
const initialProfile = '# 协作画像\n\n- 偏好：结论先行\n'

/** smoke 只记录内存写入及 CAS 事实，不接触真实工作区目录。 */
interface KnowledgeMemorySmokeState {
  memoryFiles: Record<string, string>
  agentsMd: string
  writeCalls: Array<{ relativePath: string; content: string; expectedContent?: string }>
  knowledgeCalls: string[]
  readCalls: string[]
  forceKnowledgeError: boolean
  /** 新建会话仅保存在内存，用于核对任务目的地与原会话隔离。 */
  createdSessions: AgentSessionMeta[]
  /** 宿主执行调用记录，用于证明没有同时发送普通 prompt。 */
  executionCalls: KnowledgeExecutionStartInput[]
}

const state: KnowledgeMemorySmokeState = {
  memoryFiles: {
    'MEMORY.md': '# 记忆索引\n\n- [协作画像](user-profile.md)\n',
    [profilePath]: initialProfile,
  },
  agentsMd: '# 项目约束\n\n- 使用 Bun\n',
  writeCalls: [],
  knowledgeCalls: [],
  readCalls: [],
  forceKnowledgeError: new URLSearchParams(location.search).has('knowledge-error'),
  createdSessions: [],
  executionCalls: [],
}

/** 可控读取延迟只用于覆盖快速切换的迟到响应，不进行真实 I/O。 */
const delayedReads = new Set<string>()
const pendingReadReleases = new Map<string, () => void>()
/** 指定正文读取失败，用于验证错误仅影响正文区域。 */
const failedKnowledgeReads = new Set<string>()
/** 读取不可用是正常回执，区别于 IPC 异常，恢复后仍应允许用户重试。 */
const unavailableKnowledgeReads = new Set<string>()
/** 暂停首次目录请求，验证用户从大纲打开正文后，目录返回不能清空选择。 */
let delayInitialSearch = new URLSearchParams(location.search).has('hold-search')
let releaseInitialSearch: (() => void) | undefined

/** 复用内存延迟控制面覆盖索引 IPC。 */
async function waitForIndexRecovery(key: string): Promise<void> {
  if (!delayedReads.has(key)) return
  await new Promise<void>((resolve) => { pendingReadReleases.set(key, resolve) })
  pendingReadReleases.delete(key)
}

const knowledgeEntry: KnowledgeEntry = {
  id: 'knowledge-product-principles',
  revision: 'knowledge-r1',
  title: '产品原则',
  category: '产品策划',
  kind: 'document',
  state: 'confirmed',
  freshness: 'current',
  summary: '从现有规划资料提炼出的产品原则。',
  source: { kind: 'managed', id: 'knowledge/product-principles.md', relativePath: '知识库/产品策划/产品原则.md', revision: 'source-r1' },
  document: {
    topicKey: 'product-principles',
    groupId: 'group-product',
    rootRelativePath: '知识库',
    relativePath: '产品策划/产品原则.md',
    contentRevision: 'content-r1',
  },
  admission: { contentType: 'rule', importance: 'high', purpose: '明确产品承诺', scope: '当前版本', claims: [], coverage: [{ topic: '付费权益', status: 'gap', reason: '月度与永久权益尚未核对' }], issues: ['会员权益口径冲突'], outcome: 'needs_evidence', ruleVersion: 1, contentHash: 'fixture-content', evidenceHash: 'fixture-evidence', status: 'needs_evidence' },
  evidence: [{ entryId: 'source-readme', revision: 'source-r1', quote: 'DutyDeck 是一个本地优先的桌面 Agent。' }],
  byteSize: 132,
  indexedBytes: 132,
  truncated: false,
  metadataOnly: false,
  updatedAt: 3,
}

const sourceEntry: KnowledgeEntry = {
  ...knowledgeEntry,
  id: 'source-readme',
  revision: 'source-r1',
  title: 'README.md',
  category: '来源',
  kind: 'document',
  state: 'indexed',
  summary: '项目入口说明。',
  source: { kind: 'project-file', id: 'README.md', relativePath: 'README.md', revision: 'source-r1' },
  document: undefined,
  admission: undefined,
}

/** 阅读回归提供长目录，验证滚动位置和其它文件夹折叠不受点击影响。 */
const knowledgeEntries = new URLSearchParams(location.search).get('case') === 'reading'
  ? [knowledgeEntry, ...Array.from({ length: 30 }, (_, index): KnowledgeEntry => ({
    ...knowledgeEntry,
    id: `knowledge-engineering-${index}`,
    title: `工程文档 ${index}`,
    document: { ...knowledgeEntry.document!, relativePath: `工程/文档${index}.md` },
  }))]
  : [knowledgeEntry]

/** 已确认且暂停的流程用于证明知识工作流状态不影响独立记忆。 */
const snapshot: KnowledgeSnapshot = {
  projectId: workspace.id,
  initialized: true,
  revision: 7,
  entries: [knowledgeEntry, sourceEntry],
  totalEntries: 2,
  knowledgeCount: 1,
  sourceCount: 1,
  workflow: {
    approved: {
      id: 'plan-smoke',
      revision: 2,
      title: '项目资料库',
      rootRelativePath: '知识库',
      createdAt: 2,
      confirmedAt: 3,
      groups: [{
        id: 'group-product',
        title: '产品策划',
        summary: '规划、规则与产品取舍。',
        sources: [{ entryId: sourceEntry.id, revision: sourceEntry.revision, title: sourceEntry.title, relativePath: 'README.md', coverage: 'read' }],
        gaps: [],
        outputs: ['产品原则'],
      }],
    },
    outline: {
      revision: 1,
      planRevision: 2,
      relativePath: '大纲.md',
      items: [{
        id: 'outline-product-principles',
        groupId: 'group-product',
        title: '产品原则',
        relativePath: '产品策划/产品原则.md',
        summary: '产品范围与决策原则。',
        sections: ['目标', '原则'],
        entryId: knowledgeEntry.id,
        status: 'ready',
      }],
    },
    execution: {
      id: 'execution-smoke', generation: 1, sessionId: executionSessionId, planRevision: 2, itemIds: [], status: 'blocked',
      dispatchId: 'fixture-dispatch', turns: 1, calls: 1, bytes: 100, activeMs: 100, readPages: [], progress: 1,
      turnStartProgress: 0, failures: { 'outline-product-principles': { code: 'needs_evidence', message: '会员权益需补充依据' } }, reason: 'budget_exhausted', userEvidence: [], updatedAt: 4,
    },
    paused: true,
  },
  scan: { status: 'completed', discovered: 1, indexed: 1, skipped: 0, changed: 0, message: 'fixture 来源扫描完成' },
  maintenance: { enabled: false, dailyJobLimit: 3, generation: 1 },
  pendingTurns: 0,
  updatedAt: 4,
}

const summary: WorkspaceMemorySummary = {
  agentsMd: { exists: true, path: '/fixtures/knowledge-memory-smoke/AGENTS.md', size: state.agentsMd.length, updatedAt: 2 },
  autoMemory: {
    directory: '/fixtures/knowledge-memory-smoke/memory',
    memoryMdExists: true,
    fileCount: 2,
    totalSize: Object.values(state.memoryFiles).reduce((total, content) => total + content.length, 0),
    updatedAt: 3,
  },
}

const memoryTree: SkillFileNode[] = [
  { relativePath: 'MEMORY.md', name: 'MEMORY.md', type: 'file', size: state.memoryFiles['MEMORY.md']!.length, modifiedAt: 3, isText: true },
  { relativePath: profilePath, name: profilePath, type: 'file', size: initialProfile.length, modifiedAt: 3, isText: true },
]

/** 返回知识或来源目录，保持生产组件的分页契约。 */
function searchKnowledge(scope: 'knowledge' | 'sources' | 'all' | undefined): KnowledgeSearchResult {
  const entries = scope === 'sources' ? [sourceEntry] : scope === 'all' ? [...knowledgeEntries, sourceEntry] : knowledgeEntries
  return {
    revision: snapshot.revision,
    items: entries.map((entry) => ({ entry, snippet: entry.summary, line: 1, score: 1 })),
    total: entries.length,
    indexStatus: 'ready',
  }
}

const knowledgeApi: ProjectKnowledgeApi = {
  getProjectKnowledgeSnapshot: async (workspaceId) => {
    state.knowledgeCalls.push(`snapshot:${workspaceId}`)
    if (state.forceKnowledgeError) throw new Error('fixture 知识库读取失败')
    return structuredClone(snapshot)
  },
  searchProjectKnowledge: async (input) => {
    state.knowledgeCalls.push(`search:${input.scope ?? 'all'}`)
    if (delayInitialSearch) {
      delayInitialSearch = false
      await new Promise<void>((resolve) => { releaseInitialSearch = resolve })
      releaseInitialSearch = undefined
    }
    return structuredClone(searchKnowledge(input.scope))
  },
  readProjectKnowledge: async (input): Promise<KnowledgeReadResult> => {
    state.knowledgeCalls.push(`read:${input.entryId}`)
    /** 请求开始时固定正文版本，使迟到的旧版本回执不会跟随目录变化。 */
    const entry = structuredClone(input.entryId === sourceEntry.id ? sourceEntry : knowledgeEntries.find((candidate) => candidate.id === input.entryId)!)
    /** 可按条目及版本暂停旧请求，同时允许同一条目的新版立即返回。 */
    const delayKey = delayedReads.has(`${input.entryId}:${input.expectedRevision}`) ? `${input.entryId}:${input.expectedRevision}` : input.entryId
    if (delayedReads.has(delayKey)) {
      await new Promise<void>((resolve) => { pendingReadReleases.set(delayKey, resolve) })
      pendingReadReleases.delete(delayKey)
    }
    if (failedKnowledgeReads.has(input.entryId) || failedKnowledgeReads.has(`${input.entryId}:${input.offset}`)) throw new Error('fixture 正文读取失败')
    if (unavailableKnowledgeReads.has(input.entryId)) return { entry: structuredClone(entry), content: '', status: 'unavailable', offset: 0, truncated: false }
    if (entry.id === 'knowledge-engineering-20') return {
      entry: structuredClone(entry), content: input.offset ? '第二页正文' : '第一页正文',
      status: 'readable', offset: input.offset ?? 0, truncated: !input.offset,
      nextOffset: input.offset ? undefined : 5,
    }
    return {
      entry: structuredClone(entry),
      content: entry.id === sourceEntry.id ? '# README\n\nDutyDeck 是一个本地优先的桌面 Agent。' : `# 产品原则\n\n1. 本地优先\n2. 用户确认后生成结构化资料\n\n正文版本：${entry.revision}\n`,
      status: 'readable',
      offset: 0,
      truncated: false,
    }
  },
  confirmProjectKnowledgePlan: async () => structuredClone(snapshot),
  pauseProjectKnowledgeWorkflow: async (input) => {
    snapshot.workflow!.paused = input.paused
    snapshot.revision += 1
    if (input.paused && snapshot.workflow!.execution) snapshot.workflow!.execution.status = 'paused'
    return structuredClone(snapshot)
  },
  onProjectKnowledgeChanged: (listener) => { knowledgeListeners.add(listener); return () => { knowledgeListeners.delete(listener) } },
  startProjectKnowledgeExecution: async (input) => {
    state.executionCalls.push(structuredClone(input))
    snapshot.revision += 1
    snapshot.workflow!.paused = false
    snapshot.workflow!.execution = { ...snapshot.workflow!.execution!, generation: (snapshot.workflow!.execution?.generation ?? 0) + 1, sessionId: input.sessionId, planRevision: input.planRevision, itemIds: input.itemIds ?? [], status: 'queued' }
    return structuredClone(snapshot)
  },
  scanProjectKnowledge: async () => {
    state.knowledgeCalls.push('scan')
    return structuredClone(snapshot)
  },
  cancelProjectKnowledgeScan: async () => structuredClone(snapshot),
  updateProjectKnowledgeMaintenance: async () => structuredClone(snapshot),
  retryProjectKnowledgeMaintenance: async () => structuredClone(snapshot),
  reviewProjectKnowledge: async () => structuredClone(snapshot),
  organizeProjectKnowledge: async () => structuredClone(snapshot),
  undoProjectKnowledgeOperation: async () => structuredClone(snapshot),
  excludeProjectKnowledgeSession: async () => structuredClone(snapshot),
  importProjectKnowledge: async () => ({ rootRelativePath: '.context/knowledge-imports', imported: 0, unchanged: 0, files: [], skipped: [] }),
  previewProjectKnowledgeIndex: async () => {
    await waitForIndexRecovery('index-preview')
    return { planRevision: 2, outlineRevision: 1, currentContent: '# 人工索引原文', generatedContent: '# 重建索引正文', currentRevision: 'index-r1' }
  },
  rebuildProjectKnowledgeIndex: async (input) => {
    state.knowledgeCalls.push(`rebuild:${input.workspaceId}:${input.expectedContentRevision}`)
    await waitForIndexRecovery('index-rebuild')
    return { backupRelativePath: '.context/backup.json' }
  },
  previewProjectKnowledgeMemory: async () => ({ projectId: workspace.id, inspected: 2, truncated: false, proposals: [] }),
}

/** 创建失败场景仍走首次规划入口，不把已批准生成错误地退回 prompt。 */
if (new URLSearchParams(location.search).has('session-error') || new URLSearchParams(location.search).get('case') === 'planning') {
  snapshot.workflow!.proposal = structuredClone(snapshot.workflow!.approved!)
  snapshot.workflow!.approved = undefined
  snapshot.workflow!.execution = undefined
}

/** 使用打开时正文作为 CAS 基线；不匹配时模拟真实主进程拒绝覆盖。 */
async function writeMemoryFile(relativePath: string, content: string, expectedContent?: string): Promise<void> {
  const current = state.memoryFiles[relativePath]
  state.writeCalls.push({ relativePath, content, expectedContent })
  if (expectedContent !== undefined && current !== expectedContent) {
    throw new Error('文件已被外部更新，请刷新后重试')
  }
  state.memoryFiles[relativePath] = content
}

const store = createStore()
store.set(agentWorkspacesAtom, [workspace])
store.set(currentAgentSessionIdAtom, sessionId)
/** 当前普通会话可被旧逻辑复用，因此能够真实捕获“更新知识库挤入当前对话”的回归。 */
store.set(agentSessionsAtom, [{ id: sessionId, title: '正在进行的工作', workspaceId: workspace.id, channelId: 'fixture-channel', modelId: 'fixture-model', toolMode: 'standard', createdAt: 1, updatedAt: 1 }, { id: executionSessionId, title: '项目知识整理', workspaceId: workspace.id, channelId: 'fixture-channel', modelId: 'fixture-model', toolMode: 'standard', createdAt: 1, updatedAt: 1 }])
store.set(agentSessionDraftsAtom, new Map([[sessionId, '保留当前对话草稿']]))

const memoryChange: WorkspaceMemoryFileChange = {
  relativePath: profilePath,
  kind: 'modified',
  changedAt: 8,
  diffAvailable: true,
  preview: '新增一条协作偏好',
  diff: { context: ['# 协作画像'], removed: [], added: ['- 偏好：提供验证证据'], truncated: false },
}
store.set(workspaceMemoryChangesAtom, new Map([[workspace.slug, [memoryChange]]]))

/** preload 替身只提供当前组件依赖，文件内容始终留在 renderer 内存。 */
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    ...knowledgeApi,
    getWorkspaceMemorySummary: async () => structuredClone(summary),
    listWorkspaceAutoMemoryFiles: async () => structuredClone(memoryTree),
    readWorkspaceAgentsMd: async () => ({ relativePath: 'AGENTS.md', content: state.agentsMd, isText: true, size: state.agentsMd.length }),
    writeWorkspaceAgentsMd: async (_workspaceSlug: string, content: string, expectedContent?: string) => {
      if (expectedContent !== undefined && state.agentsMd !== expectedContent) throw new Error('文件已被外部更新，请刷新后重试')
      state.agentsMd = content
      state.writeCalls.push({ relativePath: 'AGENTS.md', content, expectedContent })
    },
    readWorkspaceAutoMemoryFile: async (_workspaceSlug: string, relativePath: string) => {
      state.readCalls.push(relativePath)
      if (delayedReads.has(relativePath)) {
        await new Promise<void>((resolve) => { pendingReadReleases.set(relativePath, resolve) })
        pendingReadReleases.delete(relativePath)
      }
      const content = state.memoryFiles[relativePath]
      if (content === undefined) throw new Error(`fixture 记忆文件不存在：${relativePath}`)
      return { relativePath, content, isText: true, size: content.length }
    },
    writeWorkspaceAutoMemoryFile: async (_workspaceSlug: string, relativePath: string, content: string, expectedContent?: string) => writeMemoryFile(relativePath, content, expectedContent),
    showItemInFolder: async () => undefined,
    approveWorkspaceProjectKnowledgeMaintenance: async () => undefined,
    /** 模拟既有创建接口，返回唯一身份；失败场景不得回退到当前对话。 */
    createAgentSession: async (title?: string, channelId?: string, workspaceId?: string, modelId?: string): Promise<AgentSessionMeta> => {
      if (new URLSearchParams(location.search).has('session-error')) throw new Error('fixture 新建会话失败')
      const created: AgentSessionMeta = { id: `created-knowledge-${state.createdSessions.length + 1}`, title: title ?? '新会话', workspaceId, channelId, modelId, createdAt: 1, updatedAt: 1 }
      state.createdSessions.push(created)
      return created
    },
    updateSettings: async () => undefined,
  },
})

/** 测试控制面只操作内存与 atom，用于制造外部更新和变更通知。 */
Object.defineProperty(window, '__knowledgeMemorySmoke', {
  configurable: true,
  value: {
    state,
    profilePath,
    initialProfile,
    /** 读取真实 Jotai 导航与投递状态，模拟 Agent 消费任务但不调用模型。 */
    workflowState: () => ({ pendingPrompt: store.get(agentPendingPromptAtom), currentSessionId: store.get(currentAgentSessionIdAtom), originalDraft: store.get(agentSessionDraftsAtom).get(sessionId) }),
    /** 模拟宿主运行结束的事件，组件必须自动刷新真实状态。 */
    blockExecution: (): void => {
      snapshot.workflow!.execution!.status = 'blocked'
      snapshot.workflow!.execution!.reason = 'budget_exhausted'
      snapshot.revision += 1
      for (const listener of knowledgeListeners) listener({ workspaceId: workspace.id, generation: snapshot.workflow!.execution!.generation })
    },
    /** 同组件切换项目身份，验证在途 IPC 不污染新项目。 */
    switchWorkspace: (): void => { store.set(agentWorkspacesAtom, [{ ...workspace, id: 'other-workspace' }]) },
    removeCurrentSession: (): void => { store.set(agentSessionsAtom, store.get(agentSessionsAtom).filter((item) => item.id !== sessionId)) },
    consumePrompt: (): void => { store.set(agentPendingPromptAtom, null) },
    hasPendingSearch: (): boolean => Boolean(releaseInitialSearch),
    releaseSearch: (): void => { releaseInitialSearch?.() },
    /** 通过 CodeMirror 公共接口读取源文档，不把渲染后的 Markdown DOM 当源码。 */
    editorText: (): string | undefined => {
      const editor = [...document.querySelectorAll<HTMLElement>('.cm-content')].find((element) => element.getBoundingClientRect().width > 0)
      return editor ? EditorView.findFromDOM(editor)?.state.doc.toString() : undefined
    },
    /** 确认原生全选事件已提交，避免 insertText 抢在键盘事件前执行。 */
    editorHasFullSelection: (): boolean => {
      const editor = document.activeElement
      const view = editor instanceof HTMLElement ? EditorView.findFromDOM(editor) : null
      return Boolean(view && view.state.selection.main.from === 0 && view.state.selection.main.to === view.state.doc.length)
    },
    setExternalProfile: (content: string): void => { state.memoryFiles[profilePath] = content },
    delayRead: (relativePath: string): void => { delayedReads.add(relativePath) },
    /** 按条目身份切换失败，恢复后允许点击目录重试。 */
    failKnowledgeRead: (entryId: string, failed: boolean): void => {
      if (failed) failedKnowledgeReads.add(entryId)
      else failedKnowledgeReads.delete(entryId)
    },
    /** 模拟已登记来源暂时不可用及恢复。 */
    unavailableKnowledgeRead: (entryId: string, unavailable: boolean): void => {
      if (unavailable) unavailableKnowledgeReads.add(entryId)
      else unavailableKnowledgeReads.delete(entryId)
    },
    /** 修改指定条目版本并发出宿主通知，模拟读取期间目录被更新；无返回值。 */
    updateKnowledgeRevision: (entryId: string, revision: string): void => {
      /** 只更新测试内存中确实存在的条目，保持文件路径与身份不变。 */
      const entry = knowledgeEntries.find((candidate) => candidate.id === entryId)
      if (!entry) throw new Error(`fixture 缺少知识条目：${entryId}`)
      entry.revision = revision
      snapshot.revision += 1
      for (const listener of knowledgeListeners) listener({ workspaceId: workspace.id })
    },
    hasPendingRead: (relativePath: string): boolean => pendingReadReleases.has(relativePath),
    releaseRead: (relativePath: string): void => {
      delayedReads.delete(relativePath)
      pendingReadReleases.get(relativePath)?.()
    },
    requestMemoryChange: (): void => {
      const request = { workspaceSlug: workspace.slug, sessionId, relativePath: profilePath, mode: 'change' as const }
      store.set(memoryFileNavigationAtom, request)
    },
  },
})

const { ProjectKnowledgeTab } = await import('../src/renderer/components/agent-skills/ProjectKnowledgeTab')
document.documentElement.classList.toggle('dark', new URLSearchParams(location.search).get('theme') === 'dark')
document.documentElement.style.colorScheme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'

createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <TooltipProvider>
      <main className="h-screen min-h-0 overflow-hidden bg-background text-foreground" data-knowledge-memory-smoke>
        <ProjectKnowledgeTab workspaceSlug={workspace.slug} sessionId={sessionId} embedded />
      </main>
      <Toaster />
    </TooltipProvider>
  </Provider>,
)
document.body.dataset.smokeReady = 'true'
