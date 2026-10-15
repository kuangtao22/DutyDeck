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
  onSelect: (elementId: string) => void
  onNavigate: (pageId: string) => void
}

/** 单实例沙箱，目录浮层与设备尺寸切换不会卸载当前页面。 */
export function InteractionDesignPreview(props: InteractionDesignPreviewProps): React.ReactElement {
  /** 隔离正文身份和临时体验实例；只重置或换版本才生成新令牌。 */
  const token = React.useMemo(() => crypto.randomUUID(), [props.identity, props.pageId])
  const frameRef = React.useRef<HTMLIFrameElement>(null)
  const spaceRef = React.useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = React.useState({ width: 0, height: 0 })
  const callbacks = React.useRef(props)
  callbacks.current = props
  /** HTML 来自共享安全构造器，图片仅允许已校验 data URL。 */
  const html = React.useMemo(() => buildPrototypePreview(props.draft, props.pageId, {
    mode: 'play', token, revision: props.revision, assets: props.assets,
  }), [props.draft, props.pageId, props.revision, props.assets, token])

  /** 模式切换走父端受控消息，避免重建页面丢失表单与交互状态。 */
  const syncMode = React.useCallback((): void => {
    frameRef.current?.contentWindow?.postMessage({ type: 'prototype-mode', token, mode: callbacks.current.mode }, '*')
  }, [token])
  React.useEffect(() => { syncMode() }, [props.mode, syncMode])

  React.useEffect(() => {
    const node = spaceRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBounds({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    /** 只允许当前 iframe 当前文档的声明式消息；消息不能调用写入接口。 */
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow) return
      const message = parsePrototypePreviewMessage(event.data)
      if (!message || message.token !== token || message.pageId !== props.pageId || message.revision !== props.revision) return
      if (message.type === 'prototype-select' && callbacks.current.mode === 'select' && message.elementId) callbacks.current.onSelect(message.elementId)
      if (message.type === 'prototype-navigate' && callbacks.current.mode === 'play' && message.targetPageId && callbacks.current.draft.pages.some(page => page.id === message.targetPageId)) callbacks.current.onNavigate(message.targetPageId)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [token, props.pageId, props.revision])

  /** 缩放只改变外框几何，保留 iframe DOM 与表单临时状态。 */
  const width = props.device === 'mobile' ? 390 : 1280
  const height = props.device === 'mobile' ? 844 : 800
  const scale = Math.max(0.05, Math.min(1, (bounds.width - 32) / width, (bounds.height - 24) / height))
  return <div className="id-preview-space" ref={spaceRef}>
    <div className="id-device-frame" style={{ width: width * scale, height: height * scale }}>
      <iframe ref={frameRef} key={`${props.identity}:${props.pageId}`} title="当前原型预览" sandbox="allow-scripts" srcDoc={html} onLoad={syncMode} style={{ width, height, transform: `scale(${scale})`, transformOrigin: 'top left' }} />
    </div>
  </div>
}
