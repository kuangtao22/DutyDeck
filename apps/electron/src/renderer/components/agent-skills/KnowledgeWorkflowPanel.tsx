import * as React from 'react'
import { Check, FileText, Folder, Loader2, Pause, Play, Send } from 'lucide-react'
import type { KnowledgeEntry, KnowledgePlan, KnowledgePlanSource, KnowledgeWorkflow } from '@proma/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

/** 用户确认后提交的最小分组身份和名称。 */
export interface KnowledgePlanSelection {
  id: string
  title: string
}

/** 工作流面板属性；文件读取仍复用知识目录的受控入口。 */
export interface KnowledgeWorkflowPanelProps {
  workflow: KnowledgeWorkflow
  entries: KnowledgeEntry[]
  pendingAction: string | null
  error: string | null
  onConfirm: (groups: KnowledgePlanSelection[]) => void
  onPause: (paused: boolean) => void
  onSelectEntryId: (entryId: string, expectedRevision?: string) => void
  onRequestAdjustment: (instruction: string) => void
}

/** 当前提案的编辑草稿，由弹窗外的所有者保存，关闭弹窗不会丢失未提交修改。 */
interface KnowledgePlanDraft {
  selectedIds: Set<string>
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>
  titles: Record<string, string>
  setTitles: React.Dispatch<React.SetStateAction<Record<string, string>>>
  adjustment: string
  setAdjustment: React.Dispatch<React.SetStateAction<string>>
}

/** 以提案身份和版本作为重置边界；普通工作流刷新和弹窗开关不重置草稿。 */
function useKnowledgePlanDraft(proposal: KnowledgePlan | undefined): KnowledgePlanDraft {
  /** 当前 proposal 的默认选择是全部分组，用户可部分取消。 */
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set(proposal?.groups.map((group) => group.id) ?? []))
  /** 分组名称保持本地草稿，确认成功前不修改权威计划。 */
  const [titles, setTitles] = React.useState<Record<string, string>>(() => Object.fromEntries(proposal?.groups.map((group) => [group.id, group.title]) ?? []))
  /** 调整说明只在当前 proposal 版本内有效，重新提案后清空。 */
  const [adjustment, setAdjustment] = React.useState('')

  React.useEffect(() => {
    setSelectedIds(new Set(proposal?.groups.map((group) => group.id) ?? []))
    setTitles(Object.fromEntries(proposal?.groups.map((group) => [group.id, group.title]) ?? []))
    setAdjustment('')
  }, [proposal?.id, proposal?.revision])

  return { selectedIds, setSelectedIds, titles, setTitles, adjustment, setAdjustment }
}

/** 整理流程放入独立弹窗，主页面只保留入口，不占据文件树与正文的阅读空间。 */
export function KnowledgeWorkflowDialog(props: KnowledgeWorkflowPanelProps): React.ReactElement | null {
  /** 所有者持续挂载，Radix 卸载弹窗正文时保留草稿。 */
  const draft = useKnowledgePlanDraft(props.workflow.proposal)
  /** 每份新提案自动提示一次；关闭仅收起弹窗，不确认或暂停生成。 */
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    if (props.workflow.proposal) setOpen(true)
  }, [props.workflow.proposal?.id, props.workflow.proposal?.revision])

  if (!props.workflow.proposal && !props.workflow.approved) return null
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          {props.workflow.proposal ? '确认分组' : props.workflow.paused ? '整理已暂停' : '整理进度'}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border px-5 pb-3 pt-5 pr-12">
          <DialogTitle>{props.workflow.proposal ? '确认知识库范围' : '知识库整理进度'}</DialogTitle>
          <DialogDescription>确认整理范围、查看生成进度；已保存的文档可随时回到目录阅读。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto scrollbar-thin">
          <KnowledgeWorkflowPanelView {...props} draft={draft} onSelectEntryId={(entryId, revision) => {
            props.onSelectEntryId(entryId, revision)
            setOpen(false)
          }} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 根据宿主目录和显式读取事实生成来源展示，绝不从 proposal 文案猜测覆盖率。 */
function describePlanSource(source: KnowledgePlanSource, entries: KnowledgeEntry[]): { label: string; status: string } {
  const entry = entries.find((candidate) => candidate.id === source.entryId)
  const location = source.relativePath ?? entry?.source.relativePath ?? entry?.source.id ?? source.entryId
  const title = source.title ?? entry?.title
  const label = title ? `${title} · ${location}` : location
  if (entry?.metadataOnly || source.coverage === 'unsupported') return { label, status: '暂不支持' }
  if (source.coverage === 'read') return { label, status: '已读相关页' }
  return { label, status: '未核对' }
}

