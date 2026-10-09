import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { AlertTriangle, Brain, FileText, FolderOpen, RefreshCw, Search } from 'lucide-react'
import type { SkillFileNode, WorkspaceMemorySummary } from '@proma/shared'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { AgentActionHint } from '@/components/agent/AgentActionHint'
import { WorkspaceMemoryChangeShelf } from './WorkspaceMemoryChangeShelf'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { matchesMemoryNavigation, memoryFileNavigationAtom, workspaceMemoryChangesAtom } from '@/atoms/memory-change-atoms'
import { cn } from '@/lib/utils'
import { LiveMarkdownEditor } from '@/components/markdown/LiveMarkdownEditor'

type SelectedMemoryFile =
  | { kind: 'agents'; relativePath: 'AGENTS.md'; title: string; absolutePath: string }
  | { kind: 'auto'; relativePath: string; title: string; absolutePath: string }

interface WorkspaceMemoryTabProps {
  workspaceSlug: string
  /** 顶部切换时保留草稿，但隐藏的记忆页不得关闭用户正在查看的知识库。 */
  active?: boolean
  /** 仅嵌入 Agent 右侧工作区时传入，用于展示当前会话的记忆变更 Diff。 */
  sessionId?: string
  /** 记忆 Diff 查看结束或失效时关闭当前会话的项目记忆 Tab，避免回退到完整记忆。 */
  onCloseChangeView?: () => void
  /** 能力中心传入的统一搜索词；嵌入组件未传时提供自己的内容搜索。 */
  search?: string
  embedded?: boolean
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function autoMemoryPath(summary: WorkspaceMemorySummary, relativePath: string): string {
  const directory = summary.autoMemory.directory
  // directory 由主进程 join() 生成，Windows 上使用反斜杠；沿用其分隔符风格，
  // 并把 relativePath 里的正斜杠归一化，避免拼出 C:\...\memory/MEMORY.md 这类混合路径。
  const sep = directory.includes('\\') && !directory.includes('/') ? '\\' : '/'
  const normalizedRelative = relativePath.replace(/[\\/]/g, sep)
  const trimmedDir = directory.replace(/[\\/]+$/, '')
  return `${trimmedDir}${sep}${normalizedRelative}`
}


/**
 * 将目录元数据展开为文件列表，保留相对路径作为身份；不读取或搬动磁盘文件。
 * @param nodes 原记忆目录树。
 * @param query 文件名、目录路径或正文搜索词。
 * @param contentMatchPaths 已有有界正文搜索命中的相对路径。
 * @returns 按原目录顺序排列、符合搜索条件的文件。
 */
export function listMemoryFiles(nodes: SkillFileNode[], query: string, contentMatchPaths = new Set<string>()): SkillFileNode[] {
  /** 只对用户搜索词做大小写归一化，原文件身份保持不变。 */
  const normalizedQuery = query.trim().toLowerCase()
  return nodes.flatMap((node) => {
    if (node.type === 'directory') return listMemoryFiles(node.children ?? [], query, contentMatchPaths)
    return !normalizedQuery || node.relativePath.toLowerCase().includes(normalizedQuery)
      || node.name.toLowerCase().includes(normalizedQuery) || contentMatchPaths.has(node.relativePath) ? [node] : []
  })
}

export function WorkspaceMemoryTab({ workspaceSlug, active = true, sessionId, search, embedded = false, onCloseChangeView }: WorkspaceMemoryTabProps): React.ReactElement {
  const [memoryNavigationRequest, setMemoryNavigationRequest] = useAtom(memoryFileNavigationAtom)
  const workspaceMemoryChanges = useAtomValue(workspaceMemoryChangesAtom)
  const memoryChanges = workspaceMemoryChanges.get(workspaceSlug) ?? []
  const latestMemoryChange = memoryChanges[0]
  const [activeChangeId, setActiveChangeId] = React.useState<string | null>(null)
  const activeMemoryChange = activeChangeId
    ? memoryChanges.find((change) => `${change.relativePath}:${change.changedAt}` === activeChangeId)
    : undefined
  const [summary, setSummary] = React.useState<WorkspaceMemorySummary | null>(null)
  const [autoFiles, setAutoFiles] = React.useState<SkillFileNode[]>([])
  const [selected, setSelected] = React.useState<SelectedMemoryFile | null>(null)
  const [editText, setEditText] = React.useState('')
  const [editBaseText, setEditBaseText] = React.useState('')
  const [saveConflict, setSaveConflict] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [loadingFile, setLoadingFile] = React.useState(false)
  const [isDirty, setIsDirty] = React.useState(false)
  const [contentMatches, setContentMatches] = React.useState<Map<string, string>>(new Map())
  /** 两种入口均提供按需搜索，不在打开记忆时预加载全部正文。 */
  const [effectiveSearch, setEffectiveSearch] = React.useState(search ?? '')
  React.useEffect(() => { setEffectiveSearch(search ?? '') }, [search, workspaceSlug])

  // 自动保存：用 ref 持有最新的编辑状态，供防抖定时器与"切换文件前 flush"复用，
  // 避免把 selected/editText 塞进一堆回调的依赖数组里。
  const saveStateRef = React.useRef<{ selected: SelectedMemoryFile | null; editText: string; editBaseText: string; isDirty: boolean; saveConflict: boolean }>({
    selected: null,
    editText: '',
    editBaseText: '',
    isDirty: false,
    saveConflict: false,
  })
  React.useEffect(() => {
    saveStateRef.current = { selected, editText, editBaseText, isDirty, saveConflict }
  }, [selected, editText, editBaseText, isDirty, saveConflict])
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistInFlightRef = React.useRef<Promise<boolean> | null>(null)
  /** 只允许最新文件读取提交结果，防止快速切换时迟到响应覆盖草稿。 */
  const fileReadGenerationRef = React.useRef(0)
  /** 窄侧栏逐层进入详情，宽容器仍同时展示列表和正文。 */
  const [showFileDetail, setShowFileDetail] = React.useState(false)
  const refreshSummaryAndTree = React.useCallback(async (): Promise<WorkspaceMemorySummary> => {
    const [nextSummary, files] = await Promise.all([
      window.electronAPI.getWorkspaceMemorySummary(workspaceSlug),
      window.electronAPI.listWorkspaceAutoMemoryFiles(workspaceSlug),
    ])
    setSummary(nextSummary)
    setAutoFiles(files)
    return nextSummary
  }, [workspaceSlug])

  /** 底层写入：先核验磁盘仍是打开时的基线，避免自动保存覆盖外部更新。 */
  const persistTarget = React.useCallback(async (target: SelectedMemoryFile, text: string, baseText: string): Promise<void> => {
    if (target.kind === 'agents') {
      await window.electronAPI.writeWorkspaceAgentsMd(workspaceSlug, text, baseText)
    } else {
      await window.electronAPI.writeWorkspaceAutoMemoryFile(workspaceSlug, target.relativePath, text, baseText)
    }
    // 正文已成功落盘后，目录刷新失败不冒充保存失败，防止重试旧基线。
    await refreshSummaryAndTree().catch((error) => console.error('[工作区记忆] 保存后刷新目录失败:', error))
  }, [workspaceSlug, refreshSummaryAndTree])

  /**
   * 串行刷盘并返回成功状态；切换文件只能在全部新输入保存后继续。
   * 写入失败保留草稿与冲突状态，不允许调用方继续覆盖编辑器。
   */
  const flushPendingSave = React.useCallback(async (): Promise<boolean> => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
    while (true) {
      if (persistInFlightRef.current) {
        if (!await persistInFlightRef.current) return false
        continue
      }
      /** 每次写入重新取得最新文本与基线，包含上一次保存期间的新输入。 */
      const current = saveStateRef.current
      if (current.saveConflict) return false
      if (!current.selected || !current.isDirty) return true
      const target = current.selected
      /** 所有并发 flush 等待同一笔操作；副作用与 ref 更新一并完成才释放。 */
      const operation = (async (): Promise<boolean> => {
        try {
          await persistTarget(target, current.editText, current.editBaseText)
          const latest = saveStateRef.current
          const dirty = latest.editText !== current.editText
          saveStateRef.current = { ...latest, editBaseText: current.editText, isDirty: dirty, saveConflict: false }
          setEditBaseText(current.editText)
          setIsDirty(dirty)
          setSaveConflict(false)
          return true
        } catch (err) {
          console.error('[工作区记忆] 自动保存失败:', err)
          const message = err instanceof Error ? err.message : '自动保存失败'
          const conflict = message.startsWith('文件已被外部更新')
          saveStateRef.current = { ...saveStateRef.current, isDirty: true, saveConflict: conflict }
          toast.error(message)
          setSaveConflict(conflict)
          setIsDirty(true)
          return false
        }
      })()
      persistInFlightRef.current = operation
      const succeeded = await operation
      if (persistInFlightRef.current === operation) persistInFlightRef.current = null
      if (!succeeded) return false
    }
  }, [persistTarget])

