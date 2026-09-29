/**
 * TurnFileChangesSummary — Turn 底部文件改动汇总
 *
 * 在 AssistantTurnRenderer 的 MessageActions 之上，按业务分类逐行展示本轮真实改动文件，
 * 优先使用持久化的本轮净变化统计，并兼容只有路径证据的旧会话。
 * 路径由两部分合并而来：
 * 1. 修改类工具调用（Edit / Write / MultiEdit / NotebookEdit）成功返回后的入参路径；
 * 2. 主进程文件监听器归属到本轮运行的真实落盘路径 —— 覆盖 Bash、脚本、格式化器、
 *    构建工具等非写类工具产生的改动。
 *
 * 子代理（Agent/Task）的修改也会冒泡到此处——因为 SDK 的子代理 assistant
 * 消息同样存在于 turn.turnMessages 中（通过 parent_tool_use_id 关联）。
 *
 * 未删除文件继续复用 FilePathChip 打开当前工作区预览；历史轮次只展示持久化数字，
 * 不把当前 Git diff 冒充历史差异。
 *
 * 空态的边界：两条证据源都只覆盖「受管根 + 附加目录 + 项目根」与写类工具入参，
 * 命令行工具在工作区外写的文件既不在监听范围也不会留下写类工具入参，因此空态只能
 * 说明「受管范围内没看到改动」，不能断言本轮没有任何改动。
 */

import * as React from 'react'
import type {
  AgentRunFileChange,
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKToolUseBlock,
  SDKToolResultBlock,
} from '@proma/shared'
import { ChevronDown, FileX2 } from 'lucide-react'
import { FilePathChip } from '@/components/ai-elements/file-path-chip'
import { groupAgentFileChangesByCategory, mergeTurnFilePaths } from '@/lib/agent-run-file-changes'

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** 命令行工具：它们的写入只体现在文件系统上，可能落在受监听范围之外。 */
const SHELL_TOOL_NAMES = new Set(['Bash', 'Shell'])
const DEFAULT_VISIBLE_FILE_COUNT = 8

/**
 * 本轮"触碰过"的工具集合（改 + 读）——用于正文内联文件引用的路径补全，比 MUTATING_TOOLS 更宽。
 * Read 的 input.file_path 与 Edit/Write 同构，都是绝对路径，可零解析纳入映射。
 * Grep/Glob 的 input 只有 pattern、命中文件仅存在于 tool_result 中，暂不纳入。
 * 注意：底部"文件改动汇总"chip 仍只用 MUTATING_TOOLS，不受此集合影响。
 */
const TOUCHED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'])

function getFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'NotebookEdit') {
    const fp = input.notebook_path
    return typeof fp === 'string' ? fp : null
  }
  const fp = input.file_path ?? input.filePath ?? input.path
  return typeof fp === 'string' ? fp : null
}

/**
 * 收集本轮可展示的文件改动路径。
 *
 * 入参 `turnMessages`：本轮全部 SDK 消息；`tools`：视为改动来源的工具集合。
 * 返回值：按出现顺序去重的文件路径。只有已返回且未报错的工具调用才算证据，
 * 流式过程中尚未返回的 tool_use 不能提前渲染为可点击 Chip。
 */
export function collectFilePaths(turnMessages: SDKMessage[], tools: Set<string> = MUTATING_TOOLS): string[] {
  const succeeded = new Set<string>()
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const blocks = (msg as SDKUserMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      const rb = block as SDKToolResultBlock
      if (rb.is_error !== true) succeeded.add(rb.tool_use_id)
    }
  }

  const seen = new Set<string>()
  const paths: string[] = []
  for (const msg of turnMessages) {
    if (msg.type !== 'assistant') continue
    const blocks = (msg as SDKAssistantMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const tu = block as SDKToolUseBlock
      if (!tools.has(tu.name)) continue
      if (!succeeded.has(tu.id)) continue

      const filePath = getFilePath(tu.name, tu.input as Record<string, unknown>)
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      paths.push(filePath)
    }
  }
  return paths
}

/**
 * 判断本轮是否调用过命令行工具。
 *
 * 命令行可以在监听范围之外写文件，且不会产生写类工具入参（例如 `python3 - <<PY ...` 直接改写
 * 外部仓库的源码），所以这种轮次的空态必须带上范围限定，避免把「没看到」说成「没有改动」。
 *
 * @param turnMessages 本轮全部 SDK 消息。
 * @returns 出现过命令行工具调用时为 true。
 */
