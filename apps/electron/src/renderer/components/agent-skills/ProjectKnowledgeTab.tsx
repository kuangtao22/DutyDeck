import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  AlertTriangle,
  Ban,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  FileSearch,
  Loader2,
  RefreshCw,
  Search,
  Square,
  X,
} from 'lucide-react'
import type {
  AgentSessionMeta,
  KnowledgeCategory,
  KnowledgeEntry,
  KnowledgeReadResult,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
} from '@proma/shared'
import { isOrdinaryTopLevelAgentSession } from '@proma/shared'
import {
  agentPendingPromptAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
  currentAgentSessionIdAtom,
  type AgentPendingPrompt,
} from '@/atoms/agent-atoms'
import { matchesMemoryNavigation, memoryFileNavigationAtom } from '@/atoms/memory-change-atoms'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LiveMarkdownEditor } from '@/components/markdown/LiveMarkdownEditor'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useOpenSession } from '@/hooks/useOpenSession'
import { cn } from '@/lib/utils'
import { WorkspaceMemoryTab } from './WorkspaceMemoryTab'
import { KnowledgeWorkflowPanel } from './KnowledgeWorkflowPanel'
import type { KnowledgePlanSelection } from './KnowledgeWorkflowPanel'
import { startKnowledgePolling, waitForKnowledgeScan } from './project-knowledge-poll'

type ProjectKnowledgeView = 'knowledge' | 'sources' | 'memory'
type ProjectKnowledgeScope = 'knowledge' | 'sources'
type KnowledgeCategoryFilter = KnowledgeCategory | 'all'

const KNOWLEDGE_PAGE_SIZE = 12
const SCAN_POLL_INTERVAL_MS = 1_200

const CATEGORY_LABELS: Partial<Record<KnowledgeCategory, string>> = {
  overview: '项目概览',
  planning: '规划',
  business: '业务',
  engineering: '工程',
  design: '设计',
  guides: '指南',
  decisions: '决策',
}

const KIND_LABELS: Record<KnowledgeEntry['kind'], string> = {
  document: '文档',
  asset: '资产',
  fact: '事实',
  decision: '决策',
  experience: '经验',
  preference: '偏好',
  rule: '规则',
}

const STATE_LABELS: Record<KnowledgeEntry['state'], string> = {
  indexed: '已索引',
  draft: '草稿',
  confirmed: '已确认',
  superseded: '已替代',
  archived: '已归档',
}

const FRESHNESS_LABELS: Record<KnowledgeEntry['freshness'], string> = {
  current: '来源最新',
  changed: '来源已变化',
  unavailable: '来源不可用',
  unverified: '尚未核验',
}

const SOURCE_LABELS: Record<KnowledgeEntry['source']['kind'], string> = {
  'project-file': '项目文件',
  'memory-file': '记忆文件',
  conversation: '项目会话',
  managed: '受管资料',
  canvas: 'Canvas',
  api: '接口工作台',
}

/** 将字节数格式化为紧凑的人类可读文本。 */
function formatKnowledgeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 将未知异常转换为可重试的用户提示。 */
function knowledgeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

/** 合并目录分页，按稳定条目 ID 去重以兼容扫描期间清单变化。 */
function mergeKnowledgeSearchResults(
  previous: KnowledgeSearchResult,
  next: KnowledgeSearchResult,
): KnowledgeSearchResult {
  const seenEntryIds = new Set(previous.items.map((item) => item.entry.id))
  return {
    ...next,
    items: [...previous.items, ...next.items.filter((item) => !seenEntryIds.has(item.entry.id))],
  }
}

/**
 * 为清单调整或继续生成选择可续接的知识整理会话；更新入口始终另建会话。
 * @param sessions Renderer 已加载的 Agent 会话索引。
 * @param currentSessionId 当前用户正在使用的 Agent 会话 ID。
 * @param workspaceId 当前知识库所属项目 ID。
 * @returns 合法的同项目标准会话 ID；不符合条件时返回 null，由调用方新建会话。
 */
export function selectKnowledgeMaintenanceSession(
  sessions: AgentSessionMeta[],
  currentSessionId: string | null | undefined,
  workspaceId: string,
): string | null {
  const currentSession = sessions.find((session) => session.id === currentSessionId)
  if (!isOrdinaryTopLevelAgentSession(currentSession)) return null
  if (currentSession.archived || currentSession.workspaceId !== workspaceId) return null
  if (currentSession.explorationParentSessionId) return null
  if ((currentSession.toolMode ?? 'standard') !== 'standard') return null
  return currentSession.id
}

/**
 * 构造交给项目 Agent 的知识维护任务。
 * @param sessionId 承接任务的普通 Agent 会话 ID。
 * @returns 自动发送的待处理提示词，固定显式引用 knowledge-maintenance Skill。
 */
export function buildKnowledgeMaintenancePendingPrompt(
  sessionId: string,
  scanMessage?: string,
): AgentPendingPrompt {
  const scanNotice = scanMessage ? `\n\n本轮来源扫描提示：${scanMessage}` : ''
  return {
    sessionId,
    autoSend: true,
    mentionedSkills: ['knowledge-maintenance'],
    message: `请使用 knowledge-maintenance Skill 为当前项目规划知识库。

先读取刚完成的来源索引，再按需读取相关原文，依据项目实际内容提出自由分组；不要套用固定业务分类或固定目录数量。请提交分组 proposal，说明每组的摘要、已读取来源、信息缺口、预计产出和拟使用的知识库根目录。提交 proposal 后停下来等待用户确认，不要保存大纲，也不要提前写知识正文。${scanNotice}`,
  }
}

/**
 * 构造用户确认后的知识文件生成任务。
 * @param sessionId 承接首次规划任务的同项目普通 Agent 会话 ID。
 * @param planRevision 用户已经确认的计划版本。
 * @returns 自动发送到原会话的生成提示词。
 */
export function buildKnowledgeGenerationPendingPrompt(
  sessionId: string,
  planRevision: number,
): AgentPendingPrompt {
  return {
    sessionId,
    autoSend: true,
    mentionedSkills: ['knowledge-maintenance'],
    message: `请继续使用 knowledge-maintenance Skill 完成当前项目知识库。用户已确认 approved 计划版本 ${planRevision}。

先读取权威 workflow.approved；如果尚无 outline，按已确认分组保存 outline。随后按 outline 逐项读取必要来源并写入真实 Markdown 文件，保留可追溯证据和信息缺口。已确认范围内无需逐篇等待审批；遇到暂停、版本冲突或人工修改时立即停止覆盖并报告。完成后说明已生成、部分完成、缺少依据和仍待生成的文件。`,
  }
}

