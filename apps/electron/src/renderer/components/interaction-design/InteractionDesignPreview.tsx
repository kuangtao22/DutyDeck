import * as React from 'react'
import type { PrototypeDraft } from '@proma/shared'
import { buildPrototypePreview, parsePrototypePreviewMessage } from '@proma/shared'

/** 预览只接受已冻结正文，所有消息仍需父页面校验来源与身份。 */
interface InteractionDesignPreviewProps {
  draft: PrototypeDraft
  pageId: string
  revision: number
  identity: string
  mode: 'play' | 'select'
  device: 'mobile' | 'desktop'
  assets: Record<string, string>
  onSelect: (elementId: string, stateId?: string) => void
  onNavigate: (pageId: string) => void
}

/** 单个状态的沙箱参数；缩放只影响外框，不修改设计视口。 */
interface StatePreviewProps extends InteractionDesignPreviewProps {
  /** 缺省表示 page.html 默认状态。 */
  stateId?: string
  /** 状态显示名称，只有并排展示时显示。 */
  stateName: string
  /** 状态画板的统一缩放比例。 */
  scale: number
  /** 单状态沿用旧预览标题和布局。 */
  multiple: boolean
}

/** 每个状态拥有独立沙箱；页面目录和模式切换保持已加载的交互现场。 */
function StatePreview(props: StatePreviewProps): React.ReactElement {
  /** 隔离正文身份和临时体验实例；只重置或换版本才生成新令牌。 */
  const token = React.useMemo(() => crypto.randomUUID(), [props.identity, props.pageId, props.stateId])
  const frameRef = React.useRef<HTMLIFrameElement>(null)
  /** 状态首次进入滚动视区后才运行；同页滚走再返回保留临时表单。 */
  const boardRef = React.useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = React.useState(!props.multiple)
  const callbacks = React.useRef(props)
  callbacks.current = props
  /** HTML 来自共享安全构造器，图片仅允许已校验 data URL。 */
  const html = React.useMemo(() => loaded ? buildPrototypePreview(props.draft, props.pageId, {
    mode: 'play', token, revision: props.revision, assets: props.assets, stateId: props.stateId,
  }) : undefined, [loaded, props.draft, props.pageId, props.revision, props.assets, props.stateId, token])

  /** 模式切换走父端受控消息，避免重建页面丢失表单与交互状态。 */
  const syncMode = React.useCallback((): void => {
    frameRef.current?.contentWindow?.postMessage({ type: 'prototype-mode', token, mode: callbacks.current.mode }, '*')
  }, [token])
  React.useEffect(() => { syncMode() }, [props.mode, syncMode])

  React.useEffect(() => {
    /** 延迟加载只作用于当前业务页面，不渲染目录内其他页面。 */
    const node = boardRef.current
    if (!node || loaded) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setLoaded(true); observer.disconnect() }
    }, { root: node.closest('.id-preview-space'), rootMargin: '120px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [loaded])

  React.useEffect(() => {
    /** 只允许当前 iframe 当前文档的声明式消息；消息不能调用写入接口。 */
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow) return
      const message = parsePrototypePreviewMessage(event.data)
      if (!message || message.token !== token || message.pageId !== props.pageId || message.revision !== props.revision || message.stateId !== props.stateId) return
      if (message.type === 'prototype-select' && callbacks.current.mode === 'select' && message.elementId) callbacks.current.onSelect(message.elementId, props.stateId)
      if (message.type === 'prototype-navigate' && callbacks.current.mode === 'play' && message.targetPageId && callbacks.current.draft.pages.some(page => page.id === message.targetPageId)) callbacks.current.onNavigate(message.targetPageId)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [token, props.pageId, props.revision, props.stateId])

  /** 缩放只改变外框几何，保留 iframe DOM 与表单临时状态。 */
  const width = props.device === 'mobile' ? 390 : 1280
  const height = props.device === 'mobile' ? 844 : 800
  return <div ref={boardRef} className={props.multiple ? 'id-state-board' : undefined} data-state-id={props.stateId ?? ''} style={{ width: width * props.scale }}>
    {props.multiple && <div className="id-state-label">{props.stateName}</div>}
    <div className="id-device-frame" style={{ width: width * props.scale, height: height * props.scale }}>
      {loaded ? <iframe key={`${props.identity}:${props.pageId}:${props.stateId ?? 'default'}`} ref={frameRef} name={`prototype-state:${props.stateId ?? ''}`} title={props.multiple ? `${props.stateName}预览` : '当前原型预览'} sandbox="allow-scripts" srcDoc={html} onLoad={syncMode} style={{ width, height, transform: `scale(${props.scale})`, transformOrigin: 'top left' }} /> : <div className="id-state-placeholder">{props.stateName} · 滚动到此处加载</div>}
    </div>
  </div>
}

/** 同一业务页面的状态在同一工作区平面展开；旧页面保持单画板体验。 */
export function InteractionDesignPreview(props: InteractionDesignPreviewProps): React.ReactElement {
  /** 可用空间与设计视口分开测量，目录浮层不参与布局。 */
  const spaceRef = React.useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = React.useState({ width: 0, height: 0 })
  /** 默认正文和附加状态共同构成当前页画板，不把状态变成目录页面。 */
  const page = props.draft.pages.find(item => item.id === props.pageId)
  const multiple = Boolean(page?.states?.length)
  const width = props.device === 'mobile' ? 390 : 1280
  const height = props.device === 'mobile' ? 844 : 800
  /** 多状态保证可读尺寸，超出空间后滚动；不把十几个画板缩成缩略图。 */
  const availableWidth = Math.max(1, bounds.width - 32)
  const columns = multiple ? Math.max(1, Math.floor((availableWidth + 24) / (props.device === 'mobile' ? 284 : 504))) : 1
  const scale = multiple
    ? Math.max(0.05, Math.min(1, (availableWidth - (columns - 1) * 24) / columns / width, Math.max(300, bounds.height - 64) / height))
    : Math.max(0.05, Math.min(1, availableWidth / width, (bounds.height - 24) / height))
  React.useEffect(() => {
    const node = spaceRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBounds({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  React.useEffect(() => { spaceRef.current?.scrollTo(0, 0) }, [props.identity, props.pageId])
  return <div className={`id-preview-space${multiple ? ' id-state-space' : ''}`} ref={spaceRef} aria-label={multiple ? '当前页面的状态画板' : '当前页面预览'}>
    <StatePreview {...props} key={`${props.identity}:${props.pageId}:default`} stateName={page?.defaultStateName ?? '默认状态'} scale={scale} multiple={multiple} />
    {page?.states?.map(state => <StatePreview {...props} key={`${props.identity}:${props.pageId}:state:${state.id}`} stateId={state.id} stateName={state.name} scale={scale} multiple={multiple} />)}
  </div>
}
