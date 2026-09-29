import * as React from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, lineNumbers, placeholder } from '@codemirror/view'
import { bracketMatching, foldGutter, foldKeymap, foldService } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { createVisibleCodeHighlight } from '@/components/ui/json-code-editor'
import { formatTaskJson, taskJsonDiagnostic, taskJsonFolds } from './capability-task-editor'

/** 编辑区只管理显示与编辑事务，场景变量解析仍交给提交表单。 */
interface CapabilityTaskEditorProps {
  id: string
  value: string
  format: 'text' | 'json' | 'markdown'
  disabled: boolean
  /** 用于结果展示：禁止改写但保留选择、复制、折叠和键盘滚动。 */
  readOnly?: boolean
  /** 占满详情栏剩余高度；提交弹窗仍沿用固定编辑高度。 */
  fillHeight?: boolean
  /** 区分同一详情中的不同输出区域，默认保持提交任务原有名称。 */
  ariaLabel?: string
  invalid: boolean
  describedBy: string
  onChange: (value: string) => void
}

/** 复用应用主题；文本使用正文字体，代码与 Markdown 使用等宽字体。 */
const taskEditorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', lineHeight: '1.8' },
  '.cm-content': { padding: '10px 0', caretColor: 'hsl(var(--foreground))' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': { background: 'hsl(var(--muted) / 0.3)', color: 'hsl(var(--muted-foreground))', borderRight: '1px solid hsl(var(--border))' },
  '.cm-cursor': { borderLeftColor: 'hsl(var(--foreground))' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'hsl(var(--accent))' },
  '.cm-matchingBracket': { background: 'hsl(var(--accent))', outline: '1px solid hsl(var(--border))' },
  '.cm-placeholder': { color: 'hsl(var(--muted-foreground))' },
})

/** 根据识别格式安装显示扩展，重配时不重建文档、选区或撤销历史。 */
function taskLanguage(format: CapabilityTaskEditorProps['format']) {
  return [
    EditorView.theme({ '.cm-scroller': { fontFamily: format === 'text' ? 'inherit' : 'ui-monospace, SFMono-Regular, Menlo, monospace' } }),
    ...(format === 'text' ? [] : [lineNumbers(), createVisibleCodeHighlight(format)]),
    ...(format === 'json' ? [bracketMatching(), foldGutter(), foldService.of((state, from) => taskJsonFolds(state.doc).get(state.doc.lineAt(from).number) ?? null)] : []),
  ]
}

