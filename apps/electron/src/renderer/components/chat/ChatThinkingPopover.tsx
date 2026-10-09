import * as React from 'react'
import { Brain } from 'lucide-react'
import {
  getModelCapabilities,
  getModelReasoningCapability,
  normalizeReasoningCapabilityLevel,
  type AgentThinkingLevel,
  type ProviderType,
  type ReasoningCapability,
} from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { inputToolbarActiveButtonClass, inputToolbarButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { useConversationThinkingEnabled, useConversationThinkingLevel } from '@/hooks/useConversationSettings'
import { cn } from '@/lib/utils'

const THINKING_LEVEL_LABELS: Record<AgentThinkingLevel, string> = {
  off: '关闭',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '较高',
  max: '最高',
}

interface ResolveChatThinkingControlStateInput {
  capability: ReasoningCapability | undefined
  knownNonReasoning: boolean
  storedLevel: AgentThinkingLevel
  legacyEnabled: boolean
}

export interface ChatThinkingControlState {
  mode: 'levels' | 'unsupported' | 'legacy-toggle'
  levels: readonly AgentThinkingLevel[]
  effectiveLevel: AgentThinkingLevel | undefined
  enabled: boolean
  canToggle: boolean
}

/**
 * 根据模型能力和旧设置计算 Chat 思考控件状态。
 *
 * 明确无思考的模型禁用设置；未声明控制档位的模型继续使用旧布尔开关，避免过度推断。
 */
export function resolveChatThinkingControlState(
  input: ResolveChatThinkingControlStateInput,
): ChatThinkingControlState {
  if (!input.capability) {
    return input.knownNonReasoning
      ? {
          mode: 'unsupported',
          levels: [],
          effectiveLevel: undefined,
          enabled: false,
          canToggle: false,
        }
      : {
          mode: 'legacy-toggle',
          levels: [],
          effectiveLevel: undefined,
          enabled: input.legacyEnabled,
          canToggle: true,
        }
  }

  const canToggle = input.capability.levels.includes('off')
  /** 与请求编译器一致：先解释旧关闭开关，再由模型能力归一化强制思考档位。 */
  const requestedLevel = !input.legacyEnabled ? 'off' : input.storedLevel
  const effectiveLevel = normalizeReasoningCapabilityLevel(input.capability, requestedLevel)
    ?? input.capability.defaultLevel

  return {
    mode: 'levels',
    levels: input.capability.levels,
    effectiveLevel,
    enabled: canToggle ? effectiveLevel !== 'off' : true,
    canToggle,
  }
}

interface ChatThinkingPopoverProps {
  provider?: ProviderType
  modelId?: string
}

/**
 * Chat 的思考设置。已知模型显示目录声明的真实档位，未知模型保留原有开关。
 * 设置只写入当前对话 atom，不订阅流式内容或增加 IPC。
 */
export function ChatThinkingPopover({ provider, modelId }: ChatThinkingPopoverProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [thinkingEnabled, setThinkingEnabled] = useConversationThinkingEnabled()
  const [thinkingLevel, setThinkingLevel] = useConversationThinkingLevel()
  /** models.dev 中按供应商和模型精确匹配的原始能力。 */
  const modelCapabilities = getModelCapabilities(provider, modelId)
  /** UI 可安全展示并由运行时编码的思考档位。 */
  const capability = getModelReasoningCapability(provider, modelId)
  /** 当前模型对应的完整控件状态。 */
  const controlState = resolveChatThinkingControlState({
    capability,
    knownNonReasoning: modelCapabilities?.reasoning === false,
    storedLevel: thinkingLevel,
    legacyEnabled: thinkingEnabled,
  })

  /** 切换可选思考模型时同步档位与旧布尔状态。 */
  const handleToggle = React.useCallback((checked: boolean): void => {
    if (!capability) {
      setThinkingEnabled(checked)
      return
    }
    /** 重新开启时恢复模型默认档位，关闭时写入统一的 off。 */
    const nextLevel = checked ? capability.defaultLevel : 'off'
    setThinkingLevel(nextLevel)
    setThinkingEnabled(checked)
  }, [capability, setThinkingEnabled, setThinkingLevel])

  /** 选择档位时同步请求使用的思考开关。 */
  const handleLevelChange = React.useCallback((level: AgentThinkingLevel): void => {
    setThinkingLevel(level)
    setThinkingEnabled(level !== 'off')
  }, [setThinkingEnabled, setThinkingLevel])

  /** 弹层中的状态说明，强制思考与不支持思考使用明确文案。 */
  const statusLabel = controlState.mode === 'unsupported'
    ? '当前模型不支持思考'
    : !controlState.canToggle && controlState.mode === 'levels'
      ? '始终启用'
      : controlState.enabled ? '已启用' : '已关闭'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(inputToolbarButtonClass, controlState.enabled && inputToolbarActiveButtonClass)}
          aria-label="思考设置"
        >
          <Brain className="size-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" sideOffset={8} className="w-56 space-y-3 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{controlState.mode === 'unsupported' ? '无思考' : '思考模式'}</p>
            <p className="text-xs text-muted-foreground">{statusLabel}</p>
          </div>
          {controlState.canToggle && (
            <Switch checked={controlState.enabled} onCheckedChange={handleToggle} aria-label="启用思考模式" />
          )}
        </div>
        {controlState.mode === 'levels' && capability && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">思考深度</p>
            <div className="grid grid-cols-2 gap-1">
              {controlState.levels.map((level) => (
                <Button
                  key={level}
                  type="button"
                  variant={controlState.effectiveLevel === level ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-8 justify-start px-2 text-xs"
                  onClick={() => handleLevelChange(level)}
                >
                  {THINKING_LEVEL_LABELS[level]}
                </Button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              当前模型默认：{THINKING_LEVEL_LABELS[capability.defaultLevel]}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