  /**
   * 打开原记忆文件；只有最新请求且旧草稿成功保存后才替换详情。
   * @param kind 工作区规则或记忆文件。
   * @param relativePath 主进程校验的相对路径。
   * @param refreshFile 用户显式刷新时重新读取目录；冲突草稿由成功读回磁盘版本替换。
   */
  const openMemoryFile = React.useCallback(async (kind: SelectedMemoryFile['kind'], relativePath: string, refreshFile = false): Promise<void> => {
    const generation = ++fileReadGenerationRef.current
    if (saveStateRef.current.saveConflict && !refreshFile) {
      setLoadingFile(false)
      toast.error('当前文件有外部更新，请先刷新或复制修改后再切换。')
      return
    }
    setLoadingFile(true)
    try {
      if (!(refreshFile && saveStateRef.current.saveConflict) && !await flushPendingSave()) return
      if (generation !== fileReadGenerationRef.current) return
      const currentSummary = refreshFile ? await refreshSummaryAndTree()
        : summary ?? await window.electronAPI.getWorkspaceMemorySummary(workspaceSlug)
      const file = kind === 'agents'
        ? await window.electronAPI.readWorkspaceAgentsMd(workspaceSlug)
        : await window.electronAPI.readWorkspaceAutoMemoryFile(workspaceSlug, relativePath)
      if (generation !== fileReadGenerationRef.current) return
      /** 身份和正文一起提交，避免新文件复用旧文件的保存基线。 */
      const target: SelectedMemoryFile = kind === 'agents'
        ? { kind, relativePath: 'AGENTS.md', title: 'AGENTS.md', absolutePath: currentSummary.agentsMd.path }
        : { kind, relativePath, title: relativePath, absolutePath: autoMemoryPath(currentSummary, relativePath) }
      const content = file.content ?? ''
      saveStateRef.current = { selected: target, editText: content, editBaseText: content, saveConflict: false, isDirty: false }
      setSelected(target)
      setEditText(content)
      setEditBaseText(content)
      setSaveConflict(false)
      setIsDirty(false)
      setShowFileDetail(true)
    } catch (err) {
      if (generation !== fileReadGenerationRef.current) return
      console.error('[工作区记忆] 读取文件失败:', err)
      toast.error(err instanceof Error ? err.message : '读取记忆文件失败')
    } finally {
      if (generation === fileReadGenerationRef.current) setLoadingFile(false)
    }
  }, [summary, workspaceSlug, flushPendingSave, refreshSummaryAndTree])

