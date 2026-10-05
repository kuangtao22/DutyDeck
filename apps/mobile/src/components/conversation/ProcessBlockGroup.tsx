import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Brain, ChevronRight, Wrench } from 'lucide-react'
import type { ContentBlock, ToolResultContent, ToolUseContent } from '../../atoms'
import { renderMd } from '../../utils/markdown'
import { summarizeAssistantProcessBlocks } from './process-blocks'
import { ToolUseBlock } from './ToolUseBlock'

interface ProcessBlockGroupProps {
  /** 按模型返回顺序排列的思考、过程文字与工具调用。 */
  blocks: ContentBlock[]
  /** 按工具调用 ID 索引的已返回结果。 */
  resultMap: Map<string, ToolResultContent>
  /** 可选初始展开状态，用于实时过程或有明确展开意图的调用方。 */
  defaultExpanded?: boolean
}

/**
 * 在移动端将次级执行轨迹收于一处，展开后仍按原顺序阅读。
 * @param props 执行过程内容与工具结果映射
 * @returns 可访问、默认折叠的执行过程分组
 */
export function ProcessBlockGroup({ blocks, resultMap, defaultExpanded = false }: ProcessBlockGroupProps) {
  /** 历史轨迹默认收起，避免长链路挤占首屏。 */
  const [expanded, setExpanded] = useState(defaultExpanded)
  /** 为按钮与详情建立稳定的无障碍关联。 */
  const contentId = useId()
  /** 摘要只扫描内容块类型，不读取工具结果正文。 */
  const summary = useMemo(() => summarizeAssistantProcessBlocks(blocks), [blocks])

  return (
    <section className="min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((current) => !current)}
        className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
      >
        <ChevronRight aria-hidden="true" className={`h-4 w-4 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">执行过程</span>
        {summary.toolCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 tabular-nums">
            <Wrench aria-hidden="true" className="h-3.5 w-3.5" />
            {summary.toolCount} 次工具调用
          </span>
        )}
        {summary.messageCount > 0 && (
          <span className="hidden shrink-0 tabular-nums min-[360px]:inline">
            {summary.messageCount} 条消息
          </span>
        )}
      </button>
      <div id={contentId} hidden={!expanded} className="ml-2 min-w-0 space-y-2 border-l border-border/70 py-1 pl-3">
        {expanded && blocks.map((block, index) => renderProcessBlock(block, index, resultMap))}
      </div>
    </section>
  )
}

/**
 * 按内容块类型渲染一项执行轨迹。
 * @param block 当前过程内容块
 * @param index 原始块索引，用于提供稳定列表键
 * @param resultMap 工具调用 ID 对应的结果快照
 * @returns 一项思考、过程文字或工具调用；非过程块不渲染
 */
function renderProcessBlock(
  block: ContentBlock,
  index: number,
  resultMap: Map<string, ToolResultContent>,
): ReactNode {
  if (block.type === 'thinking') {
    return (
      <div key={`thinking-${index}`} className="min-w-0 break-words text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/80">
          <Brain aria-hidden="true" className="h-3.5 w-3.5" />
          思考过程
        </div>
        <div dangerouslySetInnerHTML={{ __html: renderMd(block.thinking) }} />
      </div>
    )
  }

  if (block.type === 'text') {
    return (
      <div
        key={`text-${index}`}
        className="prose prose-sm min-w-0 max-w-none break-words text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]"
        dangerouslySetInnerHTML={{ __html: renderMd(block.text) }}
      />
    )
  }

  if (block.type === 'tool_use') {
    /** 工具块保留自身类型，供既有摘要和结果渲染器使用。 */
    const toolUse = block as ToolUseContent
    return (
      <ToolUseBlock
        key={`tool-${index}`}
        toolUse={toolUse}
        result={resultMap.get(toolUse.id)}
      />
    )
  }

  return null
}