/**
 * 构造用户对当前可见清单的自然语言调整任务。
 * @param sessionId 承接原规划任务的同项目普通 Agent 会话 ID。
 * @param planId 用户当前看到的计划身份。
 * @param planRevision 用户当前看到的计划版本。
 * @param instruction 用户要求修改的分组、顺序或目录说明。
 * @returns 只要求重新提案、不产生确认副作用的待处理提示词。
 */
export function buildKnowledgePlanAdjustmentPendingPrompt(
  sessionId: string,
  planId: string,
  planRevision: number,
  instruction: string,
): AgentPendingPrompt {
  return {
    sessionId,
    autoSend: true,
    mentionedSkills: ['knowledge-maintenance'],
    message: `请继续使用 knowledge-maintenance Skill 调整当前项目知识库清单。用户正在查看计划 ${planId} 版本 ${planRevision}，调整要求如下：\n\n${instruction}\n\n请重新读取当前 workflow.proposal，在同一项目内修改分组、合并关系、顺序或根目录，并重新提交 proposal。不要确认计划，不要保存 outline，也不要写知识正文；提交新 proposal 后停下来等待用户确认。`,
  }
}

/** 顶层统一容器属性，便于独立验证原记忆入口仍可到达。 */
export interface ProjectKnowledgeTabShellProps {
  activeView: ProjectKnowledgeView
  onActiveViewChange: (view: ProjectKnowledgeView) => void
  knowledge: React.ReactNode
  sources: React.ReactNode
  memory: React.ReactNode
}

/** 项目知识库统一容器，资料目录与原记忆编辑器共享同一入口。 */
export function ProjectKnowledgeTabShell({
  activeView,
  onActiveViewChange,
  knowledge,
  sources,
  memory,
}: ProjectKnowledgeTabShellProps): React.ReactElement {
  /** 首次访问记忆后保持挂载，切换时保留编辑草稿、冲突提示及选中文件。 */
  const [memoryVisited, setMemoryVisited] = React.useState(activeView === 'memory')
  /** 回到知识库时恢复上次的正文或来源视图。 */
  const lastKnowledgeView = React.useRef<ProjectKnowledgeScope>('knowledge')
  if (activeView !== 'memory') lastKnowledgeView.current = activeView
  React.useEffect(() => {
    if (activeView === 'memory') setMemoryVisited(true)
  }, [activeView])

  return (
    <Tabs
      value={activeView === 'memory' ? 'memory' : 'knowledge'}
      onValueChange={(value) => onActiveViewChange(value === 'memory' ? 'memory' : lastKnowledgeView.current)}
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label="项目知识与记忆"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <TabsList aria-label="知识库与记忆">
          <TabsTrigger value="knowledge" className="gap-1.5"><BookOpen className="size-4" aria-hidden="true" />知识库</TabsTrigger>
          <TabsTrigger value="memory" className="gap-1.5"><Brain className="size-4" aria-hidden="true" />记忆</TabsTrigger>
        </TabsList>
        {activeView !== 'memory' && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onActiveViewChange(activeView === 'sources' ? 'knowledge' : 'sources')}>
            <FileSearch aria-hidden="true" />{activeView === 'sources' ? '返回知识库' : '来源资料'}
          </Button>
        )}
      </div>
      <TabsContent value="knowledge" forceMount hidden={activeView === 'memory'} className="m-0 min-h-0 flex-1 data-[state=inactive]:hidden">
        {lastKnowledgeView.current === 'sources' ? sources : knowledge}
      </TabsContent>
      <TabsContent value="memory" forceMount hidden={activeView !== 'memory'} className="m-0 min-h-0 flex-1 data-[state=inactive]:hidden">
        {(memoryVisited || activeView === 'memory') && memory}
      </TabsContent>
    </Tabs>
  )
}

/** 资料视图的受控属性，异步生命周期由外层控制器负责。 */
export interface ProjectKnowledgeResourcesViewProps {
  scope: ProjectKnowledgeScope
  snapshot: KnowledgeSnapshot | null
  result: KnowledgeSearchResult | null
  selectedRead: KnowledgeReadResult | null
  loading: boolean
  searching: boolean
  reading: boolean
  actionPending: boolean
  error: string | null
  query: string
  category: KnowledgeCategoryFilter
  /** 仅承载待确认或继续的知识库计划，不包含低频资料整理工具。 */
  workflow?: React.ReactNode
  pendingKnowledgeAction?: string | null
  knowledgeActionError?: string | null
  onQueryChange: (query: string) => void
  onCategoryChange: (category: KnowledgeCategoryFilter) => void
  onScan: () => void
  onCancelScan: () => void
  onRetry: () => void
  onSelectEntry: (entry: KnowledgeEntry) => void
  onLoadMore: () => void
  onLoadMoreContent: () => void
  onClosePreview: () => void
  onSelectEvidence?: (entryId: string, revision: string) => void
  onReviewEntry?: (entry: KnowledgeEntry, action: 'confirm' | 'reject') => void
}

