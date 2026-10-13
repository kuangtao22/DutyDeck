/**
 * ModelSelector - 模型选择器（锚定 Popover + 搜索）
 *
 * 现代化设计：
 * - 工具栏使用非模态菜单；表单使用嵌套模态菜单，兼容 Dialog 内的滚动锁
 * - 按渠道分组，标题与模型项使用统一栅格对齐
 * - 选中项使用柔和底色与右侧勾选标记
 * - 触发按钮：模型 logo + 模型名 + Chevron
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Check, ChevronDown, Cpu, Search } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  conversationsAtom,
  selectedModelAtom,
  channelsAtom,
  channelsLoadedAtom,
  modelSelectorOpenAtom,
} from '@/atoms/chat-atoms'
import { useConversationModelOptional } from '@/hooks/useConversationSettings'
import { useConversationIdOptional } from '@/contexts/session-context'
import { inputToolbarControlHeightClass } from '@/components/ai-elements/input-toolbar-styles'
import { buttonVariants } from '@/components/ui/button'
import { getModelLogo, getChannelLogo, DefaultLogo } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import type { Channel, ModelOption, ProviderType } from '@proma/shared'
import { ChannelPlanQuotaBadge } from './ChannelPlanQuotaBadge'
import { getModelSelectorOptionVisualState } from './model-selector-visual-state'

/** 渠道标题与模型项共享的三列栅格，确保左右边距和文字起点一致。 */
const MODEL_SELECTOR_ROW_LAYOUT =
  'mx-1 grid w-[calc(100%-0.5rem)] grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2 px-3'

interface ModelSelectorListIconProps {
  src: string
}

/** 使用固定外框吸收不同 Logo 素材的透明留白差异，保持列表中的视觉尺寸稳定。 */
function ModelSelectorListIcon({ src }: ModelSelectorListIconProps): React.ReactElement {
  return (
    <span
      className="flex size-6 shrink-0 items-center justify-center justify-self-center overflow-hidden rounded-md bg-muted/50"
      aria-hidden="true"
    >
      <img src={src} alt="" className="size-5 rounded-md object-contain" />
    </span>
  )
}

/** 从渠道列表构建扁平化的模型选项 */
export function buildModelOptions(
  channels: Channel[],
  filterChannelId?: string,
  filterChannelIds?: string[],
  excludedProviders?: readonly ProviderType[],
): ModelOption[] {
  const options: ModelOption[] = []

  for (const channel of channels) {
    if (!channel.enabled) continue
    if (filterChannelId && channel.id !== filterChannelId) continue
    if (filterChannelIds && !filterChannelIds.includes(channel.id)) continue
    if (excludedProviders?.includes(channel.provider)) continue

    for (const model of channel.models) {
      if (!model.enabled) continue

      options.push({
        channelId: channel.id,
        channelName: channel.name,
        modelId: model.id,
        modelName: model.name,
        provider: channel.provider,
      })
    }
  }

  return options
}

/** 按渠道分组模型选项 */
function groupByChannel(options: ModelOption[]): Map<string, ModelOption[]> {
  const groups = new Map<string, ModelOption[]>()

  for (const option of options) {
    const key = option.channelId
    const group = groups.get(key) ?? []
    group.push(option)
    groups.set(key, group)
  }

  return groups
}

/** ModelSelector 可选属性 */
interface ModelSelectorProps {
  /** 仅显示此渠道的模型 */
  filterChannelId?: string
  /** 仅显示这些渠道的模型（多渠道过滤） */
  filterChannelIds?: string[]
  /** 外部选中模型（不传则用内部 selectedModelAtom） */
  externalSelectedModel?: { channelId: string; modelId: string } | null
  /** 外部选择回调 */
  onModelSelect?: (option: ModelOption) => void
  /** 触发按钮是否显示「渠道 · 模型」（默认只显示模型名） */
  showChannelInTrigger?: boolean
  /** 不在此选择器中显示的供应商（例如 Chat 暂不支持的协议） */
  excludedProviders?: readonly ProviderType[]
  /** 是否使用全局 modelSelectorOpenAtom 控制打开状态（用于外部拉起，如错误提示按钮） */
  useSharedOpenState?: boolean
  /** 工具栏保持紧凑文字按钮；表单使用项目统一的全宽描边控件。 */
  triggerVariant?: 'toolbar' | 'form'
  /** 表单字段关联的标签 ID 目标；仅设置触发按钮 id。 */
  triggerId?: string
  /** 没有显式模型时展示的默认规则，例如自动匹配或跟随运行模型。 */
  placeholder?: string
}