export function hasShellToolCall(turnMessages: SDKMessage[]): boolean {
  for (const msg of turnMessages) {
    if (msg.type !== 'assistant') continue
    const blocks = (msg as SDKAssistantMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      if (SHELL_TOOL_NAMES.has((block as SDKToolUseBlock).name)) return true
    }
  }
  return false
}

/**
 * 构建「文件名 → 绝对路径」映射，供消息正文内联文件引用补全裸文件名使用。
 * 数据源为本轮"触碰过"的文件（TOUCHED_TOOLS：改过 + Read 读过），比底部改动汇总更宽，
 * 覆盖"本轮只读过没改就在正文引用"的高频场景；拿到的都是绝对路径。
 * 同名不同目录的文件无法凭裸文件名区分，直接从映射中剔除，交由既有 basePaths 解析逻辑处理
 * （不比补全前更差）。
 */
export function buildTurnFileNameMap(
  turnMessages: SDKMessage[],
  extraPaths: readonly string[] = [],
): Map<string, string> {
  // 真实落盘路径同样参与补全：脚本/格式化器生成的文件也应能从裸文件名解析到绝对路径。
  const paths = mergeTurnFilePaths(collectFilePaths(turnMessages, TOUCHED_TOOLS), extraPaths)
  const map = new Map<string, string>()
  const conflicted = new Set<string>()
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop() || p
    if (conflicted.has(name)) continue
    const existing = map.get(name)
    if (existing && existing !== p) {
      map.delete(name)
      conflicted.add(name)
      continue
    }
    map.set(name, p)
  }
  return map
}

export interface TurnFileChangesSummaryProps {
  turnMessages: SDKMessage[]
  basePath?: string
  /** 文件监听器归属到本轮运行的真实落盘路径，用于补齐非工具写入。 */
  runPaths?: readonly string[]
  /** 本轮已持久化的文件净变化与行数统计；旧会话缺失时保留路径并显示未知统计。 */
  runFiles?: readonly AgentRunFileChange[]
  /** 是否从本轮开始前就已在跟踪；仅 true 时才允许断言「本轮无文件改动」。 */
  runObserved?: boolean
  /** 本轮是否存在「看到改动但无法归属到本会话」的共享根事件。 */
  runUnattributed?: boolean
  /** 是否按大小写不敏感比较路径（Windows 为 true）。 */
  caseInsensitivePaths?: boolean
}

/** 生成跨平台路径比较键，Windows 下按大小写不敏感处理。 */
function filePathKey(filePath: string, caseInsensitive: boolean, basePath?: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const isAbsolute = normalized.startsWith('/') || normalized.startsWith('//') || /^[a-zA-Z]:\//.test(normalized)
  const joined = !isAbsolute && basePath
    ? `${basePath.replace(/\\/g, '/').replace(/\/$/, '')}/${normalized}`
    : normalized
  const prefix = joined.startsWith('/') ? '/' : ''
  const segments: string[] = []
  for (const segment of joined.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') segments.pop()
    else if (segment !== '..' || !prefix) segments.push(segment)
  }
  const resolved = `${prefix}${segments.join('/')}`
  return caseInsensitive ? resolved.toLowerCase() : resolved
}

/** 返回文件名，用于检测同名文件并补充父目录。 */
function getDisplayFileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath
}

/** 同名文件仅展示必要的父目录线索，避免长绝对路径挤占统计区域。 */
function getDisplayParentPath(filePath: string, basePath?: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/$/, '')
  const parent = normalized.slice(0, Math.max(0, normalized.lastIndexOf('/')))
  const normalizedBase = basePath?.replace(/\\/g, '/').replace(/\/$/, '')
  if (normalizedBase && parent.startsWith(`${normalizedBase}/`)) return parent.slice(normalizedBase.length + 1)
  const segments = parent.split('/').filter(Boolean)
  return segments.slice(-2).join('/')
}

/** 将路径证据与持久化统计合并；unchanged 是权威结果，会剔除旧工具路径。 */
function buildVisibleFileChanges(options: {
  toolPaths: readonly string[]
  runPaths: readonly string[]
  runFiles: readonly AgentRunFileChange[]
  caseInsensitive: boolean
  basePath?: string
}): AgentRunFileChange[] {
  const byPath = new Map<string, AgentRunFileChange>()
  for (const file of options.runFiles) {
    byPath.set(filePathKey(file.path, options.caseInsensitive, options.basePath), file)
  }
  const changes: AgentRunFileChange[] = []
  const seen = new Set<string>()
  for (const path of [...options.toolPaths, ...options.runPaths, ...options.runFiles.map(file => file.path)]) {
    const key = filePathKey(path, options.caseInsensitive, options.basePath)
    if (seen.has(key)) continue
    seen.add(key)
    const runFile = byPath.get(key)
    if (runFile?.status === 'unchanged') continue
    changes.push(runFile ?? { path, status: 'unknown', statsState: 'unavailable' })
  }
  return changes
}

