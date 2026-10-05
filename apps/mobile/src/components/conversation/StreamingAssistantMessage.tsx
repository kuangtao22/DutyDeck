import { useState } from 'react'
import { Bot, Brain, ChevronRight, LoaderCircle } from 'lucide-react'
import type { MobileStreamSegments } from '../../atoms'
import { renderMd } from '../../utils/markdown'

interface StreamingAssistantMessageProps {
  /** 当前会话尚未写入历史的回答与思考快照。 */
  segments: MobileStreamSegments
}

/**
 * 将实时思考作为可折叠次级信息，并把回答保持为独立主内容。
 * @param props 当前帧的实时回答与思考
 * @returns 手机端助手流式消息
 */
export function StreamingAssistantMessage({ segments }: StreamingAssistantMessageProps) {
  /** 仅在用户展开思考时解析 Markdown，避免每帧重绘隐藏正文。 */
  const [reasoningExpanded, setReasoningExpanded] = useState(false)
  /** 短预览始终可见，避免用户必须展开才能知道当前思考方向。 */
  const reasoningPreview = segments.reasoning.length > 48
    ? `${segments.reasoning.slice(0, 48)}…`
    : segments.reasoning

  return (
    <article data-message-role="assistant" className="flex min-w-0 gap-2.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-card-foreground">
        <Bot aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex min-h-5 items-center gap-2">
          <p className="text-[11px] font-medium text-foreground/70">Proma</p>
          <span role="status" className="text-[10px] text-muted-foreground">
            {segments.answer ? '回答中' : '思考中'}
          </span>
        </div>
        {segments.reasoning && (
          <details
            className="group mb-2 overflow-hidden rounded-md border border-border bg-muted/30"
            onToggle={(event) => setReasoningExpanded(event.currentTarget.open)}
          >
            <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 px-2.5 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
              <Brain aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span>思考过程</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground/70">{reasoningPreview}</span>
              {!segments.answer && <LoaderCircle aria-hidden="true" className="ml-auto h-3.5 w-3.5 animate-spin" />}
            </summary>
            {reasoningExpanded && (
              <div
                className="border-t border-border px-3 py-2 text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]"
                dangerouslySetInnerHTML={{ __html: renderMd(segments.reasoning) }}
              />
            )}
          </details>
        )}
        {segments.answer && (
          <div
            className="prose prose-sm max-w-none break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{ __html: renderMd(segments.answer) }}
          />
        )}
        <span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse bg-foreground/35 align-middle" />
      </div>
    </article>
  )
}