/** 根据用户勾选与编辑结果构造确认载荷，不增加 proposal 中不存在的分组。 */
export function buildKnowledgePlanSelection(
  proposal: KnowledgePlan,
  selectedIds: ReadonlySet<string>,
  titles: Readonly<Record<string, string>>,
): KnowledgePlanSelection[] {
  return proposal.groups.flatMap((group) => {
    if (!selectedIds.has(group.id)) return []
    const title = (titles[group.id] ?? group.title).trim()
    return title ? [{ id: group.id, title }] : []
  })
}

/** 返回大纲路径的父文件夹；根目录文件归入“根目录”。 */
function outlineFolder(relativePath: string): string {
  const segments = relativePath.split('/').filter(Boolean)
  return segments.length > 1 ? segments.slice(0, -1).join('/') : '根目录'
}

/** 独立面板也使用相同草稿生命周期；弹窗版本由外层所有者保存草稿。 */
export function KnowledgeWorkflowPanel(props: KnowledgeWorkflowPanelProps): React.ReactElement {
  /** 独立嵌入时由面板本身持有编辑草稿。 */
  const draft = useKnowledgePlanDraft(props.workflow.proposal)
  return <KnowledgeWorkflowPanelView {...props} draft={draft} />
}

/** 受控视图只渲染草稿，不因弹窗正文重新挂载而初始化编辑内容。 */
interface KnowledgeWorkflowPanelViewProps extends KnowledgeWorkflowPanelProps {
  draft: KnowledgePlanDraft
}