/** 单条目录卡按当前作用域区分提炼知识状态与来源索引状态。 */
function KnowledgeEntryButton({
  entry,
  scope,
  selected,
  onSelect,
}: {
  entry: KnowledgeEntry
  scope: ProjectKnowledgeScope
  selected: boolean
  onSelect: (entry: KnowledgeEntry) => void
}): React.ReactElement {
  const sourceLocation = entry.source.relativePath ?? entry.source.id
  return (
    <button
      type="button"
      className={cn(
        'w-full rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-primary bg-accent/70' : 'border-border bg-card hover:bg-accent/40',
      )}
      aria-pressed={selected}
      onClick={() => onSelect(entry)}
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{entry.title}</span>
          <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">{entry.summary || '暂无摘要'}</span>
        </span>
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </span>
      <span className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{CATEGORY_LABELS[entry.category] ?? entry.category}</Badge>
        <Badge variant="outline">{KIND_LABELS[entry.kind]}</Badge>
        {scope === 'knowledge' && <Badge variant="outline">{STATE_LABELS[entry.state]}</Badge>}
        {scope === 'sources' && <Badge variant="outline">{entry.metadataOnly ? '仅元数据' : '已索引'}</Badge>}
        <span className={cn('text-[11px]', entry.freshness === 'current' ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400')}>
          {FRESHNESS_LABELS[entry.freshness]}
        </span>
      </span>
      <span className="mt-2 block truncate text-[11px] text-muted-foreground">
        {SOURCE_LABELS[entry.source.kind]} · {sourceLocation}
      </span>
    </button>
  )
}

/** 有界正文预览，不可读取状态与下一页入口均以服务端回执为准。 */
function KnowledgeContentPreview({
  readResult,
  scope,
  reading,
  pendingAction,
  actionError,
  onLoadMoreContent,
  onClose,
  onSelectEvidence,
  onReview,
}: {
  readResult: KnowledgeReadResult
  scope: ProjectKnowledgeScope
  reading: boolean
  pendingAction?: string | null
  actionError?: string | null
  onLoadMoreContent: () => void
  onClose: () => void
  onSelectEvidence?: (entryId: string, revision: string) => void
  onReview?: (entry: KnowledgeEntry, action: 'confirm' | 'reject') => void
}): React.ReactElement {
  const { entry } = readResult
  const sourceLocation = entry.source.relativePath ?? entry.source.id
  const isDistilledKnowledge = scope === 'knowledge' && (entry.source.kind === 'managed' || entry.source.kind === 'conversation')
  /** 同一来源版本可以保留多段引文；仅折叠三字段完全相同的重复项。 */
  const uniqueEvidence = entry.evidence
    ? [...new Map(entry.evidence.map((evidence) => (
        [`${evidence.entryId}:${evidence.revision}:${evidence.quote}`, evidence]
      ))).values()]
    : []
  const statusMessage = readResult.status === 'metadata-only'
    ? '该来源只登记了元数据，尚无可读取的正文。'
    : readResult.status === 'unavailable'
      ? '当前无法读取来源正文，请检查来源是否仍然可用。'
      : readResult.status === 'changed'
        ? '来源已发生变化，请更新知识库后重新核验。'
        : null

  return (
    <article className="flex min-h-0 flex-col border-l border-border bg-background" aria-label="资料正文预览">
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{entry.title}</h3>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {SOURCE_LABELS[entry.source.kind]} · {sourceLocation} · {!isDistilledKnowledge
              ? entry.metadataOnly ? '仅元数据' : `${formatKnowledgeBytes(entry.indexedBytes)} 已读取文本`
              : '提炼知识'}
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label="关闭正文预览" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      {isDistilledKnowledge && onReview && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {entry.state === 'draft' && onReview && (
            <Button type="button" size="sm" disabled={Boolean(pendingAction)} onClick={() => onReview(entry, 'confirm')}>
              {pendingAction === `confirm:${entry.id}` ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
              确认资料
            </Button>
          )}
          {onReview && (
            <Button type="button" variant="outline" size="sm" disabled={Boolean(pendingAction)} onClick={() => onReview(entry, 'reject')}>
              {pendingAction === `reject:${entry.id}` ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Ban aria-hidden="true" />}
              排除条目
            </Button>
          )}
          {actionError && <p className="basis-full text-xs text-destructive" role="alert">{actionError}</p>}
        </div>
      )}
      {isDistilledKnowledge && uniqueEvidence.length > 0 && (
        <div className="shrink-0 space-y-1.5 border-b border-border px-3 py-2" aria-label="提炼依据">
          <p className="text-[11px] font-medium text-foreground">提炼依据</p>
          {entry.truncated && (
            <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground" role="status">
              部分依据仅分析了前段，可查看来源全文。
            </p>
          )}
          {uniqueEvidence.map((evidence) => (
            <button
              key={`${evidence.entryId}:${evidence.revision}:${evidence.quote}`}
              type="button"
              className="block w-full rounded-md border border-border bg-muted/30 px-2.5 py-2 text-left text-[11px] leading-4 text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelectEvidence?.(evidence.entryId, evidence.revision)}
            >
              “{evidence.quote}”
            </button>
          ))}
        </div>
      )}
      {statusMessage && (
        <div className="m-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground" role="status">
          {statusMessage}
        </div>
      )}
      {readResult.content ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <LiveMarkdownEditor
            key={`${entry.id}:${entry.revision}`}
            value={readResult.content}
            readOnly
            onChange={() => undefined}
            className="h-full"
          />
        </div>
      ) : !statusMessage ? (
        <p className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
          该资料没有可展示的正文。
        </p>
      ) : <div className="min-h-0 flex-1" />}
      {readResult.nextOffset !== undefined && (
        <div className="shrink-0 border-t border-border p-2">
          <Button type="button" variant="outline" size="sm" className="w-full" disabled={reading} onClick={onLoadMoreContent}>
            {reading && <Loader2 className="animate-spin" aria-hidden="true" />}
            加载下一页正文
          </Button>
        </div>
      )}
    </article>
  )
}

/** 项目知识与来源的纯展示层，支持全屏和右侧窄容器。 */
export function ProjectKnowledgeResourcesView({
  scope,
  snapshot,
  result,
  selectedRead,
  loading,
  searching,
  reading,
  actionPending,
  error,
  query,
  workflow,
  pendingKnowledgeAction,
  knowledgeActionError,
  onQueryChange,
  onScan,
  onCancelScan,
  onRetry,
  onSelectEntry,
  onLoadMore,
  onLoadMoreContent,
  onClosePreview,
  onSelectEvidence,
  onReviewEntry,
}: ProjectKnowledgeResourcesViewProps): React.ReactElement {
  const scanRunning = snapshot?.scan.status === 'running'
  const entries = result?.items ?? []
  const selectedEntryId = selectedRead?.entry.id ?? null
  const showInitialEmpty = snapshot?.initialized === false
  /** 快照先于防抖搜索更新时继续展示旧目录，并明确其正在刷新。 */
  const directoryRefreshing = snapshot?.initialized === true && result?.revision !== snapshot.revision
  const showDirectoryEmpty = snapshot?.initialized === true && !searching && !directoryRefreshing && entries.length === 0
  const hasFilter = Boolean(query.trim())
  const isKnowledgeView = scope === 'knowledge'
  const hasKnownKnowledge = (snapshot?.knowledgeCount ?? 0) > 0
  const knowledgeEmptyTitle = hasKnownKnowledge ? '已有知识待核验' : '尚未提炼知识'
  const knowledgeEmptyDescription = hasKnownKnowledge
    ? '当前目录没有可展示的知识；更新知识库后可重新核验来源。'
    : '点击“更新知识库”后，会新建当前项目的 Agent 对话，调用知识维护 Skill 按需读取来源并提炼知识。'

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ containerType: 'inline-size', containerName: 'knowledge' }}>
      <style>{`
        @container knowledge (min-width: 760px) {
          .project-knowledge-body { grid-template-columns: minmax(18rem, 0.9fr) minmax(20rem, 1.1fr); }
          .project-knowledge-empty-preview { display: flex; }
        }
        @container knowledge (max-width: 759px) {
          .project-knowledge-directory[data-preview-open="true"] { display: none; }
        }
      `}</style>
      <div className="shrink-0 space-y-2 border-b border-border px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-44 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={isKnowledgeView ? '搜索提炼知识' : '搜索来源资料'}
              aria-label={isKnowledgeView ? '搜索提炼知识' : '搜索来源资料'}
              className="pl-8"
            />
          </div>
          {scanRunning ? (
            <Button type="button" variant="outline" size="sm" disabled={actionPending} onClick={onCancelScan}>
              {actionPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Square aria-hidden="true" />}
              取消扫描
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={actionPending || loading} onClick={onScan}>
              {actionPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              {snapshot?.initialized
                ? isKnowledgeView ? '更新知识库' : '更新来源'
                : isKnowledgeView ? '建立知识库' : '扫描来源'}
            </Button>
          )}
        </div>
        {snapshot && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-live="polite">
            {isKnowledgeView ? (
              <span>知识 {snapshot.knowledgeCount ?? result?.total ?? 0} 条</span>
            ) : (
              <>
                <span>来源文件 {snapshot.sourceCount ?? result?.total ?? snapshot.totalEntries} 个</span>
                <span>发现 {snapshot.scan.discovered}</span>
                <span>已读取文本 {snapshot.scan.indexed}</span>
                <span>跳过 {snapshot.scan.skipped}</span>
              </>
            )}
            {snapshot.scan.changed > 0 && <span>来源更新 {snapshot.scan.changed} 个</span>}
            {snapshot.scan.message && <span className="basis-full text-foreground/70">{snapshot.scan.message}</span>}
          </div>
        )}
      </div>
      {workflow}

      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          正在读取{isKnowledgeView ? '知识' : '来源资料'}
        </div>
      ) : error ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center" role="alert">
          <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
          <p className="max-w-md text-sm text-destructive">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>重试</Button>
        </div>
      ) : showInitialEmpty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <FileSearch className="size-8 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-sm font-medium text-foreground">尚未建立项目知识库</h3>
          <p className="max-w-md text-xs leading-5 text-muted-foreground">
            扫描只登记项目文档、资产与记忆来源；当前项目 Agent 会通过知识维护 Skill 按需读取并提炼知识。
          </p>
        </div>
      ) : (
        <div className="project-knowledge-body grid min-h-0 flex-1 grid-cols-1">
          <div className="project-knowledge-directory min-h-0 overflow-auto p-3" data-preview-open={Boolean(selectedRead)} aria-label={isKnowledgeView ? '知识目录' : '来源目录'}>
            {reading && !selectedRead ? (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                正在读取正文
              </div>
            ) : null}
            {directoryRefreshing && entries.length > 0 && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                正在更新{isKnowledgeView ? '知识' : '来源资料'}
              </div>
            )}
            {(searching || directoryRefreshing) && entries.length === 0 ? (
              <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {directoryRefreshing ? `正在更新${isKnowledgeView ? '知识' : '来源资料'}` : `正在搜索${isKnowledgeView ? '知识' : '来源资料'}`}
              </div>
            ) : showDirectoryEmpty ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                <FileSearch className="size-7 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm text-foreground">{hasFilter
                  ? `没有匹配的${isKnowledgeView ? '知识' : '来源资料'}`
                  : isKnowledgeView ? knowledgeEmptyTitle : '暂无来源资料'}</p>
                <p className="max-w-sm text-xs leading-5 text-muted-foreground">{hasFilter
                  ? '尝试调整搜索词。'
                  : isKnowledgeView
                    ? knowledgeEmptyDescription
                    : '更新来源以发现新增或发生变化的项目资料。'}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {entries.map(({ entry }) => (
                  <KnowledgeEntryButton
                    key={`${entry.id}:${entry.revision}`}
                    entry={entry}
                    scope={scope}
                    selected={entry.id === selectedEntryId}
                    onSelect={onSelectEntry}
                  />
                ))}
                {result?.nextOffset !== undefined && (
                  <Button type="button" variant="outline" size="sm" className="w-full" disabled={searching} onClick={onLoadMore}>
                    {searching && <Loader2 className="animate-spin" aria-hidden="true" />}
                    加载更多{isKnowledgeView ? '知识' : '来源'}
                  </Button>
                )}
              </div>
            )}
          </div>
          {selectedRead ? (
            <KnowledgeContentPreview
              readResult={selectedRead}
              scope={scope}
              reading={reading}
              pendingAction={pendingKnowledgeAction}
              actionError={knowledgeActionError}
              onLoadMoreContent={onLoadMoreContent}
              onClose={onClosePreview}
              onSelectEvidence={onSelectEvidence}
              onReview={isKnowledgeView ? onReviewEntry : undefined}
            />
          ) : (
            <div className="project-knowledge-empty-preview hidden min-h-0 items-center justify-center border-l border-border px-6 text-center text-xs text-muted-foreground">
              从左侧选择{isKnowledgeView ? '知识' : '来源'}，查看正文与追溯信息。
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 项目知识库入口属性，与原记忆组件保持一致的工作区和会话语义。 */
export interface ProjectKnowledgeTabProps {
  workspaceSlug: string
  sessionId?: string
  embedded?: boolean
  onRequestClose?: () => void
  search?: string
}

/** 连接知识库 IPC、处理请求隔离并复用原记忆编辑器。 */
export function ProjectKnowledgeTab({
  workspaceSlug,
  sessionId,
  embedded = false,
  onRequestClose,
  search,
}: ProjectKnowledgeTabProps): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentAgentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom)
  const store = useStore()
  const { createAgent } = useCreateSession()
  const openSession = useOpenSession()
  const workspaceId = workspaces.find((workspace) => workspace.slug === workspaceSlug)?.id ?? null
  const [activeView, setActiveView] = React.useState<ProjectKnowledgeView>('knowledge')
  /** 资源作用域独立于顶部记忆页，避免切换时重新搜索或清空正文。 */
  const [resourceView, setResourceView] = React.useState<ProjectKnowledgeScope>('knowledge')
  /** 记忆通知沿用原导航请求，负责唤起顶部记忆页。 */
  const memoryNavigationRequest = useAtomValue(memoryFileNavigationAtom)
  const [snapshot, setSnapshot] = React.useState<KnowledgeSnapshot | null>(null)
  const [result, setResult] = React.useState<KnowledgeSearchResult | null>(null)
  const [selectedRead, setSelectedRead] = React.useState<KnowledgeReadResult | null>(null)
  const [query, setQuery] = React.useState(search ?? '')
  const [category, setCategory] = React.useState<KnowledgeCategoryFilter>('all')
  const [loading, setLoading] = React.useState(true)
  const [searching, setSearching] = React.useState(false)
  const [reading, setReading] = React.useState(false)
  const [actionPending, setActionPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [knowledgeActionPending, setKnowledgeActionPending] = React.useState<string | null>(null)
  const [knowledgeActionError, setKnowledgeActionError] = React.useState<string | null>(null)
  const snapshotGenerationRef = React.useRef(0)
  const searchGenerationRef = React.useRef(0)
  const readGenerationRef = React.useRef(0)
  const knowledgeActionGenerationRef = React.useRef(0)
  /** 每次更新新建整理会话；清单调整与确认后生成继续沿用本轮会话。 */
  const knowledgeWorkflowSessionIdRef = React.useRef<string | null>(null)

  /** 统一刷新权威快照；代际不一致时丢弃迟到响应。 */
  const loadSnapshot = React.useCallback(async (): Promise<void> => {
    if (!workspaceId) {
      setSnapshot(null)
      setResult(null)
      setSelectedRead(null)
      setError('当前项目不存在或尚未加载，无法读取知识库。')
      setLoading(false)
      return
    }
    const generation = ++snapshotGenerationRef.current
    setLoading(true)
    setError(null)
    try {
      const nextSnapshot = await window.electronAPI.getProjectKnowledgeSnapshot(workspaceId)
      if (generation !== snapshotGenerationRef.current) return
      setSnapshot(nextSnapshot)
    } catch (nextError) {
      if (generation !== snapshotGenerationRef.current) return
      setError(knowledgeErrorMessage(nextError, '读取项目知识库失败'))
    } finally {
      if (generation === snapshotGenerationRef.current) setLoading(false)
    }
  }, [workspaceId])

  React.useEffect(() => {
    searchGenerationRef.current += 1
    readGenerationRef.current += 1
    setResult(null)
    setSelectedRead(null)
    setQuery(search ?? '')
  }, [search])

  React.useEffect(() => {
    snapshotGenerationRef.current += 1
    searchGenerationRef.current += 1
    readGenerationRef.current += 1
    knowledgeActionGenerationRef.current += 1
    knowledgeWorkflowSessionIdRef.current = null
    setSnapshot(null)
    setResult(null)
    setSelectedRead(null)
    setActiveView('knowledge')
    setResourceView('knowledge')
    setQuery(search ?? '')
    setCategory('all')
    setLoading(true)
    setSearching(false)
    setReading(false)
    setActionPending(false)
    setError(null)
    setKnowledgeActionPending(null)
    setKnowledgeActionError(null)
    void loadSnapshot()
    return () => {
      snapshotGenerationRef.current += 1
      searchGenerationRef.current += 1
      readGenerationRef.current += 1
      knowledgeActionGenerationRef.current += 1
    }
  }, [loadSnapshot])

  React.useEffect(() => {
    if (!workspaceId || !snapshot?.initialized) {
      setResult(null)
      return
    }
    const scope: ProjectKnowledgeScope = resourceView
    const generation = ++searchGenerationRef.current
    const timer = window.setTimeout(() => {
      setSearching(true)
      setError(null)
      void window.electronAPI.searchProjectKnowledge({
        workspaceId,
        query,
        category: category === 'all' ? undefined : category,
        scope,
        offset: 0,
        limit: KNOWLEDGE_PAGE_SIZE,
      }).then((nextResult) => {
        if (generation !== searchGenerationRef.current) return
        setResult(nextResult)
        // 查询条件切换已同步清空旧选择；目录迟到返回不得关闭用户刚从大纲打开的正文。
      }).catch((nextError: unknown) => {
        if (generation !== searchGenerationRef.current) return
        setError(knowledgeErrorMessage(nextError, scope === 'knowledge' ? '搜索提炼知识失败' : '搜索来源资料失败'))
      }).finally(() => {
        if (generation === searchGenerationRef.current) setSearching(false)
      })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [resourceView, category, query, snapshot?.initialized, snapshot?.revision, workspaceId])

  React.useEffect(() => {
    if (!workspaceId || !snapshot?.initialized || actionPending || knowledgeActionPending) return
    let disposed = false
    const stop = startKnowledgePolling({
      visible: () => document.visibilityState !== 'hidden',
      intervalMs: snapshot.scan.status === 'running' ? SCAN_POLL_INTERVAL_MS : 30_000,
      refresh: async () => {
        const generation = snapshotGenerationRef.current
        try {
          const nextSnapshot = await window.electronAPI.getProjectKnowledgeSnapshot(workspaceId)
          if (disposed || generation !== snapshotGenerationRef.current) return
          setSnapshot((current) => current && current.revision > nextSnapshot.revision ? current : nextSnapshot)
        } catch (nextError) {
          if (!disposed && generation === snapshotGenerationRef.current) setError(knowledgeErrorMessage(nextError, '刷新知识状态失败'))
        }
      },
    })
    return () => {
      disposed = true
      stop()
    }
  }, [snapshot?.initialized, snapshot?.scan.status, workspaceId, actionPending, knowledgeActionPending])

  /** 按入口新建或续接项目整理会话，并防止覆盖尚未消费的输入。 */
  const dispatchKnowledgeWorkflow = React.useCallback(async (
    createPrompt: (sessionId: string) => AgentPendingPrompt,
    isCurrent: () => boolean,
    /** 更新入口使用 new；清单调整、确认和恢复使用 continue。 */
    sessionMode: 'new' | 'continue' = 'continue',
  ): Promise<void> => {
    if (!workspaceId || !isCurrent()) return
    if (store.get(agentPendingPromptAtom)) throw new Error('已有 Agent 输入任务尚未处理，请稍后重试')
    const currentSessions = store.get(agentSessionsAtom)
    const preferredSessionId = (sessionMode === 'continue' ? knowledgeWorkflowSessionIdRef.current : null) ?? sessionId ?? currentAgentSessionId
    const preferredSession = currentSessions.find((candidate) => candidate.id === preferredSessionId)
    let targetSessionId = sessionMode === 'new' ? null : selectKnowledgeMaintenanceSession(currentSessions, preferredSessionId, workspaceId)
    if (!targetSessionId) {
      targetSessionId = await createAgent({
        title: '项目知识整理',
        workspaceId,
        open: false,
        channelId: preferredSession?.channelId,
        modelId: preferredSession?.modelId,
      }) ?? null
    }
    if (!isCurrent()) return
    if (!targetSessionId) throw new Error('无法创建项目知识整理会话')
    if (store.get(agentPendingPromptAtom)) throw new Error('已有 Agent 输入任务尚未处理，请稍后重试')
    knowledgeWorkflowSessionIdRef.current = targetSessionId
    setPendingPrompt(createPrompt(targetSessionId))
    const targetSession = store.get(agentSessionsAtom).find((candidate) => candidate.id === targetSessionId)
    openSession('agent', targetSessionId, targetSession?.title ?? '项目知识整理')
  }, [createAgent, currentAgentSessionId, openSession, sessionId, setPendingPrompt, store, workspaceId])

  /** 发起扫描；知识页随后调度 Agent 提炼，来源页只更新来源索引。 */
  const handleScan = React.useCallback(async (): Promise<void> => {
    if (!workspaceId) return
    knowledgeActionGenerationRef.current += 1
    setKnowledgeActionPending(null)
    const generation = ++snapshotGenerationRef.current
    setActionPending(true)
    setError(null)
    try {
      const nextSnapshot = await window.electronAPI.scanProjectKnowledge(workspaceId)
      if (generation !== snapshotGenerationRef.current) return
      setSnapshot(nextSnapshot)
      if (activeView === 'knowledge') {
        setActionPending(false)
        const completedSnapshot = await waitForKnowledgeScan({
          initialSnapshot: nextSnapshot,
          getSnapshot: () => window.electronAPI.getProjectKnowledgeSnapshot(workspaceId),
          isCurrent: () => generation === snapshotGenerationRef.current,
          onSnapshot: (currentSnapshot) => { setSnapshot(currentSnapshot) },
        })
        if (generation !== snapshotGenerationRef.current) return
        const scanMessage = completedSnapshot.scan.status === 'failed'
          ? completedSnapshot.scan.message || '部分来源扫描失败，以下提炼仅基于当前可用来源。'
          : completedSnapshot.scan.skipped > 0
            ? completedSnapshot.scan.message
            : undefined
        const approvedPlan = completedSnapshot.workflow?.approved
        const createPrompt = approvedPlan && !completedSnapshot.workflow?.proposal
          ? (targetSessionId: string) => buildKnowledgeGenerationPendingPrompt(targetSessionId, approvedPlan.revision)
          : (targetSessionId: string) => buildKnowledgeMaintenancePendingPrompt(targetSessionId, scanMessage)
        await dispatchKnowledgeWorkflow(createPrompt, () => generation === snapshotGenerationRef.current, 'new')
      }
    } catch (nextError) {
      if (generation !== snapshotGenerationRef.current) return
      setError(knowledgeErrorMessage(nextError, activeView === 'knowledge' ? '提交知识维护任务失败' : '启动资料扫描失败'))
    } finally {
      if (generation === snapshotGenerationRef.current) setActionPending(false)
    }
  }, [activeView, dispatchKnowledgeWorkflow, workspaceId])

  /** 请求取消当前扫描，以主进程回传的最终状态为准。 */
  const handleCancelScan = React.useCallback(async (): Promise<void> => {
    if (!workspaceId) return
    knowledgeActionGenerationRef.current += 1
    setKnowledgeActionPending(null)
    const generation = ++snapshotGenerationRef.current
    setActionPending(true)
    setError(null)
    try {
      const nextSnapshot = await window.electronAPI.cancelProjectKnowledgeScan(workspaceId)
      if (generation !== snapshotGenerationRef.current) return
      setSnapshot(nextSnapshot)
    } catch (nextError) {
      if (generation !== snapshotGenerationRef.current) return
      setError(knowledgeErrorMessage(nextError, '取消资料扫描失败'))
    } finally {
      if (generation === snapshotGenerationRef.current) setActionPending(false)
    }
  }, [workspaceId])

  /** 按稳定 ID 读取首段正文；修订未知时由主进程读取当前版本。 */
  const handleSelectEntryById = React.useCallback(async (entryId: string, expectedRevision?: string): Promise<void> => {
    if (!workspaceId) return
    const generation = ++readGenerationRef.current
    setReading(true)
    setSelectedRead(null)
    setKnowledgeActionError(null)
    try {
      const nextRead = await window.electronAPI.readProjectKnowledge({
        workspaceId,
        entryId,
        expectedRevision,
      })
      if (generation !== readGenerationRef.current) return
      setSelectedRead(nextRead)
    } catch (nextError) {
      if (generation !== readGenerationRef.current) return
      setError(knowledgeErrorMessage(nextError, '读取资料正文失败'))
    } finally {
      if (generation === readGenerationRef.current) setReading(false)
    }
  }, [workspaceId])

  /** 目录条目携带已展示版本，读取时继续执行乐观一致性复核。 */
  const handleSelectEntry = React.useCallback(async (entry: KnowledgeEntry): Promise<void> => {
    await handleSelectEntryById(entry.id, entry.revision)
  }, [handleSelectEntryById])

  /** 读取目录下一页，并保留当前页已选条目。 */
  const handleLoadMore = React.useCallback(async (): Promise<void> => {
    if (!workspaceId || activeView === 'memory' || result?.nextOffset === undefined) return
    const scope: ProjectKnowledgeScope = resourceView
    const generation = ++searchGenerationRef.current
    setSearching(true)
    try {
      const nextResult = await window.electronAPI.searchProjectKnowledge({
        workspaceId,
        query,
        category: category === 'all' ? undefined : category,
        scope,
        offset: result.nextOffset,
        limit: KNOWLEDGE_PAGE_SIZE,
      })
      if (generation !== searchGenerationRef.current) return
      setResult(mergeKnowledgeSearchResults(result, nextResult))
    } catch (nextError) {
      if (generation !== searchGenerationRef.current) return
      setError(knowledgeErrorMessage(nextError, scope === 'knowledge' ? '加载更多知识失败' : '加载更多来源失败'))
    } finally {
      if (generation === searchGenerationRef.current) setSearching(false)
    }
  }, [activeView, category, query, result, workspaceId])

  /** 追加有界正文下一页，条目或修订变化时拒绝拼接。 */
  const handleLoadMoreContent = React.useCallback(async (): Promise<void> => {
    if (!workspaceId || !selectedRead || selectedRead.nextOffset === undefined) return
    const baseRead = selectedRead
    const generation = ++readGenerationRef.current
    setReading(true)
    try {
      const nextRead = await window.electronAPI.readProjectKnowledge({
        workspaceId,
        entryId: baseRead.entry.id,
        expectedRevision: baseRead.entry.revision,
        offset: baseRead.nextOffset,
      })
      if (generation !== readGenerationRef.current || nextRead.entry.id !== baseRead.entry.id) return
      setSelectedRead({ ...nextRead, content: `${baseRead.content}${nextRead.content}` })
    } catch (nextError) {
      if (generation !== readGenerationRef.current) return
      setError(knowledgeErrorMessage(nextError, '加载下一页正文失败'))
    } finally {
      if (generation === readGenerationRef.current) setReading(false)
    }
  }, [selectedRead, workspaceId])

  /** 关闭预览并使在途正文请求失效。 */
  const handleClosePreview = React.useCallback((): void => {
    readGenerationRef.current += 1
    setSelectedRead(null)
    setReading(false)
  }, [])

  /** 仅切换知识/来源作用域时重置目录；顶部记忆切换保留正文和搜索。 */
  const handleActiveViewChange = React.useCallback((nextView: ProjectKnowledgeView): void => {
    if (nextView !== 'memory' && nextView !== resourceView) {
      searchGenerationRef.current += 1
      readGenerationRef.current += 1
      setResult(null)
      setSelectedRead(null)
      setSearching(false)
      setReading(false)
      setQuery('')
      setCategory('all')
      setResourceView(nextView)
    }
    setActiveView(nextView)
  }, [resourceView])

  React.useEffect(() => {
    if (matchesMemoryNavigation(memoryNavigationRequest, workspaceSlug, sessionId)) handleActiveViewChange('memory')
  }, [handleActiveViewChange, memoryNavigationRequest, workspaceSlug, sessionId])

  /** 通过知识条目的受控证据身份读取来源，不接受 renderer 提供任意文件路径。 */
  const handleSelectEvidence = React.useCallback(async (entryId: string, expectedRevision: string): Promise<void> => {
    if (!workspaceId) return
    const generation = ++readGenerationRef.current
    setReading(true)
    setKnowledgeActionError(null)
    try {
      const nextRead = await window.electronAPI.readProjectKnowledge({ workspaceId, entryId, expectedRevision })
      if (generation !== readGenerationRef.current) return
      setSelectedRead(nextRead)
    } catch (nextError) {
      if (generation !== readGenerationRef.current) return
      setError(knowledgeErrorMessage(nextError, '读取提炼依据失败'))
    } finally {
      if (generation === readGenerationRef.current) setReading(false)
    }
  }, [workspaceId])

  /** 输入变化时立即废弃旧目录和正文请求，避免防抖窗口显示迟到结果。 */
  const handleQueryChange = React.useCallback((nextQuery: string): void => {
    searchGenerationRef.current += 1
    readGenerationRef.current += 1
    setResult(null)
    setSelectedRead(null)
    setSearching(false)
    setReading(false)
    setQuery(nextQuery)
  }, [])

  /** 分类变化与搜索词变化使用相同的请求隔离语义。 */
  const handleCategoryChange = React.useCallback((nextCategory: KnowledgeCategoryFilter): void => {
    searchGenerationRef.current += 1
    readGenerationRef.current += 1
    setResult(null)
    setSelectedRead(null)
    setSearching(false)
    setReading(false)
    setCategory(nextCategory)
  }, [])

  /** 串行执行返回权威快照的维护操作，并隔离跨项目迟到结果。 */
  const executeKnowledgeAction = React.useCallback(async (
    actionKey: string,
    fallbackMessage: string,
    operation: () => Promise<KnowledgeSnapshot>,
  ): Promise<KnowledgeSnapshot | null> => {
    const generation = ++knowledgeActionGenerationRef.current
    snapshotGenerationRef.current += 1
    setActionPending(false)
    setKnowledgeActionPending(actionKey)
    setKnowledgeActionError(null)
    try {
      const nextSnapshot = await operation()
      if (generation !== knowledgeActionGenerationRef.current) return null
      setSnapshot(nextSnapshot)
      return nextSnapshot
    } catch (nextError) {
      if (generation !== knowledgeActionGenerationRef.current) return null
      setKnowledgeActionError(knowledgeErrorMessage(nextError, fallbackMessage))
      return null
    } finally {
      if (generation === knowledgeActionGenerationRef.current) setKnowledgeActionPending(null)
    }
  }, [])

  /** 确认用户实际选择的分组，并在成功后复用规划会话继续生成。 */
  const handleConfirmKnowledgePlan = React.useCallback(async (groups: KnowledgePlanSelection[]): Promise<void> => {
    if (!workspaceId || !snapshot?.workflow?.proposal) return
    const proposal = snapshot.workflow.proposal
    const generation = knowledgeActionGenerationRef.current + 1
    const nextSnapshot = await executeKnowledgeAction(
      'confirm-plan',
      '确认知识库范围失败',
      () => window.electronAPI.confirmProjectKnowledgePlan({
        workspaceId,
        planId: proposal.id,
        expectedRevision: proposal.revision,
        groups,
      }),
    )
    if (!nextSnapshot?.workflow?.approved || generation !== knowledgeActionGenerationRef.current) return
    try {
      const approvedRevision = nextSnapshot.workflow.approved.revision
      await dispatchKnowledgeWorkflow(
        (targetSessionId) => buildKnowledgeGenerationPendingPrompt(targetSessionId, approvedRevision),
        () => generation === knowledgeActionGenerationRef.current,
      )
    } catch (nextError) {
      if (generation === knowledgeActionGenerationRef.current) {
        setKnowledgeActionError(knowledgeErrorMessage(nextError, '知识范围已确认，但提交生成任务失败'))
      }
    }
  }, [dispatchKnowledgeWorkflow, executeKnowledgeAction, snapshot?.workflow?.proposal, workspaceId])

  /** 把用户调整要求交给同一项目 Agent，保持当前计划未确认。 */
  const handleRequestKnowledgePlanAdjustment = React.useCallback(async (instruction: string): Promise<void> => {
    const proposal = snapshot?.workflow?.proposal
    if (!proposal || !instruction.trim()) return
    const generation = ++knowledgeActionGenerationRef.current
    setKnowledgeActionPending('adjust-plan')
    setKnowledgeActionError(null)
    try {
      await dispatchKnowledgeWorkflow(
        (targetSessionId) => buildKnowledgePlanAdjustmentPendingPrompt(targetSessionId, proposal.id, proposal.revision, instruction.trim()),
        () => generation === knowledgeActionGenerationRef.current,
      )
    } catch (nextError) {
      if (generation === knowledgeActionGenerationRef.current) setKnowledgeActionError(knowledgeErrorMessage(nextError, '提交清单调整失败'))
    } finally {
      if (generation === knowledgeActionGenerationRef.current) setKnowledgeActionPending(null)
    }
  }, [dispatchKnowledgeWorkflow, snapshot?.workflow?.proposal])

  /** 暂停或继续已确认工作流，以主进程返回状态为准。 */
  const handlePauseKnowledgeWorkflow = React.useCallback(async (paused: boolean): Promise<void> => {
    if (!workspaceId) return
    /** 继续动作与确认动作一样绑定本次 UI 代次，防止切换项目后的迟到派发。 */
    const generation = knowledgeActionGenerationRef.current + 1
    const nextSnapshot = await executeKnowledgeAction(
      'pause-workflow',
      paused ? '暂停知识生成失败' : '继续知识生成失败',
      () => window.electronAPI.pauseProjectKnowledgeWorkflow({ workspaceId, paused }),
    )
    if (paused || !nextSnapshot?.workflow?.approved || generation !== knowledgeActionGenerationRef.current) return
    try {
      /** 恢复权限后主动续接已有大纲，后台没有隐式模型队列。 */
      const approvedRevision = nextSnapshot.workflow.approved.revision
      await dispatchKnowledgeWorkflow(
        (targetSessionId) => buildKnowledgeGenerationPendingPrompt(targetSessionId, approvedRevision),
        () => generation === knowledgeActionGenerationRef.current,
      )
    } catch (nextError) {
      if (generation === knowledgeActionGenerationRef.current) {
        setKnowledgeActionError(knowledgeErrorMessage(nextError, '已解除暂停，但提交继续任务失败'))
      }
    }
  }, [dispatchKnowledgeWorkflow, executeKnowledgeAction, workspaceId])

  /** 按用户所见 revision 确认或排除当前资料。 */
  const handleReviewEntry = React.useCallback(async (
    entry: KnowledgeEntry,
    action: 'confirm' | 'reject',
  ): Promise<void> => {
    if (!workspaceId) return
    const nextSnapshot = await executeKnowledgeAction(
      `${action}:${entry.id}`,
      action === 'confirm' ? '确认资料失败' : '排除资料失败',
      () => window.electronAPI.reviewProjectKnowledge({
        workspaceId,
        entryId: entry.id,
        expectedRevision: entry.revision,
        action,
      }),
    )
    if (nextSnapshot) handleClosePreview()
  }, [executeKnowledgeAction, handleClosePreview, workspaceId])

  const combinedKnowledgeAction = knowledgeActionPending
    ?? (actionPending || snapshot?.scan.status === 'running' ? 'scan' : null)
  /** 大纲已生成项可从快照或当前目录结果中找到真实条目。 */
  const workflowEntries = React.useMemo(() => {
    const entriesById = new Map<string, KnowledgeEntry>()
    for (const entry of snapshot?.entries ?? []) entriesById.set(entry.id, entry)
    for (const item of result?.items ?? []) entriesById.set(item.entry.id, item.entry)
    return [...entriesById.values()]
  }, [result?.items, snapshot?.entries])
  /** 仅在存在用户待处理计划时展示知识库工作流。 */
  const workflow = snapshot?.initialized && snapshot.workflow ? (
    <KnowledgeWorkflowPanel
      workflow={snapshot.workflow}
      entries={workflowEntries}
      pendingAction={combinedKnowledgeAction}
      error={knowledgeActionError}
      onConfirm={(groups) => { void handleConfirmKnowledgePlan(groups) }}
      onPause={(paused) => { void handlePauseKnowledgeWorkflow(paused) }}
      onSelectEntryId={(entryId, expectedRevision) => { void handleSelectEntryById(entryId, expectedRevision) }}
      onRequestAdjustment={(instruction) => { void handleRequestKnowledgePlanAdjustment(instruction) }}
    />
  ) : undefined

  const activeScope = resourceView
  const directoryView = (
    <ProjectKnowledgeResourcesView
      scope={activeScope}
      snapshot={snapshot}
      result={result}
      selectedRead={selectedRead}
      loading={loading}
      searching={searching}
      reading={reading}
      actionPending={actionPending || Boolean(knowledgeActionPending)}
      error={error}
      query={query}
      category={category}
      workflow={activeScope === 'knowledge' ? workflow : undefined}
      pendingKnowledgeAction={combinedKnowledgeAction}
      knowledgeActionError={knowledgeActionError}
      onQueryChange={handleQueryChange}
      onCategoryChange={handleCategoryChange}
      onScan={() => { void handleScan() }}
      onCancelScan={() => { void handleCancelScan() }}
      onRetry={() => { void loadSnapshot() }}
      onSelectEntry={(entry) => { void handleSelectEntry(entry) }}
      onLoadMore={() => { void handleLoadMore() }}
      onLoadMoreContent={() => { void handleLoadMoreContent() }}
      onClosePreview={handleClosePreview}
      onSelectEvidence={(entryId, revision) => { void handleSelectEvidence(entryId, revision) }}
      onReviewEntry={activeScope === 'knowledge' ? (entry, action) => { void handleReviewEntry(entry, action) } : undefined}
    />
  )

  const memory = (
    <WorkspaceMemoryTab
      workspaceSlug={workspaceSlug}
      active={activeView === 'memory'}
      key={workspaceSlug}
      sessionId={sessionId}
      embedded={embedded}
      search={search}
      onCloseChangeView={onRequestClose}
    />
  )

  return (
    <ProjectKnowledgeTabShell
      activeView={activeView}
      onActiveViewChange={handleActiveViewChange}
      knowledge={directoryView}
      sources={directoryView}
      memory={memory}
    />
  )
}