  /** 沿用原有工作区规则入口，文件仍由原 API 读写。 */
  const openAgents = React.useCallback(() => openMemoryFile('agents', 'AGENTS.md'), [openMemoryFile])
  /** 沿用原有主题文件入口，目录结构保持不变。 */
  const openAutoFile = React.useCallback((relativePath: string) => openMemoryFile('auto', relativePath), [openMemoryFile])

  React.useEffect(() => {
    // 首次打开先完成默认文件加载，避免迟到的初始化响应覆盖通知指定的文件。
    if (loading || !summary || !memoryNavigationRequest || !matchesMemoryNavigation(memoryNavigationRequest, workspaceSlug, sessionId)) return
    if (memoryNavigationRequest.mode === 'change') {
      const change = memoryChanges.find((item) => item.relativePath === memoryNavigationRequest.relativePath)
      if (!change || !sessionId) return
      setActiveChangeId(`${change.relativePath}:${change.changedAt}`)
      setMemoryNavigationRequest((current) => current === memoryNavigationRequest ? null : current)
      return
    }
    // 先按身份消费再读取，异步完成不得清理后来的请求。
    setMemoryNavigationRequest((current) => current === memoryNavigationRequest ? null : current)
    setActiveChangeId(null)
    void openAutoFile(memoryNavigationRequest.relativePath)
  }, [loading, summary, memoryChanges, memoryNavigationRequest, openAutoFile, sessionId, setMemoryNavigationRequest, workspaceSlug])

