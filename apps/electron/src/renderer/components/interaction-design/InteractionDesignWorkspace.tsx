import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { Download, Expand, History, ListTree, Monitor, MoreHorizontal, MousePointer2, PanelLeftClose, Play, Plus, RefreshCw, Route, Search, Smartphone, Sparkles, Workflow, X } from 'lucide-react'
import type { PrototypeCandidate, PrototypeDraft, PrototypeFlow, PrototypeProjectInspection, PrototypeSnapshot, PrototypeSummary } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { agentPendingPromptAtom } from '@/atoms/agent-atoms'
import { interactionDesignViewsAtom } from '@/atoms/interaction-design-atoms'
import { buildPrototypePrompt, copyPrototypeDraft, deletePrototypePage, movePrototypePage, PrototypeRequestGate } from './interaction-design-model'
import { InteractionDesignPreview } from './InteractionDesignPreview'
import './interaction-design.css'

/** 正式工作区只依赖经过 shell 验证的项目/会话身份。 */
interface InteractionDesignWorkspaceProps { projectId: string; sessionId: string; paneActive?: boolean }
/** 输入表单冻结目标与基线，目录操作不得跟随稍后选择漂移。 */
interface EditorForm { kind: 'create' | 'page' | 'group' | 'rename-page' | 'rename-group' | 'html' | 'import' | 'asset' | 'reference' | 'element'; elementId?: string; title: string; value: string; targetId?: string; baseRevision?: number; prototypeId?: string }
/** 空素材字典复用，避免每次渲染重建 iframe。 */
const EMPTY_ASSETS: Record<string, string> = {}