/** 展示待确认分组、已确认大纲和暂停状态，不为未生成文件制造链接。 */
function KnowledgeWorkflowPanelView({
  workflow,
  entries,
  pendingAction,
  error,
  onConfirm,
  onPause,
  onSelectEntryId,
  onRequestAdjustment,
  draft,
}: KnowledgeWorkflowPanelViewProps): React.ReactElement {
  const proposal = workflow.proposal
  /** 使用所有者提供的草稿与更新入口，不在可卸载正文中另建编辑状态。 */
  const { selectedIds, setSelectedIds, titles, setTitles, adjustment, setAdjustment } = draft

  /** 按文件夹聚合大纲，保持 Agent 规划的自由目录结构。 */
  const outlineGroups = React.useMemo(() => {
    const groups = new Map<string, NonNullable<KnowledgeWorkflow['outline']>['items']>()
    for (const item of workflow.outline?.items ?? []) {
      const folder = outlineFolder(item.relativePath)
      groups.set(folder, [...(groups.get(folder) ?? []), item])
    }
    return [...groups.entries()]
  }, [workflow.outline])
  const selectedGroups = proposal ? buildKnowledgePlanSelection(proposal, selectedIds, titles) : []
  const busy = pendingAction !== null
  /** 汇总已确认大纲状态，说明当前生成进度。 */
  const outlineStatus = React.useMemo(() => {
    const items = workflow.outline?.items ?? []
    return {
      total: items.length,
      ready: items.filter((item) => item.status === 'ready').length,
      partial: items.filter((item) => item.status === 'partial').length,
      pending: items.filter((item) => item.status === 'pending').length,
      missing: items.filter((item) => item.status === 'missing').length,
    }
  }, [workflow.outline])

  return (
    <section className="space-y-3 border-b border-border bg-muted/10 px-3 py-3" aria-label="知识库生成流程">
      {proposal && (
        <div className="space-y-3 rounded-md border border-border bg-background p-3">
          <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs leading-5">
            <p className="font-medium text-foreground">这是一份待确认的整理计划，还不是最终知识库内容</p>
            <p className="mt-1 text-muted-foreground">
              Agent 先根据项目资料提出分组。请勾选要保留的分组，也可以改名；点击“确认所选范围”后，才会继续生成大纲和 Markdown 正文。
            </p>
            <p className="mt-1 text-muted-foreground">
              “已读相关页”表示已读取该来源的相关内容；“未核对”表示只登记了来源，尚未读取正文；“缺口”表示当前依据不足，后续仍需补充。
            </p>
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-foreground">确认知识库范围</h3>
            <p className="text-xs text-muted-foreground">{proposal.title} · 拟使用目录 {proposal.rootRelativePath}</p>
          </div>
          <div className="space-y-2">
            {proposal.groups.map((group) => {
              const checked = selectedIds.has(group.id)
              return (
                <div key={group.id} className="space-y-2 rounded-md border border-border/70 p-2.5">
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-2 size-3.5 accent-primary"
                      checked={checked}
                      aria-label={`选择分组 ${group.title}`}
                      disabled={busy}
                      onChange={(event) => {
                        setSelectedIds((current) => {
                          const next = new Set(current)
                          if (event.target.checked) next.add(group.id)
                          else next.delete(group.id)
                          return next
                        })
                      }}
                    />
                    <Input
                      value={titles[group.id] ?? group.title}
                      aria-label={`分组名称 ${group.title}`}
                      disabled={busy || !checked}
                      onChange={(event) => setTitles((current) => ({ ...current, [group.id]: event.target.value }))}
                    />
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">{group.summary}</p>
                  {group.sources.length > 0 && (
                    <div className="space-y-1" aria-label={`${group.title} 来源`}>
                      {group.sources.map((source) => {
                        const description = describePlanSource(source, entries)
                        return <p key={`${source.entryId}:${source.revision}`} className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"><span className="break-all">{description.label}</span><Badge variant="outline">{description.status}</Badge></p>
                      })}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                    <Badge variant="secondary">来源 {group.sources.length} 个</Badge>
                    {group.gaps.map((gap, index) => <Badge key={`${index}:${gap}`} variant="outline">缺口：{gap}</Badge>)}
                    {group.outputs.map((output, index) => <Badge key={`${index}:${output}`} variant="outline">产出：{output}</Badge>)}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="space-y-2">
            <label className="block text-xs font-medium text-foreground" htmlFor="knowledge-plan-adjustment">调整清单</label>
            <textarea id="knowledge-plan-adjustment" value={adjustment} disabled={busy} rows={3} maxLength={2000} placeholder="例如：合并两个分组、调整顺序或修改知识库根目录" onChange={(event) => setAdjustment(event.target.value)} className="flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50" />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy || !adjustment.trim()} onClick={() => onRequestAdjustment(adjustment.trim())}>
                {pendingAction === 'adjust-plan' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
                提交调整
              </Button>
              <Button type="button" size="sm" disabled={busy || selectedGroups.length === 0} onClick={() => onConfirm(selectedGroups)}>
                {pendingAction === 'confirm-plan' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
                确认所选范围
              </Button>
            </div>
          </div>
        </div>
      )}

      {workflow.approved && (
        <div className="space-y-2 rounded-md border border-border bg-background p-3" data-testid="knowledge-approved-outline">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-foreground">知识库大纲</h3>
              <p className="truncate text-xs text-muted-foreground">{workflow.approved.rootRelativePath} · 已确认 {workflow.approved.groups.length} 个分组</p>
              {workflow.outline && (
                <p className="mt-1 text-xs text-muted-foreground">
                  共 {outlineStatus.total} 项
                  {outlineStatus.ready > 0 && ` · ${outlineStatus.ready} 项已生成`}
                  {outlineStatus.partial > 0 && ` · ${outlineStatus.partial} 项部分完成`}
                  {outlineStatus.pending > 0 && ` · ${outlineStatus.pending} 项等待生成`}
                  {outlineStatus.missing > 0 && ` · ${outlineStatus.missing} 项缺少依据`}
                </p>
              )}
            </div>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onPause(!workflow.paused)}>
              {pendingAction === 'pause-workflow' ? <Loader2 className="animate-spin" aria-hidden="true" /> : workflow.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
              {workflow.paused ? '继续生成' : '暂停生成'}
            </Button>
          </div>
          {workflow.paused && <p className="text-xs text-amber-600 dark:text-amber-400">生成已暂停；已写入文件仍可阅读，后续 Agent 发布会被拒绝。</p>}
          {!workflow.outline ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">正在等待 Agent 保存大纲。</p>
          ) : (
              <div className="space-y-3 border-t border-border/70 px-3 py-3">
                {outlineGroups.map(([folder, items]) => (
                  <div key={folder} className="space-y-1">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-foreground"><Folder className="size-3.5" aria-hidden="true" />{folder}</div>
                    <div className="space-y-1 pl-5">
                      {items.map((item) => {
                        const entry = item.entryId ? entries.find((candidate) => candidate.id === item.entryId) : undefined
                        const readable = Boolean(item.entryId) && (item.status === 'ready' || item.status === 'partial')
                        const statusLabel = item.status === 'ready' ? '已生成' : item.status === 'partial' ? '部分完成' : item.status === 'missing' ? '缺少依据' : '等待生成'
                        return readable && item.entryId ? (
                          <button key={item.id} type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`打开${item.title}`} onClick={() => onSelectEntryId(item.entryId!, entry?.revision)}>
                            <FileText className="size-3.5 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{item.title}</span><Badge variant={item.status === 'ready' ? 'secondary' : 'outline'}>{statusLabel}</Badge>
                          </button>
                        ) : (
                          <div key={item.id} className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                            <FileText className="size-3.5 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{item.title}</span><Badge variant="outline">{statusLabel}</Badge>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </section>
  )
}