  React.useEffect(() => {
    if (!embedded || !activeChangeId || activeMemoryChange) return
    if (!active) {
      setActiveChangeId(null)
      return
    }
    // Diff 对应的临时变更已经被消费或被新变更替换时，不能落回完整记忆列表。
    // 完整记忆只由用户主动打开项目记忆 Tab 查看。
    onCloseChangeView?.()
  }, [active, activeChangeId, activeMemoryChange, embedded, onCloseChangeView])

  React.useEffect(() => {
    if (!latestMemoryChange) return
    void refreshSummaryAndTree().catch((error) => console.error('[工作区记忆] 刷新全局变更失败:', error))
  }, [latestMemoryChange?.changedAt, refreshSummaryAndTree])

  /** 显式刷新重读当前文件；冲突时仅在磁盘读取成功后替换用户可复制的草稿。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    const target = saveStateRef.current.selected
    await openMemoryFile(target?.kind ?? 'agents', target?.relativePath ?? 'AGENTS.md', true)
  }, [openMemoryFile])

  React.useEffect(() => {
    let cancelled = false
    const generation = ++fileReadGenerationRef.current
    setShowFileDetail(false)
    setSelected(null)
    setEditText('')
    setEditBaseText('')
    setSaveConflict(false)
    setIsDirty(false)
    setLoading(true)
    void (async () => {
      try {
        const [nextSummary, files, claudeFile] = await Promise.all([
          window.electronAPI.getWorkspaceMemorySummary(workspaceSlug),
          window.electronAPI.listWorkspaceAutoMemoryFiles(workspaceSlug),
          window.electronAPI.readWorkspaceAgentsMd(workspaceSlug),
        ])
        if (cancelled || generation !== fileReadGenerationRef.current) return
        setSummary(nextSummary)
        setAutoFiles(files)
        setSelected({
          kind: 'agents',
          relativePath: 'AGENTS.md',
          title: 'AGENTS.md',
          absolutePath: nextSummary.agentsMd.path,
        })
        setEditText(claudeFile.content ?? '')
        setEditBaseText(claudeFile.content ?? '')
        setSaveConflict(false)
        setIsDirty(false)
      } catch (err) {
        console.error('[工作区记忆] 加载失败:', err)
        toast.error('加载协作知识失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true; fileReadGenerationRef.current += 1 }
  }, [workspaceSlug])

  // 防抖自动保存：编辑内容变脏后 800ms 内无新输入则自动保存。
  React.useEffect(() => {
    if (!selected || !isDirty || loadingFile) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      void flushPendingSave()
    }, 800)
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
    }
  }, [editText, selected, isDirty, loadingFile, flushPendingSave])

  // 组件卸载（如切走 Tab）时，把未保存内容刷盘，防止编辑丢失
  React.useEffect(() => {
    return () => {
      void flushPendingSave()
    }
  }, [flushPendingSave])
  // 文件名之外也可按正文内容检索。只在用户主动搜索时读取文本文件，做 180ms 防抖、
  // 忽略大文件并限制候选数，避免右侧面板的每次输入触发大量 IPC 或重渲染。
  React.useEffect(() => {
    const query = effectiveSearch.trim().toLowerCase()
    if (!query) {
      setContentMatches(new Map())
      return
    }
    const candidates: SkillFileNode[] = []
    const collect = (nodes: SkillFileNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'directory') collect(node.children ?? [])
        else if (node.isText !== false && (node.size ?? 0) <= 512 * 1024) candidates.push(node)
      }
    }
    collect(autoFiles)
    let cancelled = false
    const timer = window.setTimeout(() => {
      void Promise.all(candidates.slice(0, 60).map(async (node) => {
        try {
          const file = await window.electronAPI.readWorkspaceAutoMemoryFile(workspaceSlug, node.relativePath)
          const line = (file.content ?? '').split(/\r?\n/).find((item) => item.toLowerCase().includes(query))
          return line ? [node.relativePath, line.trim().slice(0, 160)] as const : null
        } catch {
          return null
        }
      })).then((results) => {
        if (cancelled) return
        setContentMatches(new Map(results.filter((result): result is readonly [string, string] => result !== null)))
      })
    }, 180)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [autoFiles, effectiveSearch, workspaceSlug])

  const visibleAutoFiles = React.useMemo(
    () => listMemoryFiles(autoFiles, effectiveSearch, new Set(contentMatches.keys())),
    [autoFiles, contentMatches, effectiveSearch],
  )
  const migrationIssues = [
    summary?.legacyAutoMemory ? '长期记忆迁移' : null,
    summary?.instructionConflict ? '工作区规则迁移' : null,
  ].filter((issue): issue is string => issue !== null)
  const migrationReminderTitle = [
    summary?.legacyAutoMemory ? `长期记忆：${summary.legacyAutoMemory.directory}` : null,
    summary?.instructionConflict ? `工作区规则：${summary.instructionConflict.legacyPath}` : null,
  ].filter((detail): detail is string => detail !== null).join('\n')

  if (activeMemoryChange && sessionId) {
    return (
      <WorkspaceMemoryChangeShelf
        changes={memoryChanges}
        onOpenFile={(change) => {
          setActiveChangeId(null)
          void openAutoFile(change.relativePath)
        }}
        onDismissChanges={embedded ? onCloseChangeView : undefined}
        className="h-full min-h-0 overflow-auto bg-content-area p-3"
      />
    )
  }

  if (loading || !summary) {
    return <div className="py-20 text-center text-sm text-muted-foreground">加载协作知识中...</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3" style={{ containerType: 'inline-size', containerName: 'memory' }}>
      <style>{`
        @container memory (min-width: 600px) {
          .workspace-memory-body { grid-template-columns: minmax(180px, 0.7fr) minmax(0, 1.5fr); }
          .workspace-memory-back { display: none; }
        }
        @container memory (max-width: 599px) {
          .workspace-memory-body { grid-template-columns: minmax(0, 1fr); }
          .workspace-memory-list[data-detail-open="true"], .workspace-memory-detail[data-detail-open="false"] { display: none; }
        }
      `}</style>
      {embedded && (
        <div className="flex shrink-0 items-center gap-2 rounded-xl bg-muted/45 px-3 py-2">
          <Brain className="size-4 shrink-0 text-foreground/65" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">项目记忆</div>
            <div className="text-[11px] text-muted-foreground">{summary.autoMemory.fileCount} 个记忆文件</div>
          </div>
        </div>
      )}
      <AgentActionHint action="查找、补充或修正协作记忆" />

      <div className="workspace-memory-body grid min-h-0 flex-1 grid-cols-[minmax(130px,0.7fr)_minmax(0,1.5fr)] gap-3">
        <div className="workspace-memory-list min-h-0 overflow-hidden rounded-lg border border-border" data-detail-open={showFileDetail}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
              <div className="text-[13px] font-medium text-foreground/75">记忆列表</div>
              <button
                type="button"
                title="刷新"
                aria-label="刷新记忆"
                onClick={() => void refresh()}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="relative m-2 shrink-0">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input value={effectiveSearch} onChange={(event) => setEffectiveSearch(event.target.value)} aria-label="搜索记忆" placeholder="搜索记忆" className="h-8 pl-7 text-xs" />
            </div>
            {migrationIssues.length > 0 && (
              <div
                role="status"
                title={migrationReminderTitle}
                className="mx-2 mt-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300"
              >
                <AlertTriangle size={13} className="shrink-0" />
                <span>待处理：{migrationIssues.join('、')}，请检查旧文件。</span>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <FileButton
                active={selected?.kind === 'agents'}
                icon={<FileText size={14} />}
                label="AGENTS.md"
                meta="DutyDeck 工作区项目指令"
                onClick={() => void openAgents()}
                onReveal={() => window.electronAPI.showItemInFolder(summary.agentsMd.path, { workspaceSlug })}
              />
              <div className="mt-3 px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                长期记忆
              </div>
              <div className="space-y-0.5">
                {visibleAutoFiles.length === 0 ? (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的记忆文件</div>
                ) : (
                  visibleAutoFiles.map((file) => (
                    <FileButton
                      key={file.relativePath}
                      active={selected?.kind === 'auto' && selected.relativePath === file.relativePath}
                      icon={<FileText size={14} />}
                      label={file.name}
                      meta={contentMatches.get(file.relativePath) ?? `${file.relativePath}${file.size === undefined ? '' : ` · ${formatBytes(file.size)}`}`}
                      onClick={() => void openAutoFile(file.relativePath)}
                      onReveal={() => window.electronAPI.showItemInFolder(autoMemoryPath(summary, file.relativePath), { workspaceSlug })}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="workspace-memory-detail min-h-0 overflow-hidden rounded-lg border border-border" data-detail-open={showFileDetail}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
              <Button variant="ghost" size="sm" className="workspace-memory-back shrink-0" onClick={() => setShowFileDetail(false)}>返回列表</Button>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">
                  {selected?.title ?? '未选择文件'}
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {selected?.absolutePath ?? '从左侧选择一个记忆文件'}
                </div>
              </div>
            </div>
            {saveConflict && (
              <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <span>文件已被外部更新，已停止保存以避免覆盖。请复制你的修改后刷新文件。</span>
                <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" onClick={() => void refresh()}>刷新文件</Button>
              </div>
            )}
            {loadingFile ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">读取文件中...</div>
            ) : selected ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <LiveMarkdownEditor
                  value={editText}
                  onChange={(value) => {
                    saveStateRef.current = { ...saveStateRef.current, editText: value, isDirty: true }
                    setIsDirty(true)
                    setEditText(value)
                  }}
                  onSave={() => { void flushPendingSave() }}
                  readOnly={saveConflict}
                  className="live-markdown-external-scroll"
                />
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">从左侧选择一个记忆文件</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function FileButton({
  active,
  icon,
  label,
  meta,
  onClick,
  onReveal,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  meta?: string
  onClick: () => void
  onReveal: () => void
}): React.ReactElement {
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
          active ? 'bg-accent text-accent-foreground' : 'text-foreground/80 hover:bg-accent/60',
        )}
      >
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {meta && <span className="block truncate text-[11px] text-muted-foreground" title={meta}>{meta}</span>}
        </span>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onReveal}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={`打开 ${label} 所在位置`}
          >
            <FolderOpen size={13} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">打开文件所在位置</TooltipContent>
      </Tooltip>
    </div>
  )
}