/** V3 页面工作台：单页体验、覆盖目录、明确候选和真实主会话引用。 */
export function InteractionDesignWorkspace({ projectId, sessionId, paneActive = true }: InteractionDesignWorkspaceProps): React.ReactElement {
  /** 项目视图偏好与持久化正文分离。 */
  const [views, setViews] = useAtom(interactionDesignViewsAtom)
  const view = views[projectId] ?? { prototypeId: null, pageId: null, device: 'mobile' as const, collapsedGroups: [] }
  const setPrompt = useSetAtom(agentPendingPromptAtom)
  const [summaries, setSummaries] = React.useState<PrototypeSummary[]>([])
  const [snapshot, setSnapshot] = React.useState<PrototypeSnapshot | null>(null)
  const [candidate, setCandidate] = React.useState<PrototypeCandidate | null>(null)
  const [assets, setAssets] = React.useState<Record<string, string>>(EMPTY_ASSETS)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [directory, setDirectory] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [mode, setMode] = React.useState<'play' | 'select'>('play')
  const [selectedElement, setSelectedElement] = React.useState<string | null>(null)
  const [focus, setFocus] = React.useState(false)
  const [reset, setReset] = React.useState(0)
  const [visited, setVisited] = React.useState<string[]>([])
  const [form, setForm] = React.useState<EditorForm | null>(null)
  const [panel, setPanel] = React.useState<'history' | 'flow' | 'project' | null>(null)
  const [flowDraft, setFlowDraft] = React.useState<PrototypeFlow[] | null>(null)
  const [inspection, setInspection] = React.useState<PrototypeProjectInspection | null>(null)
  const [sourcePaths, setSourcePaths] = React.useState<string[]>([])
  const [changed, setChanged] = React.useState(false)
  const gate = React.useRef(new PrototypeRequestGate())
  const listGate = React.useRef(new PrototypeRequestGate())
  const ticket = React.useRef(0)
  const context = `${projectId}:${sessionId}:${view.prototypeId ?? ''}`
  const currentContext = React.useRef(context)
  /** 渲染时立即撤销旧上下文，早于 effect 清理，隔离同帧迟到结果。 */
  if (currentContext.current !== context) { currentContext.current = context; ticket.current = gate.current.next() }
  const latest = React.useRef({ form, flowDraft, busy, snapshot, paneActive })
  latest.current = { form, flowDraft, busy, snapshot, paneActive }
  const document = snapshot?.document
  const draft = candidate?.draft ?? document
  const pageId = draft?.pages.some(page => page.id === view.pageId) ? view.pageId! : draft?.entryPageId ?? ''
  const page = draft?.pages.find(item => item.id === pageId)

  /** 只更新发起项目的轻量偏好。 */
  const updateView = React.useCallback((patch: Partial<typeof view>): void => {
    setViews(previous => ({ ...previous, [projectId]: { prototypeId: null, pageId: null, device: 'mobile', collapsedGroups: [], ...previous[projectId], ...patch } }))
  }, [projectId, setViews])

  /** 已采纳文档切换时清掉候选和体验证据，决不混入表单保存。 */
  const acceptSnapshot = React.useCallback((next: PrototypeSnapshot): void => {
    const previousDocument = latest.current.snapshot?.document
    const sameVersion = previousDocument?.id === next.document.id && previousDocument.revision === next.document.revision
    setSnapshot(sameVersion ? { ...next, document: previousDocument } : next)
    setChanged(false)
    if (sameVersion) setCandidate(previous => previous && next.candidates.some(item => item.id === previous.id && (item.status === 'ready' || item.status === 'stale')) ? previous : null)
    if (!sameVersion) { setCandidate(null); setSelectedElement(null); setVisited([]); setAssets(EMPTY_ASSETS) }
    setSummaries(previous => {
      const summary: PrototypeSummary = { id: next.document.id, name: next.document.name, platform: next.document.platform, revision: next.document.revision, pageCount: next.document.pages.length, updatedAt: next.document.updatedAt }
      return previous.some(item => item.id === summary.id) ? previous.map(item => item.id === summary.id ? summary : item) : [...previous, summary]
    })
  }, [])

  /** 当前文档读取使用独立代次；结果不可覆盖切换后的原型或会话。 */
  const load = React.useCallback(async (): Promise<void> => {
    if (!view.prototypeId) return
    const request = gate.current.next(); ticket.current = request
    setLoading(true); setError(null)
    try {
      const next = await window.electronAPI.interactionDesign.invoke('load', { sessionId, prototypeId: view.prototypeId })
      if (gate.current.accepts(request) && next.document.id === view.prototypeId) acceptSnapshot(next)
    } catch (cause) { if (gate.current.accepts(request)) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (gate.current.accepts(request)) setLoading(false) }
  }, [sessionId, view.prototypeId, acceptSnapshot])

  React.useEffect(() => {
    const request = listGate.current.next()
    setSummaries([]); setSnapshot(null); setCandidate(null); setForm(null); setPanel(null); setFlowDraft(null); setBusy(false); setError(null); setLoading(true)
    void window.electronAPI.interactionDesign.invoke('list', { sessionId }).then(items => {
      if (!listGate.current.accepts(request)) return
      setSummaries(items)
      if (!items.some(item => item.id === view.prototypeId)) updateView({ prototypeId: items[0]?.id ?? null, pageId: null })
      setLoading(false)
    }).catch(cause => { if (listGate.current.accepts(request)) { setError(String(cause)); setLoading(false) } })
    return () => {
      listGate.current.next()
      /** effect 清理会再次使旧请求失效，票据必须同步到第二次代次，避免无原型新建请求拿到过期票据。 */
      ticket.current = gate.current.next()
    }
  }, [projectId, sessionId])

  React.useEffect(() => { setSnapshot(null); setCandidate(null); setForm(null); setPanel(null); setFlowDraft(null); setBusy(false); setSelectedElement(null); setNotice(null); void load() }, [load])

  React.useEffect(() => window.electronAPI.interactionDesign.onChanged(event => {
    if (event.workspaceId !== projectId) return
    /** 只有明确指向当前原型的事件才需要重载正文；项目级或其他原型事件必须刷新目录，否则 Agent 新建的原型不可发现。 */
    const affectsCurrentPrototype = Boolean(event.prototypeId && view.prototypeId && event.prototypeId === view.prototypeId)
    if (affectsCurrentPrototype) {
      /** 当前原型正在编辑时保留用户上下文，只提示外部版本变化。 */
      if ((latest.current.form?.prototypeId || latest.current.flowDraft || latest.current.busy) && latest.current.form?.kind !== 'create') { setChanged(true); return }
      void load()
      return
    }
    /** 其他原型只读取摘要，避免覆盖当前页面、表单或候选预览。 */
    const request = listGate.current.next()
    void window.electronAPI.interactionDesign.invoke('list', { sessionId }).then(items => {
      if (!listGate.current.accepts(request)) return
      setSummaries(items)
      /** 空项目且没有用户输入时自动进入刚创建的原型；有表单时只更新目录，避免丢失输入。 */
      const currentStillExists = view.prototypeId ? items.some(item => item.id === view.prototypeId) : false
      const canSwitch = !latest.current.form && !latest.current.flowDraft && !latest.current.busy
      const externalSummary = event.prototypeId ? items.find(item => item.id === event.prototypeId) : undefined
      /** 当前页面保持不动时给出切换提示，避免新原型只悄悄出现在下拉菜单。 */
      if (externalSummary && currentStillExists) setNotice(`已生成原型“${externalSummary.name}”，可从顶部切换查看候选。`)
      if (!currentStillExists && canSwitch) {
        const preferred = event.prototypeId && items.some(item => item.id === event.prototypeId) ? event.prototypeId : items[0]?.id
        updateView({ prototypeId: preferred ?? null, pageId: null })
      }
    }).catch(cause => { if (listGate.current.accepts(request)) setError(String(cause)) })
  }), [projectId, sessionId, view.prototypeId, load, updateView])

  React.useEffect(() => {
    if (!snapshot) return
    const request = ticket.current
    /** 仅载入当前可见文档引用的图片，预算由主进程控制。 */
    const content = (candidate?.draft ?? snapshot.document).pages.find(item => item.id === pageId)?.html ?? ''
    const used = snapshot.assets.filter(asset => content.includes(`prototype-asset:${asset.id}`))
    if (!used.length) { setAssets(EMPTY_ASSETS); return }
    /** 页面内多张大图也要限制总内存，不能仅靠并发数控制最终常驻体积。 */
    const totalAssetBytes = used.reduce((total, asset) => total + asset.byteSize, 0)
    if (!Number.isFinite(totalAssetBytes) || totalAssetBytes < 0 || totalAssetBytes > 64 * 1024 * 1024) {
      setAssets(EMPTY_ASSETS); setError('当前页图片超过 64 MiB 预览预算，请压缩图片后再预览。'); return
    }
    if (Object.keys(assets).length === used.length && used.every(asset => assets[asset.id])) return
    setAssets(EMPTY_ASSETS)
    let disposed = false
    /** 每批最多四个当前页图片请求；离开页面后不再启动后续批次。 */
    const loadVisibleAssets = async (): Promise<Record<string, string>> => {
      const result: Record<string, string> = {}
      for (let offset = 0; offset < used.length; offset += 4) {
        if (disposed || !gate.current.accepts(request)) return result
        const batch = await Promise.all(used.slice(offset, offset + 4).map(asset => window.electronAPI.interactionDesign.invoke('assetContent', { sessionId, prototypeId: snapshot.document.id, assetId: asset.id })))
        for (const asset of batch) result[asset.assetId] = asset.dataUrl
      }
      return result
    }
    void loadVisibleAssets().then(result => {
      if (!disposed && gate.current.accepts(request)) setAssets(result)
    }).catch(cause => { if (!disposed && gate.current.accepts(request)) setError(`素材加载失败：${String(cause)}`) })
    return () => { disposed = true }
  }, [snapshot, candidate, sessionId, pageId])

  React.useEffect(() => {
    /** Escape 由最内层 Radix 菜单/弹窗先处理，目录与专注依次退出。 */
    const keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !paneActive) return
      if (event.key === 'Escape' && !form && !panel) { if (directory) setDirectory(false); else setFocus(false) }
      if ((event.metaKey || event.ctrlKey) && event.key === 'k' && !form && !panel) { event.preventDefault(); setDirectory(true) }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [directory, focus, form, panel, paneActive])

  /** 所有写入/按需读取冻结请求上下文；失败就地展示，不伪造成功。 */
  async function run<T>(operation: () => Promise<T>, onSuccess?: (value: T) => void): Promise<void> {
    if (latest.current.busy) return
    const request = ticket.current
    latest.current.busy = true
    setBusy(true); setError(null); setNotice(null)
    try { const result = await operation(); if (gate.current.accepts(request)) { latest.current.busy = false; setBusy(false); onSuccess?.(result) } }
    catch (cause) { if (gate.current.accepts(request)) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (gate.current.accepts(request)) { latest.current.busy = false; setBusy(false) } }
  }

  /** 一次用户动作提交一个完整版本，基线在表单打开时冻结。 */
  function save(next: PrototypeDraft, summary: string, baseRevision = document?.revision): void {
    if (!document || baseRevision === undefined) return
    void run(() => window.electronAPI.interactionDesign.invoke('save', { sessionId, prototypeId: document.id, baseRevision, draft: next, summary }), result => { acceptSnapshot(result); setForm(null); setFlowDraft(null); setPanel(null) })
  }

  /** 输入对话框显式记录作用目标；后台版本变化不会切换该目标。 */
  function openForm(kind: EditorForm['kind'], title: string, value = '', targetId?: string): void {
    if (latest.current.busy) return
    /** 每次打开表单都从当前上下文开始，避免上一次表单的冲突提示污染新操作。 */
    setError(null)
    setChanged(false)
    setForm({ kind, title, value, targetId, elementId: kind === 'element' ? selectedElement ?? undefined : undefined, prototypeId: document?.id, baseRevision: document?.revision })
  }

  /** 引用沿用真实主会话，包含固定基线，禁止模拟自动回复。 */
  function reference(instruction: string, elementId?: string, scope: 'page' | 'prototype' = 'page'): void {
    if (!document) return
    setPrompt({ sessionId, message: buildPrototypePrompt(document, elementId ? `${instruction}\n元素身份仅作为页面内定位上下文；以当前页面为修改范围，保留其他元素，候选采纳前核对完整页面。` : instruction, scope === 'page' && document.pages.some(item => item.id === pageId) ? pageId : undefined, scope === 'page' ? elementId : undefined), autoSend: false })
    setNotice('已引用到主会话输入框，请检查后发送。'); setForm(null); setPanel(null); setFocus(false)
  }

  /** 表单提交统一经过当前文档身份和基线复核。 */
  function submitForm(): void {
    if (!form || !form.value.trim()) return
    const value = form.value.trim()
    if (form.kind === 'create') {
      void run(() => window.electronAPI.interactionDesign.invoke('create', { sessionId, name: value, platform: view.device }), result => {
        /** 创建成功会切换原型上下文，先释放当前操作锁，避免代次切换跳过通用 run 的清理。 */
        latest.current.busy = false
        setBusy(false)
        acceptSnapshot(result)
        updateView({ prototypeId: result.document.id, pageId: result.document.entryPageId })
        setForm(null)
      })
      return
    }
    if (form.kind === 'page' && !document) {
      void run(() => window.electronAPI.interactionDesign.invoke('create', { sessionId, name: value, pageName: value, platform: view.device }), result => {
        /** 空项目首次新建页面时由服务端一次性创建隐藏空间和首个页面。 */
        latest.current.busy = false
        setBusy(false)
        acceptSnapshot(result)
        updateView({ prototypeId: result.document.id, pageId: result.document.entryPageId })
        setForm(null)
      })
      return
    }
    if (!document || document.id !== form.prototypeId || document.revision !== form.baseRevision) { setError('设计基线已变化，请关闭表单并重新加载后操作。'); return }
    if (form.kind === 'reference') { reference(value, selectedElement ?? undefined); return }
    if (form.kind === 'import') {
      void run(() => window.electronAPI.interactionDesign.invoke('importHtml', { sessionId, prototypeId: document.id, baseRevision: document.revision, relativePath: value }), () => { setForm(null); void load(); setNotice('HTML 已导入为候选，请预览后采纳。') }); return
    }
    if (form.kind === 'asset') {
      void run(() => window.electronAPI.interactionDesign.invoke('importAsset', { sessionId, prototypeId: document.id, relativePath: value }), asset => { setForm(null); setNotice(`素材已导入：prototype-asset:${asset.id}`); void load() }); return
    }
    const next = copyPrototypeDraft(document)
    if (form.kind === 'element') {
      const target = next.pages.find(item => item.id === form.targetId)
      if (!target || !form.elementId) { setError('选中元素已失效'); return }
      const parsed = new DOMParser().parseFromString(target.html, 'text/html')
      const elements = [...parsed.querySelectorAll('[data-prototype-element]')].filter(item => item.getAttribute('data-prototype-element') === form.elementId)
      const element = elements[0]
      if (elements.length !== 1 || !element || element.childElementCount > 0 || /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META)$/.test(element.tagName)) { setError('该元素不是唯一的纯文本字段，请引用到会话修改结构。'); return }
      element.textContent = form.value
      target.html = '<!doctype html>\n' + parsed.documentElement.outerHTML
    }
    if (form.kind === 'group') next.groups.push({ id: crypto.randomUUID(), name: value })
    if (form.kind === 'rename-group') { const group = next.groups.find(item => item.id === form.targetId); if (group) group.name = value }
    if (form.kind === 'page') {
      const id = crypto.randomUUID()
      next.pages.push({ id, groupId: form.targetId ?? next.groups[0]!.id, name: value, html: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{font-family:system-ui;padding:32px;background:#fafafa;color:#242424}h1{font-size:24px}</style></head><body><h1 data-prototype-element="title">新页面</h1><p data-prototype-element="description">请在主会话描述这个页面的内容和交互。</p></body></html>' })
      if (!next.entryPageId) next.entryPageId = id
    }
    if (form.kind === 'rename-page' || form.kind === 'html') {
      const target = next.pages.find(item => item.id === form.targetId)
      if (target) { if (form.kind === 'html') target.html = form.value; else target.name = value }
    }
    save(next, form.title, form.baseRevision)
  }

  /** 导出仅取已采纳版本，浏览器下载的是固定离线内容。 */
  function exportCurrent(): void {
    if (!document) return
    void run(() => window.electronAPI.interactionDesign.invoke('exportHtml', { sessionId, prototypeId: document.id, revision: document.revision }), result => {
      const url = URL.createObjectURL(new Blob([result.html], { type: 'text/html;charset=utf-8' }))
      const link = window.document.createElement('a'); link.href = url; link.download = result.fileName; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice(`已导出 v${result.revision}`)
    })
  }

  /** 实际点击只记录页面路径，目录浏览不计为流程验证。 */
  function navigate(target: string): void { updateView({ pageId: target }); setVisited(previous => [...previous, ...(previous.length ? [] : [pageId]), target].slice(-200)); setSelectedElement(null) }

  /** 仅叶子文本节点允许局部编辑，不破坏嵌套组件结构。 */
  const selectedText = React.useMemo(() => {
    if (!page || !selectedElement || candidate) return null
    const parsed = new DOMParser().parseFromString(page.html, 'text/html')
    const elements = [...parsed.querySelectorAll('[data-prototype-element]')].filter(item => item.getAttribute('data-prototype-element') === selectedElement)
    const element = elements[0]
    return elements.length === 1 && element && element.childElementCount === 0 && !/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META)$/.test(element.tagName) ? element.textContent : null
  }, [page, selectedElement, candidate])

  return <section className={`interaction-design ${focus && paneActive ? 'id-focus' : ''}`} aria-label="交互设计工作区">
    <header className="id-header">
      <div className="id-title"><span className="id-product-mark"><MousePointer2 size={18} /></span><div>
        <select aria-label="选择原型" value={view.prototypeId ?? ''} disabled={busy || !!form || !!flowDraft} onChange={event => { updateView({ prototypeId: event.target.value, pageId: null }); setDirectory(false) }}>
          {!summaries.length && <option value="">交互设计</option>}{summaries.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select><p>{loading ? '正在读取…' : document ? `${document.pages.length} 个页面 · 已保存 v${document.revision}` : '从需求或现有项目开始'}</p>
      </div></div>
      <div className="id-actions">
        <Button variant="outline" size="sm" disabled={busy} aria-expanded={directory} onClick={() => setDirectory(value => !value)}><ListTree size={14} /><span>页面</span></Button>
        <Button variant="ghost" size="sm" disabled={!document} onClick={() => setPanel('history')}><History size={14} /><span>v{document?.revision ?? 0}</span></Button>
        <Button variant="outline" size="sm" disabled={!document} onClick={() => setPanel('flow')}><Route size={14} /><span>交互流程</span></Button>
        <Button size="sm" disabled={!document || busy} onClick={exportCurrent}><Download size={14} /><span>导出原型</span></Button>
      </div>
    </header>
    {error && <div className="id-feedback id-error" role="alert">{error}<Button variant="ghost" size="sm" onClick={() => { setForm(null); setFlowDraft(null); void load() }}>重新加载</Button></div>}
    {notice && <div className="id-feedback" role="status">{notice}<button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button></div>}
    {changed && <div className="id-feedback" role="status">外部设计已更新。当前编辑保留，重新加载后再提交。<Button size="sm" variant="ghost" onClick={() => { setForm(null); setFlowDraft(null); void load() }}>放弃编辑并加载</Button></div>}
    {!document ? <div className="id-empty"><MousePointer2 size={32} /><h2>{loading ? '正在加载原型' : '让想法变成可点击的页面'}</h2><p>打开“页面”列表，从列表中创建原型或页面，再向当前主会话描述需求。</p></div> : <>
      <div className="id-toolbar"><div className="id-mode"><button aria-pressed={mode === 'play'} onClick={() => { setMode('play'); setSelectedElement(null) }}><Play size={13} />体验</button><button aria-pressed={mode === 'select'} onClick={() => setMode('select')}><MousePointer2 size={13} />选择修改</button></div><span className="id-spacer" />
        <button aria-label="手机预览" aria-pressed={view.device === 'mobile'} onClick={() => updateView({ device: 'mobile' })}><Smartphone size={16} /></button><button aria-label="桌面预览" aria-pressed={view.device === 'desktop'} onClick={() => updateView({ device: 'desktop' })}><Monitor size={16} /></button><span className="id-rule" />
        <button aria-label="重新体验" onClick={() => { updateView({ pageId: draft?.entryPageId }); setReset(value => value + 1); setVisited([]); setSelectedElement(null) }}><RefreshCw size={15} /></button><button aria-label={focus ? '退出专注' : '专注预览'} aria-pressed={focus} onClick={() => setFocus(value => !value)}>{focus ? <X size={16} /> : <Expand size={16} />}</button>
        <DropdownMenu><DropdownMenuTrigger asChild><button aria-label="更多原型操作"><MoreHorizontal size={16} /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => openForm('reference', '引用到主会话', '请根据需求完善当前原型的页面与交互。')}>描述需求并引用到会话</DropdownMenuItem><DropdownMenuItem onSelect={() => { setPanel('project'); setInspection(null); setSourcePaths([]); void run(() => window.electronAPI.interactionDesign.invoke('inspectProject', { sessionId }), setInspection) }}>从现有项目还原</DropdownMenuItem><DropdownMenuItem onSelect={() => openForm('import', '导入项目 HTML')}>导入项目 HTML</DropdownMenuItem><DropdownMenuItem onSelect={() => openForm('asset', '导入项目图片')}>导入项目图片</DropdownMenuItem>{page && <DropdownMenuItem disabled={!!candidate} onSelect={() => openForm('html', '编辑页面 HTML', page.html, page.id)}>编辑当前页面 HTML</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>
      </div>
      {snapshot.candidates.filter(item => item.status === 'ready' || item.status === 'stale').length > 0 && <div className="id-candidates">{snapshot.candidates.filter(item => item.status === 'ready' || item.status === 'stale').map(item => <div key={item.id}><Sparkles size={14} /><span>{item.summary} <small>{item.baseRevision !== document.revision || item.status === 'stale' ? '基线已变化，不能采纳' : `基于 v${item.baseRevision}`}</small></span><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => window.electronAPI.interactionDesign.invoke('getCandidate', { sessionId, prototypeId: document.id, candidateId: item.id }), result => {
        /** 导入候选新增页面时直接定位新增页，让用户第一次预览就能看到导入结果；普通修改仍保留当前页。 */
        const addedPage = result.draft.pages.find(candidatePage => !document.pages.some(currentPage => currentPage.id === candidatePage.id))
        setCandidate(result); setSelectedElement(null); if (addedPage) updateView({ pageId: addedPage.id })
      })}>预览</Button><Button size="sm" variant="ghost" disabled={busy || item.baseRevision !== document.revision || item.status !== 'ready'} onClick={() => void run(() => window.electronAPI.interactionDesign.invoke('adopt', { sessionId, prototypeId: document.id, candidateId: item.id, baseRevision: document.revision }), acceptSnapshot)}>采纳</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => window.electronAPI.interactionDesign.invoke('discardCandidate', { sessionId, prototypeId: document.id, candidateId: item.id }), acceptSnapshot)}>忽略</Button></div>)}</div>}
      {candidate && <div className="id-candidate-preview"><span>候选预览 · 尚未采纳</span><button onClick={() => { setCandidate(null); setSelectedElement(null) }}>返回当前版本</button></div>}
      <div className="id-stage"><div className="id-stage-top"><span>{page?.name ?? '暂无页面'}</span><span>{mode === 'select' ? '仅支持声明过身份的受控元素' : '独立沙箱 · 不访问真实业务接口'}</span></div>
        {page && draft ? <InteractionDesignPreview draft={draft} pageId={page.id} revision={document.revision} identity={`${projectId}:${document.id}:${document.revision}:${candidate?.id ?? 'head'}:${reset}`} mode={mode} device={view.device} assets={assets} onSelect={setSelectedElement} onNavigate={navigate} /> : <div className="id-empty"><p>还没有页面，先创建页面或引用需求到主会话。</p><Button onClick={() => openForm('page', '新建页面', '', document.groups[0]?.id)}>新建页面</Button></div>}
        {selectedElement && <aside className="id-selection"><div><strong>已选中元素</strong><button aria-label="清除元素选择" onClick={() => setSelectedElement(null)}><X size={14} /></button></div><p>{page?.name} / {selectedElement}</p><p>带着页面、元素与版本引用继续修改。</p>{selectedText !== null && <Button size="sm" variant="outline" className="mb-2 mr-2" onClick={() => openForm('element', '修改选中文字', selectedText, pageId)}>编辑文字</Button>}<Button size="sm" disabled={!!candidate} onClick={() => openForm('reference', '引用到主会话', '请只修改选中的元素，保留其他页面与交互不变。')}>引用到会话</Button>{candidate && <small>先返回当前版本或采纳候选后修改</small>}</aside>}
        <div className="id-stage-hint"><span className="id-live-dot" />{mode === 'play' ? '预览已运行，直接点击试试看' : '点击带稳定身份的内容，再引用到主会话'}</div>
      </div>
      <footer className="id-footer"><span>本次体验 · {visited.length ? `${visited.length} 次页面访问` : '尚未记录跳转'}</span><span>{view.device === 'mobile' ? '390 × 844' : '1280 × 800'}</span></footer>
    </>}
    {directory && <><button className="id-directory-backdrop" aria-label="关闭页面列表" onClick={() => setDirectory(false)} /><aside className="id-directory" aria-label="项目页面">
      <header><strong>项目页面 {document && <small>{document.pages.length}</small>}</strong><button aria-label="收起页面列表" onClick={() => setDirectory(false)}><PanelLeftClose size={16} /></button></header>
      <div className="id-directory-create">
        <button disabled={busy} onClick={() => openForm('page', '新建页面', '', document?.groups[0]?.id)}><Plus size={15} />新建页面</button>
      </div>
      {document ? <><label className="id-search"><Search size={14} /><input autoFocus type="search" placeholder="搜索页面" aria-label="搜索页面" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="id-directory-content">
        {document.pages.filter(item => item.name.toLowerCase().includes(search.toLowerCase())).map(item => <div className={`id-page ${pageId === item.id ? 'active' : ''}`} key={item.id} draggable={!busy} onDragStart={event => { event.dataTransfer.setData('application/x-prototype-page', item.id) }} onDragOver={event => event.preventDefault()} onDrop={event => { const moving = event.dataTransfer.getData('application/x-prototype-page'); if (moving && moving !== item.id) { event.preventDefault(); save(movePrototypePage(document, moving, item.groupId, item.id), '调整页面顺序') } }}>
          <button onClick={() => { setCandidate(null); updateView({ pageId: item.id }); setDirectory(false); setSelectedElement(null) }}><span className="id-page-thumb"><Workflow size={14} /></span><span>{item.name}</span>{document.entryPageId === item.id && <small>入口</small>}</button>
          <DropdownMenu><DropdownMenuTrigger asChild><button aria-label={`${item.name}页面操作`}><MoreHorizontal size={15} /></button></DropdownMenuTrigger><DropdownMenuContent side="right" align="start"><DropdownMenuItem disabled={busy} onSelect={() => { const next = copyPrototypeDraft(document); next.pages.push({ ...structuredClone(item), id: crypto.randomUUID(), name: `${item.name} 副本` }); save(next, '复制页面') }}>复制</DropdownMenuItem><DropdownMenuItem onSelect={() => openForm('rename-page', '重命名页面', item.name, item.id)}>重命名</DropdownMenuItem><DropdownMenuItem disabled={document.entryPageId === item.id || busy} onSelect={() => { const next = copyPrototypeDraft(document); next.entryPageId = item.id; save(next, '设置入口页') }}>设为入口</DropdownMenuItem><DropdownMenuItem disabled={busy || document.entryPageId === item.id || document.pages.length <= 1} onSelect={() => save(deletePrototypePage(document, item.id), '删除页面')}>删除</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        </div>)}
        {search && !document.pages.some(item => item.name.toLowerCase().includes(search.toLowerCase())) && <p className="id-no-results">没有匹配的页面</p>}
      </div></> : <div className="id-directory-empty"><strong>当前项目的页面</strong>{summaries.map(item => <button key={item.id} onClick={() => { updateView({ prototypeId: item.id, pageId: null }); setDirectory(false) }}><span>{item.name}</span><small>{item.pageCount} 个页面</small></button>)}{!summaries.length && <p>当前项目还没有页面</p>}<p>新建页面会自动创建交互设计空间。</p></div>}
      <footer>{document ? '拖拽排序 · 页面列表不使用分组' : '页面从此列表进入，内部空间自动创建'}</footer>
    </aside></>}
    <Dialog open={!!form} onOpenChange={open => { if (!open && !busy) setForm(null) }}><DialogContent><DialogHeader><DialogTitle>{form?.title}</DialogTitle><DialogDescription>{form?.kind === 'reference' ? '引用将填入当前主会话，由你检查后发送给真实 Agent。' : form?.kind === 'import' || form?.kind === 'asset' ? '填写当前项目内的相对路径，不访问项目外文件。' : form?.kind === 'html' ? '保存后形成新版本。页面使用 data-prototype-element 声明可选元素。' : '修改仅保存到当前项目的交互设计模块。'}</DialogDescription></DialogHeader>{form && (form.kind === 'html' || form.kind === 'reference' || form.kind === 'element' ? <Textarea aria-label={form.title} className={form.kind === 'html' ? 'min-h-72 font-mono text-xs' : 'min-h-28'} value={form.value} onChange={event => setForm({ ...form, value: event.target.value })} /> : <Input aria-label={form.title} value={form.value} onChange={event => setForm({ ...form, value: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') submitForm() }} />)}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}{changed && <p className="text-xs text-destructive">外部版本已变化，请关闭表单并重新加载。</p>}<DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setForm(null)}>取消</Button><Button disabled={busy || !form?.value.trim() || changed} onClick={submitForm}>{busy ? '处理中…' : form?.kind === 'reference' ? '引用到会话' : '保存'}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!panel} onOpenChange={open => { if (!open && !busy) { setPanel(null); setFlowDraft(null) } }}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>{panel === 'history' ? '版本与候选记录' : panel === 'flow' ? '交互流程' : '从现有项目还原'}</DialogTitle><DialogDescription>{panel === 'history' ? '恢复只切换当前版本，不新增版本；后续修改或采纳候选时才会生成新版本。' : panel === 'flow' ? '结构检查与实际体验独立记录；没有点击记录不能代表流程已通过。' : '选择页面和样式来源，交给当前主会话分析并生成独立可编辑候选。'}</DialogDescription></DialogHeader>
      <div className="id-dialog-list">
      {panel === 'history' && document && snapshot?.versions.map(version => <div className="id-version" key={version.revision}><div><strong>v{version.revision} {version.summary}</strong><small>{new Date(version.createdAt).toLocaleString()}</small></div><Button size="sm" variant="outline" disabled={busy || version.revision === document.revision} onClick={() => void run(() => window.electronAPI.interactionDesign.invoke('restore', { sessionId, prototypeId: document.id, baseRevision: document.revision, revision: version.revision }), result => { acceptSnapshot(result); setPanel(null); setNotice(`已切换到 v${result.document.revision}，未新增版本`) })}>恢复此版本</Button></div>)}
      {panel === 'history' && snapshot?.jobs.map(job => <div className="id-version" key={job.id}><div><strong>{job.instruction}</strong><small>{({ running: '等待生成结果', candidate: '候选已生成', cancelled: '已取消', failed: '失败', interrupted: '已中断' })[job.status]} {job.message}</small></div>{job.status === 'running' && document && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => window.electronAPI.interactionDesign.invoke('cancelJob', { sessionId, prototypeId: document.id, jobId: job.id }), acceptSnapshot)}>取消</Button>}</div>)}
      {panel === 'flow' && document && <><div className="id-flow-list">{(flowDraft ?? document.flows).map((flow, index) => <div className="id-flow" key={flow.id}><select aria-label={`连接${index + 1}来源页`} value={flow.fromPageId} onChange={event => setFlowDraft((flowDraft ?? document.flows).map(item => item.id === flow.id ? { ...item, fromPageId: event.target.value } : item))}>{document.pages.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><Input aria-label={`连接${index + 1}元素身份`} value={flow.elementId} placeholder="元素 ID" onChange={event => setFlowDraft((flowDraft ?? document.flows).map(item => item.id === flow.id ? { ...item, elementId: event.target.value } : item))} /><span>→</span><select aria-label={`连接${index + 1}目标页`} value={flow.targetPageId} onChange={event => setFlowDraft((flowDraft ?? document.flows).map(item => item.id === flow.id ? { ...item, targetPageId: event.target.value } : item))}>{document.pages.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button aria-label={`删除连接${index + 1}`} onClick={() => setFlowDraft((flowDraft ?? document.flows).filter(item => item.id !== flow.id))}><X size={14} /></button></div>)}</div><div className="id-flow-actions"><Button size="sm" variant="outline" disabled={!document.pages.length} onClick={() => setFlowDraft([...(flowDraft ?? document.flows), { id: crypto.randomUUID(), fromPageId: pageId, elementId: '', targetPageId: document.entryPageId }])}>添加跳转</Button><Button size="sm" disabled={busy || !flowDraft || changed} onClick={() => { const next = copyPrototypeDraft(document); next.flows = flowDraft!; save(next, '修改交互流程') }}>保存流程</Button><Button size="sm" variant="outline" disabled={busy || !!flowDraft} onClick={() => void run(() => window.electronAPI.interactionDesign.invoke('validate', { sessionId, prototypeId: document.id, revision: document.revision }), check => { setSnapshot(previous => previous ? { ...previous, checks: [...previous.checks, check] } : previous) })}>结构检查</Button><Button size="sm" variant="outline" disabled={busy || !visited.length || !!candidate || !!flowDraft} onClick={() => void run(() => window.electronAPI.interactionDesign.invoke('recordExperience', { sessionId, prototypeId: document.id, revision: document.revision, visitedPageIds: visited }), check => { setSnapshot(previous => previous ? { ...previous, checks: [...previous.checks, check] } : previous); setNotice('已保存本次体验路径，不代表未访问场景通过。') })}>记录本次体验</Button></div>{snapshot?.checks.filter(check => check.revision === document.revision).map(check => <div className="id-check" key={check.id}><strong>{check.kind === 'structure' ? '结构检查' : '实际体验'} · {check.kind === 'experience' ? (check.passed ? '已记录访问路径' : '记录失败') : (check.passed ? '已通过本次检查' : '发现问题')}</strong>{check.issues.map((issue, index) => <p key={index}>{issue}</p>)}{check.kind === 'experience' && <p>记录 {check.visitedPageIds.length} 次页面访问</p>}</div>)}</>}
      {panel === 'project' && (!inspection ? <p>{busy ? '正在读取项目目录…' : '项目扫描未完成，请关闭后重试。'}</p> : <><p>{inspection.projectName} · {inspection.frameworks.join(' / ') || '未识别技术栈'}</p>{inspection.warnings.map((warning, index) => <p className="id-warning" key={index}>{warning}</p>)}{inspection.truncated && <p className="id-warning">目录超过扫描预算，仅展示本次读取到的文件。</p>}<div className="id-source-list">{inspection.files.map(file => <label key={file.path}><input type="checkbox" checked={sourcePaths.includes(file.path)} onChange={event => setSourcePaths(previous => event.target.checked ? [...previous, file.path] : previous.filter(path => path !== file.path))} /><span>{file.path}</span><small>{file.kind}</small></label>)}</div><Button disabled={!sourcePaths.length} onClick={() => reference(`请从当前项目的以下文件还原页面视觉和交互：\n${sourcePaths.map(path => `- ${path}`).join('\n')}\n先用 prototype_read_source 读取并核对源代码，保留主题、字体、布局与素材；生成独立可编辑原型候选。明确模拟数据、未支持依赖和待验证的交互，不修改原项目。`, undefined, 'prototype')}>引用到主会话</Button></>)}
      </div>
    </DialogContent></Dialog>
  </section>
}