/** 在单一稳定 CodeMirror 实例中编辑；仅主动格式化会修改用户原文。 */
export function CapabilityTaskEditor(props: CapabilityTaskEditorProps): React.ReactElement {
  /** 稳定实例与最新回调避免输入时卸载编辑器或重复写回。 */
  const hostRef = React.useRef<HTMLDivElement>(null)
  const viewRef = React.useRef<EditorView | null>(null)
  const propsRef = React.useRef(props)
  propsRef.current = props
  const externalUpdate = React.useRef(false)
  const language = React.useMemo(() => new Compartment(), [])
  const controls = React.useMemo(() => new Compartment(), [])
  const [ready, setReady] = React.useState(false)
  const [preview, setPreview] = React.useState(false)
  const readOnly = props.disabled || Boolean(props.readOnly)
  const ariaLabel = props.ariaLabel ?? '任务内容'
  /** 只在 JSON 模式检查语法，延迟到键盘更新之后，普通正文不触发报错。 */
  const deferredValue = React.useDeferredValue(props.value)
  const diagnostic = React.useMemo(() => props.format === 'json' ? taskJsonDiagnostic(deferredValue) : null, [props.format, deferredValue])

  React.useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({ parent: hostRef.current, state: EditorState.create({
      doc: propsRef.current.value,
      extensions: [
        taskEditorTheme, EditorView.lineWrapping, drawSelection(), history(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
        placeholder('粘贴本次需要处理的内容，自动识别文本、JSON、Markdown…'),
        language.of(taskLanguage(propsRef.current.format)), controls.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !externalUpdate.current) propsRef.current.onChange(update.state.doc.toString())
        }),
      ],
    }) })
    viewRef.current = view
    setReady(true)
    return () => { viewRef.current = null; view.destroy() }
  }, [language, controls])

  React.useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === props.value) return
    externalUpdate.current = true
    try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value } }) }
    finally { externalUpdate.current = false }
  }, [props.value])

  React.useEffect(() => {
    viewRef.current?.dispatch({ effects: language.reconfigure(taskLanguage(props.format)) })
  }, [props.format, language])

  React.useEffect(() => {
    viewRef.current?.dispatch({ effects: controls.reconfigure([
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({ id: props.id, 'aria-label': ariaLabel, 'aria-multiline': 'true', 'aria-readonly': String(readOnly), 'aria-invalid': String(props.invalid || Boolean(diagnostic)), 'aria-describedby': props.describedBy, spellcheck: 'false', tabindex: '0' }),
    ]) })
  }, [props.id, props.invalid, props.describedBy, diagnostic, readOnly, ariaLabel, controls])

  React.useEffect(() => { if (!preview) viewRef.current?.requestMeasure() }, [preview])

  return <div className={props.fillHeight ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-1.5' : 'min-w-0 space-y-1.5'}>
    {props.format === 'markdown' || (props.format === 'json' && !props.readOnly) ? <div className="flex shrink-0 justify-end gap-1">
      {props.format === 'json' ? (props.readOnly ? null : <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" disabled={props.disabled || Boolean(diagnostic)} onClick={() => {
        const view = viewRef.current
        if (!view || view.composing) return
        try {
          const formatted = formatTaskJson(view.state.doc.toString())
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted }, annotations: isolateHistory.of('full') })
          view.focus()
        } catch { /* 输入尚未完成时不改动内容，语法诊断会指出原因。 */ }
      }}>格式化 JSON</Button>) : <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? (props.readOnly ? '返回原文' : '返回编辑') : '预览 Markdown'}</Button>}
    </div> : null}
    <div className={`${props.fillHeight ? 'min-h-0 flex-1' : 'h-80 min-h-48 max-h-[50dvh] rounded-md border border-input focus-within:ring-1 focus-within:ring-ring'} min-w-0 overflow-hidden bg-background`} data-task-editor={props.format}>
      <div ref={hostRef} className={!ready || (preview && props.format === 'markdown') ? 'hidden' : 'h-full min-w-0'} />
      {!ready ? <Textarea id={props.id} aria-label={ariaLabel} aria-describedby={props.describedBy} aria-invalid={props.invalid} value={props.value} disabled={props.disabled} readOnly={props.readOnly} className="h-full min-h-0 resize-none rounded-none border-0" placeholder="粘贴本次需要处理的内容…" onChange={(event) => {
        if (!props.readOnly) props.onChange(event.target.value)
      }} /> : null}
      {preview && props.format === 'markdown' ? <div role="region" aria-label="Markdown 预览" className="prose prose-sm dark:prose-invert h-full max-w-none overflow-auto p-3 [overflow-wrap:anywhere]">
        <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt || '图片'}</span>, a: ({ children }) => <span className="underline">{children}</span> }}>{props.value}</Markdown>
      </div> : null}
    </div>
    {diagnostic ? <button type="button" className="block max-w-full text-left text-[11px] text-destructive [overflow-wrap:anywhere]" disabled={props.disabled} onClick={() => {
      const view = viewRef.current
      if (!view) return
      /** 点击时以最新内容重新计算位置，避免错误提示落后输入时跳错行。 */
      const current = taskJsonDiagnostic(view.state.doc.toString())
      if (!current) return
      view.dispatch({ selection: { anchor: current.from }, scrollIntoView: true })
      view.focus()
    }}>{diagnostic.message} · 点击定位</button> : null}
  </div>
}