export function ModelSelector({
  filterChannelId,
  filterChannelIds,
  externalSelectedModel,
  onModelSelect,
  showChannelInTrigger = false,
  excludedProviders,
  useSharedOpenState = false,
  triggerVariant = 'toolbar',
  triggerId,
  placeholder = '选择模型',
}: ModelSelectorProps = {}): React.ReactElement {
  const [conversationModel, setConversationModel] = useConversationModelOptional()
  const conversationId = useConversationIdOptional()
  const setConversations = useSetAtom(conversationsAtom)
  const setGlobalModel = useSetAtom(selectedModelAtom)
  const channels = useAtomValue(channelsAtom)
  const channelsLoaded = useAtomValue(channelsLoadedAtom)
  const setChannels = useSetAtom(channelsAtom)
  const [localOpen, setLocalOpen] = React.useState(false)
  const [sharedOpen, setSharedOpen] = useAtom(modelSelectorOpenAtom)
  const open = useSharedOpenState ? sharedOpen : localOpen
  const setOpen = useSharedOpenState ? setSharedOpen : setLocalOpen
  const [tooltipOpen, setTooltipOpen] = React.useState(false)
  const [search, setSearch] = React.useState('')

  // 外部模型优先 → per-conversation 模型
  const selectedModel = externalSelectedModel !== undefined ? externalSelectedModel : conversationModel

  // 本地模型启用真值来自资产清单；菜单未打开时也监听变化，及时清除过期选项。
  React.useEffect(() => {
    /** 当前订阅的读取代次与卸载标记，避免迟到查询覆盖新状态。 */
    let generation = 0
    let active = true
    /** 读取脱敏渠道投影，不将运行时端点或凭据放进 renderer。 */
    const refresh = async (): Promise<void> => {
      const current = ++generation
      try {
        const latest = await window.electronAPI.listChannels()
        if (active && current === generation) setChannels(latest)
      } catch (error) {
        console.error('[模型选择器] 刷新本地模型失败:', error)
      }
    }
    const unsubscribe = window.electronAPI.onLocalModelChanged(() => { void refresh() })
    if (open) { void refresh(); setSearch('') }
    return () => { active = false; unsubscribe() }
  }, [open, setChannels])

  const modelOptions = React.useMemo(
    () => buildModelOptions(channels, filterChannelId, filterChannelIds, excludedProviders),
    [channels, filterChannelId, filterChannelIds, excludedProviders],
  )
  const grouped = React.useMemo(() => groupByChannel(modelOptions), [modelOptions])

  // 搜索过滤
  const filteredGrouped = React.useMemo(() => {
    if (!search.trim()) return grouped

    const query = search.toLowerCase()
    const filtered = new Map<string, ModelOption[]>()

    for (const [channelId, options] of grouped.entries()) {
      const matchedOptions = options.filter(
        (o) =>
          o.modelName.toLowerCase().includes(query) ||
          o.channelName.toLowerCase().includes(query)
      )
      if (matchedOptions.length > 0) {
        filtered.set(channelId, matchedOptions)
      }
    }

    return filtered
  }, [grouped, search])

  // 扁平化过滤后的模型列表，用于键盘导航
  const flatOptions = React.useMemo(() => {
    const result: ModelOption[] = []
    for (const options of filteredGrouped.values()) {
      result.push(...options)
    }
    return result
  }, [filteredGrouped])

  // 键盘高亮索引
  const [highlightIndex, setHighlightIndex] = React.useState(-1)
  const itemRefs = React.useRef<Map<number, HTMLButtonElement>>(new Map())

  // 搜索变化时重置高亮
  React.useEffect(() => {
    setHighlightIndex(-1)
  }, [search])

  // 高亮项变化时滚动到可见区域
  React.useEffect(() => {
    if (highlightIndex < 0) return
    const el = itemRefs.current.get(highlightIndex)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  // 查找当前选中的模型信息
  const currentModelInfo = React.useMemo(() => {
    if (!selectedModel) return null
    return modelOptions.find(
      (o) => o.channelId === selectedModel.channelId && o.modelId === selectedModel.modelId
    ) ?? null
  }, [selectedModel, modelOptions])

  // 保持上次有效的模型信息，避免渠道未加载时闪烁"选择模型"
  const stableModelInfoRef = React.useRef(currentModelInfo)
  if (currentModelInfo) stableModelInfoRef.current = currentModelInfo
  // 本地模型被停用/验证失效后，不能继续用旧缓存冒充可选模型。
  else if (channelsLoaded && stableModelInfoRef.current?.provider === 'dutydeck-local') stableModelInfoRef.current = null
  const displayModelInfo = currentModelInfo ?? stableModelInfoRef.current

  // Tooltip 必须始终保持 controlled 或 uncontrolled 之一。此前在 Popover 打开时传 false、关闭时传
  // undefined，Radix 会发出 controlled/uncontrolled 告警，且与模型 Popover 的 trigger 竞争焦点。
  React.useEffect(() => {
    if (open || !displayModelInfo) setTooltipOpen(false)
  }, [displayModelInfo, open])

  /** 选择模型并持久化到当前对话 */
  const handleSelect = (option: ModelOption): void => {
    if (onModelSelect) {
      onModelSelect(option)
      setOpen(false)
      return
    }

    // Chat 模式：写入 per-conversation Map + 同步全局默认值
    if (setConversationModel) {
      setConversationModel({ channelId: option.channelId, modelId: option.modelId })
    }
    setGlobalModel({ channelId: option.channelId, modelId: option.modelId })
    setOpen(false)

    // 将模型/渠道选择保存到当前对话元数据
    if (conversationId) {
      window.electronAPI
        .updateConversationModel(conversationId, option.modelId, option.channelId)
        .then((updated) => {
          setConversations((prev) =>
            prev.map((c) => (c.id === updated.id ? updated : c))
          )
        })
        .catch(console.error)
    }
  }

  /** 搜索框键盘导航 */
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (flatOptions.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev < flatOptions.length - 1 ? prev + 1 : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : flatOptions.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = flatOptions[highlightIndex >= 0 ? highlightIndex : 0]
      if (target) handleSelect(target)
    }
  }

  if (channelsLoaded && modelOptions.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-2 py-1">
        <Cpu className="size-3.5" />
        <span>暂无可用模型</span>
      </div>
    )
  }

  return (
    // 表单菜单可位于 Dialog 内；使用嵌套模态滚动边界，避免 body Portal 被外层滚动锁拦截。
    <Popover open={open} onOpenChange={setOpen} modal={triggerVariant === 'form'}>
      {/* 触发按钮 */}
      <Tooltip
        open={tooltipOpen}
        onOpenChange={(nextOpen) => setTooltipOpen(nextOpen && !open && Boolean(displayModelInfo))}
      >
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              id={triggerId}
              className={cn(
                'model-selector-trigger',
                triggerVariant === 'form'
                  ? buttonVariants({ variant: 'outline', className: 'w-full min-w-0 justify-start bg-background/40 px-3 font-normal' })
                  : cn(
                    'flex items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors',
                    'hover:bg-accent hover:text-foreground focus:outline-none focus-visible:bg-accent focus-visible:text-foreground',
                    inputToolbarControlHeightClass,
                  ),
              )}
            >
              {displayModelInfo ? (
                <img
                  src={getModelLogo(displayModelInfo.modelId, displayModelInfo.provider)}
                  alt={displayModelInfo.modelName}
                  className="size-4 rounded object-cover"
                />
              ) : (
                <Cpu className="size-3.5" />
              )}
              <span className={triggerVariant === 'form' ? 'min-w-0 flex-1 truncate text-left' : 'max-w-[200px] truncate'}>
                {displayModelInfo
                  ? (showChannelInTrigger ? `${displayModelInfo.channelName} · ${displayModelInfo.modelName}` : displayModelInfo.modelName)
                  : placeholder}
              </span>
              <ChevronDown className="size-3" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">渠道：{displayModelInfo?.channelName}</TooltipContent>
      </Tooltip>

      {/* 工具栏菜单向上展开；表单菜单向下、左对齐并跟随字段宽度，统一复用搜索与分组。 */}
      <PopoverContent
        side={triggerVariant === 'form' ? 'bottom' : 'top'}
        align={triggerVariant === 'form' ? 'start' : 'end'}
        sideOffset={8}
        collisionPadding={12}
        // 按 Radix 实际可用高度收缩列表；仅限制 vh 会让窄窗口中的末尾模型越出屏幕。
        className={cn('flex max-h-[var(--radix-popover-content-available-height)] w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden p-0', triggerVariant === 'form' && 'w-[var(--radix-popover-trigger-width)]')}
        aria-label="选择模型"
      >
        {/* 搜索栏 */}
        <div className="flex shrink-0 items-center gap-2 px-3.5 py-2.5 border-b border-border/60">
          <Search className="size-4 text-muted-foreground/60 flex-shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索模型..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
            autoFocus
          />
        </div>

        {/* 模型列表 */}
        <div className="min-h-0 max-h-[min(360px,55vh)] overflow-y-auto overscroll-contain scrollbar-thin">
          {filteredGrouped.size === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              未找到模型
            </div>
          ) : (
            (() => {
              let flatIndex = 0
              return Array.from(filteredGrouped.entries()).map(([channelId, options]) => {
                const first = options[0]
                if (!first) return null
                const channel = channels.find((c) => c.id === channelId)

                return (
                  <div
                    key={channelId}
                    role="group"
                    aria-label={first.channelName}
                    className="border-b border-border/40 py-1 last:border-b-0"
                  >
                    {/* 渠道标题与模型行共用栅格，仅通过字号和色阶区分层级。 */}
                    <div className={cn(MODEL_SELECTOR_ROW_LAYOUT, 'min-h-7 py-0.5')}>
                      <ModelSelectorListIcon
                        src={channel ? getChannelLogo(channel) : DefaultLogo}
                      />
                      <span className="min-w-0 truncate text-xs font-medium text-muted-foreground/80">
                        {first.channelName}
                      </span>
                      {channel ? <ChannelPlanQuotaBadge channel={channel} /> : null}
                    </div>

                    {/* 该渠道下的模型列表 */}
                    {options.map((option) => {
                      const isSelected =
                        selectedModel?.channelId === option.channelId &&
                        selectedModel?.modelId === option.modelId
                      const currentFlatIndex = flatIndex++
                      const isHighlighted = currentFlatIndex === highlightIndex
                      const visualState = getModelSelectorOptionVisualState(isSelected, isHighlighted)

                      return (
                        <button
                          key={`${option.channelId}:${option.modelId}`}
                          ref={(el) => {
                            if (el) itemRefs.current.set(currentFlatIndex, el)
                            else itemRefs.current.delete(currentFlatIndex)
                          }}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => handleSelect(option)}
                          onMouseEnter={() => setHighlightIndex(currentFlatIndex)}
                          className={cn(
                            MODEL_SELECTOR_ROW_LAYOUT,
                            'min-h-9 rounded-lg py-1.5 text-left transition-colors',
                            'hover:bg-accent/60 focus:outline-none focus-visible:bg-accent/70',
                            visualState === 'highlighted' && 'bg-accent/60',
                            visualState === 'selected' && 'bg-accent',
                          )}
                        >
                          <ModelSelectorListIcon
                            src={getModelLogo(option.modelId, option.provider)}
                          />
                          <span className={cn(
                            'min-w-0 truncate text-sm',
                            isSelected ? 'font-medium text-foreground' : 'text-foreground/80',
                          )}>
                            {option.modelName}
                          </span>
                          <span className="flex size-5 items-center justify-center" aria-hidden="true">
                            {isSelected ? <Check className="size-4 text-primary" strokeWidth={2.5} /> : null}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )
              })
            })()
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