/** 返回无法精确统计时面向用户的简短原因。 */
function getStatsStateLabel(state: AgentRunFileChange['statsState']): string {
  switch (state) {
    case 'binary': return '二进制文件，暂无行数统计'
    case 'too_large': return '文件过大，暂无行数统计'
    case 'external_change': return '混有外部修改，暂无可靠行数统计'
    case 'budget_exceeded': return '变化较大，暂无行数统计'
    case 'unavailable': return '暂无行数统计'
    case 'complete': return ''
  }
}

interface StructuredFileRowProps {
  file: AgentRunFileChange
  basePath?: string
  showParent: boolean
}

/** 渲染单个文件变化；删除文件只展示状态，不提供已经失效的打开入口。 */
function StructuredFileRow({ file, basePath, showParent }: StructuredFileRowProps): React.ReactElement {
  const fileName = getDisplayFileName(file.path)
  const parentPath = showParent ? getDisplayParentPath(file.path, basePath) : ''
  const isComplete = file.statsState === 'complete'
  return (
    <div className="grid min-h-8 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border/50 px-2 py-1.5 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        {file.status === 'deleted' ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={file.path}>
            <FileX2 className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate font-medium text-foreground/80">{fileName}</span>
          </span>
        ) : (
          <span className="min-w-0" title="文件预览基于当前工作区">
            <FilePathChip
              filePath={file.path}
              basePath={basePath}
              openMode="diff-preferred"
              className="max-w-full bg-transparent px-0 text-foreground/80 hover:bg-muted/50"
            />
          </span>
        )}
        {parentPath && <span className="truncate text-[11px] text-muted-foreground/65" title={file.path}>{parentPath}</span>}
        {file.status === 'added' && <span className="shrink-0 text-[11px] text-muted-foreground">新增</span>}
        {file.status === 'deleted' && <span className="shrink-0 text-[11px] text-muted-foreground">已删除</span>}
      </div>
      {isComplete ? (
        <div className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums" aria-label={`新增 ${file.additions ?? 0} 行，删除 ${file.deletions ?? 0} 行`}>
          <span className="text-emerald-600 dark:text-emerald-400">+{file.additions ?? 0}</span>
          <span className="text-red-600 dark:text-red-400">−{file.deletions ?? 0}</span>
        </div>
      ) : (
        <span className="max-w-44 text-right text-[11px] leading-4 text-muted-foreground">
          {getStatsStateLabel(file.statsState)}
        </span>
      )}
    </div>
  )
}

