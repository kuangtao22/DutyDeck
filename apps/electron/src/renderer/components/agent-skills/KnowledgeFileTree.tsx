import type { ReactElement } from 'react'
import { ChevronRight, FileText, Folder } from 'lucide-react'
import type { KnowledgeEntry, KnowledgeOutline, KnowledgeOutlineItem } from '@proma/shared'

/** 文件树仅接收知识正文；读取仍由父级的受控入口执行。 */
interface KnowledgeFileTreeProps {
  entries: KnowledgeEntry[]
  outline?: KnowledgeOutline
  query?: string
  rootRelativePath?: string
  selectedEntryId: string | null
  onSelectEntry: (entry: KnowledgeEntry) => void
}

/** 合并真实条目与未生成大纲后的单个文件节点。 */
interface FileNode {
  key: string
  name: string
  entry?: KnowledgeEntry
  entryId?: string
  status?: KnowledgeOutlineItem['status']
}

/** 文件夹通过 Map 保持构建成本与路径段总数成正比。 */
interface FolderNode {
  folders: Map<string, FolderNode>
  files: FileNode[]
}

/** 创建空文件夹节点，返回可逐级添加文件的容器。 */
function createFolder(): FolderNode {
  return { folders: new Map(), files: [] }
}

/** 将库内相对路径分为层级；库根不同时保留根位置防止同名混淆。 */
function pathParts(relativePath: string, libraryRoot: string | undefined, currentRoot: string | undefined): string[] {
  return (libraryRoot && libraryRoot !== currentRoot ? `${libraryRoot}/${relativePath}` : relativePath).split('/').filter(Boolean)
}

/** 添加一个叶节点；入参路径只用于展示，不作为磁盘读取依据。 */
function addFile(root: FolderNode, parts: string[], file: FileNode): void {
  /** 游标沿文件夹层级移动，避免每次插入重新扫描全部条目。 */
  let folder = root
  for (const part of parts.slice(0, -1)) {
    if (!folder.folders.has(part)) folder.folders.set(part, createFolder())
    folder = folder.folders.get(part)!
  }
  folder.files.push(file)
}

/** 按真实文件位置展示可折叠目录；大纲仅补充尚未生成的计划状态，不绕过宿主目录过滤。 */
export function KnowledgeFileTree({ entries, outline, query = '', rootRelativePath, selectedEntryId, onSelectEntry }: KnowledgeFileTreeProps): ReactElement {
  /** 一次建立身份索引，真实文件位置优先于可能过期的大纲路径。 */
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]))
  /** 状态按稳定身份关联，文件改名或已有实体时也保留未完成提示。 */
  const statusByEntryId = new Map<string, KnowledgeOutlineItem['status']>()
  for (const item of outline?.items ?? []) {
    if (item.entryId) statusByEntryId.set(item.entryId, item.status)
  }
  /** 根节点仅属于本次渲染，不新增持久化状态或扫描。 */
  const root = createFolder()
  for (const entry of entriesById.values()) {
    /** 旧版条目标题整体作为叶名，来源身份不得伪装为文件路径。 */
    const parts = entry.document ? pathParts(entry.document.relativePath, entry.document.rootRelativePath, rootRelativePath) : [entry.title]
    addFile(root, parts, { key: entry.id, name: parts.at(-1) || entry.title, entry, entryId: entry.id, status: statusByEntryId.get(entry.id) })
  }
  if (!query.trim()) {
    for (const item of outline?.items ?? []) {
      // 已生成身份必须由宿主目录提供，避免归档、排除或未加载文件回流。
      if (item.entryId || (item.status !== 'pending' && item.status !== 'missing')) continue
      /** 当前大纲路径相对于已确认库根，直接并入同一层级。 */
      const parts = pathParts(item.relativePath, undefined, rootRelativePath)
      addFile(root, parts, { key: `outline:${item.id}`, name: parts.at(-1) || item.title, entryId: item.entryId, status: item.status })
    }
  }

  /** 递归渲染原生可折叠文件夹和键盘可操作的文件按钮，返回紧凑目录列表。 */
  function renderFolder(folder: FolderNode): ReactElement {
    return (
      <ul className="min-w-0 space-y-0.5">
        {[...folder.folders].map(([name, child]) => (
          <li key={`folder:${name}`}>
            <details open className="[&[open]>summary>svg:first-child]:rotate-90">
              <summary className="flex h-[30px] cursor-pointer list-none items-center gap-1.5 rounded px-2 text-xs text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3 shrink-0 transition-transform" aria-hidden="true" />
                <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate" title={name}>{name}</span>
              </summary>
              <div className="ml-3 border-l border-border/50 pl-1">{renderFolder(child)}</div>
            </details>
          </li>
        ))}
        {folder.files.map((file) => {
          /** 只有宿主返回的实体条目才能提供正文入口。 */
          const readable = Boolean(file.entry)
          /** 等待生成与依据缺失以状态行展示，不制造虚假正文按钮。 */
          const statusLabel = file.status === 'pending' ? '等待生成' : file.status === 'missing' ? '缺少依据' : file.status === 'partial' ? '部分完成' : undefined
          /** 状态点以颜色辅助辨认，悬浮与无障碍名称提供完整含义。 */
          const statusColor = file.status === 'partial' ? 'bg-amber-500' : file.status === 'missing' ? 'bg-destructive' : 'bg-muted-foreground/50'
          /** 文件名占据行内剩余空间，状态点不挤占窄目录的阅读宽度。 */
          const content = <><FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{file.name}</span>{statusLabel && <span role="img" title={statusLabel} aria-label={statusLabel} className={`size-1.5 shrink-0 rounded-full ${statusColor}`} />}</>
          return <li key={file.key}>{readable ? (
            <button type="button" title={file.name} aria-label={`打开${file.name}`} aria-current={selectedEntryId === file.entryId ? 'page' : undefined} className={`flex h-[30px] w-full items-center gap-1.5 rounded px-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedEntryId === file.entryId ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'}`} onClick={() => { if (file.entry) onSelectEntry(file.entry) }}>{content}</button>
          ) : <div title={file.name} className="flex min-h-[30px] items-center gap-1.5 px-2 text-xs text-muted-foreground">{content}</div>}</li>
        })}
      </ul>
    )
  }

  return <nav aria-label="知识库文件目录" className="min-w-0 p-2">{renderFolder(root)}</nav>
}