export function TurnFileChangesSummary({
  turnMessages,
  basePath,
  runPaths,
  runFiles,
  runObserved,
  runUnattributed,
  caseInsensitivePaths,
}: TurnFileChangesSummaryProps): React.ReactElement | null {
  const [showAll, setShowAll] = React.useState(false)
  const summaryId = React.useId()
  const fileGroupsId = `${summaryId}-file-groups`
  const changes = React.useMemo(() => buildVisibleFileChanges({
    toolPaths: collectFilePaths(turnMessages),
    runPaths: runPaths ?? [],
    runFiles: runFiles ?? [],
    caseInsensitive: caseInsensitivePaths === true,
    basePath,
  }), [turnMessages, runPaths, runFiles, caseInsensitivePaths, basePath])
  const paths = React.useMemo(() => changes.map(file => file.path), [changes])

  const groups = React.useMemo(() => groupAgentFileChangesByCategory(paths), [paths])
  const categorizedPaths = React.useMemo(() => groups.flatMap(group => group.paths), [groups])
  const changesByPath = React.useMemo(() => new Map(changes.map(file => [
    filePathKey(file.path, caseInsensitivePaths === true, basePath),
    file,
  ])), [changes, caseInsensitivePaths, basePath])
  const duplicateFileNames = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const file of changes) {
      const name = getDisplayFileName(file.path).toLowerCase()
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name))
  }, [changes])
  const visiblePathKeys = React.useMemo(() => new Set(
    (showAll ? categorizedPaths : categorizedPaths.slice(0, DEFAULT_VISIBLE_FILE_COUNT))
      .map(path => filePathKey(path, caseInsensitivePaths === true, basePath)),
  ), [showAll, categorizedPaths, caseInsensitivePaths, basePath])
  const completeChanges = changes.filter(file => file.statsState === 'complete')
  const totalAdditions = completeChanges.reduce((sum, file) => sum + (file.additions ?? 0), 0)
  const totalDeletions = completeChanges.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  const hasIncompleteStats = completeChanges.length !== changes.length || runUnattributed === true

  // 命令行轮次的空态需要额外说明范围：受监听目录之外的写入不会出现在这里。
  const shellToolUsed = React.useMemo(() => hasShellToolCall(turnMessages), [turnMessages])

  // 无路径且无法确认本轮已被完整跟踪时保持静默：历史上早于本次运行的 turn 无从判断，
  // 强行显示「无改动」会把遗漏写成结论。
  if (paths.length === 0 && runObserved !== true && runUnattributed !== true) return null

  return (
    <div className="pl-[46px] mt-3">
      <div className="pt-3 border-t-2 border-dashed border-border/60">
        <div className="flex flex-wrap items-center gap-1.5">
          {paths.length === 0 ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">
                {runUnattributed === true
                  ? '本轮检测到共享目录有改动，但无法归属到本会话'
                  : '本轮未检测到受管范围内的文件改动'}
              </span>
              {/* 共享目录无法归属已经解释了「没看到」的原因，不再叠加命令行范围说明。 */}
              {runUnattributed !== true && shellToolUsed && (
                <span className="text-xs text-muted-foreground/70">
                  本轮有命令行工具调用，工作区外的写入不计入这里
                </span>
              )}
              {runUnattributed === true && (
                <span className="text-xs text-muted-foreground/70">另有改动未计入统计</span>
              )}
            </div>
          ) : (
            <div className="w-full min-w-0">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-xs font-medium text-foreground/80">本轮文件改动 {paths.length}</span>
                <div className="flex items-center gap-2 text-xs">
                  {completeChanges.length > 0 ? (
                    <>
                      <span className="font-mono tabular-nums text-emerald-600 dark:text-emerald-400">+{totalAdditions}</span>
                      <span className="font-mono tabular-nums text-red-600 dark:text-red-400">−{totalDeletions}</span>
                      {hasIncompleteStats && <span className="text-[11px] text-muted-foreground">已统计部分文件</span>}
                    </>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">暂无行数统计</span>
                  )}
                </div>
              </div>
              <div id={fileGroupsId}>
                {groups.map((group) => (
                  group.paths.some(path => visiblePathKeys.has(filePathKey(path, caseInsensitivePaths === true, basePath))) && (
                    <section
                      key={group.category}
                      className="mb-2 last:mb-0"
                      aria-labelledby={`${summaryId}-${group.category}-label`}
                    >
                      <div id={`${summaryId}-${group.category}-label`} className="mb-1 text-[11px] font-medium text-muted-foreground">
                        {group.label} {group.paths.length}
                      </div>
                      <div className="overflow-hidden rounded-md border border-border/60 bg-muted/10">
                        {group.paths.map((filePath) => {
                          const key = filePathKey(filePath, caseInsensitivePaths === true, basePath)
                          const file = changesByPath.get(key)
                          if (!file || !visiblePathKeys.has(key)) return null
                          return (
                            <StructuredFileRow
                              key={key}
                              file={file}
                              basePath={basePath}
                              showParent={duplicateFileNames.has(getDisplayFileName(file.path).toLowerCase())}
                            />
                          )
                        })}
                      </div>
                    </section>
                  )
                ))}
              </div>
              {paths.length > DEFAULT_VISIBLE_FILE_COUNT && (
                <button
                  type="button"
                  aria-expanded={showAll}
                  aria-controls={fileGroupsId}
                  onClick={() => setShowAll(current => !current)}
                  className="mt-1 inline-flex items-center gap-1 rounded-sm px-1 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <ChevronDown className={`size-3 transition-transform ${showAll ? 'rotate-180' : ''}`} aria-hidden="true" />
                  {showAll ? '收起' : `展开其余 ${paths.length - DEFAULT_VISIBLE_FILE_COUNT} 项`}
                </button>
              )}
              {runUnattributed === true && (
                <div className="mt-1.5 text-[11px] text-muted-foreground">另有改动未计入统计</div>
              )}
              <div className="mt-1.5 text-[10px] text-muted-foreground/60">文件预览基于当前工作区</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
