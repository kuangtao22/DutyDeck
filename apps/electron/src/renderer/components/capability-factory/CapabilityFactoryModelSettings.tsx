/** 场景模型设置：按槽位选择渠道模型，评审可独立指定；选择只影响工厂场景。 */
import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertCircle, LoaderCircle, SlidersHorizontal } from 'lucide-react'
import { channelsAtom, channelsLoadedAtom } from '@/atoms/chat-atoms'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import type { CapabilityFactoryModelReference, CapabilityScene } from '@proma/shared'
import { ModelSelector } from '@/components/chat/ModelSelector'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SettingsCard, SettingsSection } from '@/components/settings/primitives'
import { updateFactoryModelSelection, type FactoryModelTarget } from './capability-factory-model-selection'

/** 场景模型设置的会话范围与刷新回调。 */
interface CapabilityFactoryModelSettingsProps {
  sessionId: string
  scene: CapabilityScene
  onSceneChanged: () => void | Promise<void>
}

/** 场景模型选择入口；输入场景快照，保存后刷新列表并显式展示失败。 */
export function CapabilityFactoryModelSettings({ sessionId, scene, onSceneChanged }: CapabilityFactoryModelSettingsProps): React.ReactElement {
  /** 弹窗按场景保留开关状态，保存产生新版本时仍保持打开。 */
  const [open, setOpen] = React.useState(false)
  /** 多个工厂面板各自独立的字段标识，用于标签与模型选择按钮关联。 */
  const formId = React.useId()
  /** 渠道状态用于展示已删除或禁用的模型，不静默切换模型。 */
  const channels = useAtomValue(channelsAtom)
  const channelsLoaded = useAtomValue(channelsLoadedAtom)
  /** 打开既有渠道设置入口，不增加第二套配置流程。 */
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  /** 任一启用渠道存在启用模型时即可选择。 */
  const hasModels = channels.some((channel) => channel.enabled && channel.models.some((model) => model.enabled))
  /** 保存时禁止重复提交，避免连续选择基于同一个旧版本。 */
  const [saving, setSaving] = React.useState(false)
  /** 服务端错误保留在设置区域，不清空用户原有配置。 */
  const [error, setError] = React.useState<string | null>(null)
  /** 卸载后忽略旧请求；面板按会话与场景设置组件 key，切换场景时关闭弹窗。 */
  const mounted = React.useRef(true)
  /** 同步请求锁阻止 React 状态提交前的重复点击。 */
  const inFlight = React.useRef(false)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  /** 根据目标更新完整选择，带版本与草案快照保存；null 恢复默认规则。 */
  async function save(target: FactoryModelTarget, reference: CapabilityFactoryModelReference | null): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      await window.electronAPI.capabilityFactory.invoke('setModelSelection', {
        sessionId, sceneId: scene.id,
        selection: updateFactoryModelSelection(scene.definition.modelSelection, target, reference),
        expectedState: {
          currentVersion: scene.currentVersion,
          draft: scene.draft ? { createdAt: scene.draft.createdAt, definition: scene.draft.definition } : null,
        },
      })
      if (mounted.current) await onSceneChanged()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inFlight.current = false
      if (mounted.current) setSaving(false)
    }
  }

  /** 按设置页字段布局渲染标签、说明与受控选择器；默认规则只用于展示，保存仍带完整引用。 */
  function renderSelection(target: FactoryModelTarget, selected: CapabilityFactoryModelReference | undefined, label: string, description: string, defaultLabel: string): React.ReactElement {
    /** 标签关联到本场景的具体选择按钮，保留键盘和读屏访问能力。 */
    const fieldId = `${formId}-${'slotId' in target ? `slot-${target.slotId}` : 'review'}`
    /** 只有列表加载完成后才判断引用失效，避免加载过程误报。 */
    const unavailable = channelsLoaded && selected && !channels.some((channel) => channel.id === selected.channelId && channel.enabled && channel.models.some((model) => model.id === selected.modelId && model.enabled))
    return (
      <div className="min-w-0 space-y-3 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={fieldId} className="min-w-0 break-words">{label}</Label>
          {selected ? <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 px-1.5 text-muted-foreground" onClick={() => { void save(target, null) }}>{defaultLabel}</Button> : null}
        </div>
        <ModelSelector
          key={selected ? `${selected.channelId}:${selected.modelId}` : 'default'}
          externalSelectedModel={selected ?? null}
          onModelSelect={(option) => { void save(target, { channelId: option.channelId, modelId: option.modelId }) }}
          showChannelInTrigger
          triggerVariant="form"
          triggerId={fieldId}
          placeholder={selected ? selected.modelId : defaultLabel}
        />
        <p className="break-words text-xs leading-5 text-muted-foreground">{description}</p>
        {unavailable ? <p role="status" className="text-xs leading-5 text-destructive">所选渠道或模型已不可用，请重新选择（{selected.modelId}）</p> : null}
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      // 保存结束前保留弹窗，确保错误可见且不能基于旧版本再次打开提交。
      if (inFlight.current) return
      setError(null)
      setOpen(nextOpen)
    }}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1.5 border-border/60 bg-background/40 px-2 text-xs font-normal">
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          模型设置
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0" hideClose={saving}>
        <DialogHeader className="shrink-0 px-5 pb-4 pt-5 pr-12 text-left">
          <DialogTitle className="text-base">模型设置</DialogTitle>
          <DialogDescription className="break-words text-xs leading-5">
            {scene.definition.name} · 为运行与评审选择模型。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-5 overflow-y-auto px-5 pb-5">
          {channelsLoaded && !hasModels ? (
            <SettingsCard>
              <div className="space-y-2 px-4 py-3 text-sm text-muted-foreground">
                <p>暂无可用模型，请先启用渠道和模型。</p>
                <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => {
                  // 离开工厂弹窗后打开渠道配置，避免旧模态层挡住设置页。
                  setOpen(false)
                  setSettingsTab('channels')
                  setSettingsOpen(true)
                }}>配置渠道</Button>
              </div>
            </SettingsCard>
          ) : null}
          <TooltipProvider>
            <fieldset disabled={saving} aria-busy={saving} className="min-w-0 space-y-5 disabled:opacity-60">
              <SettingsSection title="运行模型">
                <SettingsCard>
                  {scene.definition.modelSlots.map((slot) => (
                    <React.Fragment key={slot.id}>
                      {renderSelection(
                        { slotId: slot.id }, scene.definition.modelSelection?.slots[slot.id],
                        slot.description && slot.description !== slot.id ? slot.description : slot.id === 'main' ? '主模型' : slot.id,
                        `自动匹配时优先使用 ${slot.model}，未匹配时使用会话模型。`, '自动匹配',
                      )}
                    </React.Fragment>
                  ))}
                  {scene.definition.modelSlots.length === 0 ? <p className="px-4 py-3 text-sm text-muted-foreground">添加模型步骤后，可在这里选择运行模型。</p> : null}
                </SettingsCard>
              </SettingsSection>
              <SettingsSection title="评审模型">
                <SettingsCard>
                  {renderSelection({ review: true }, scene.definition.modelSelection?.review, '评审使用的模型', '默认跟随对应步骤的运行模型，也可以单独指定。', '跟随运行模型')}
                </SettingsCard>
              </SettingsSection>
            </fieldset>
          </TooltipProvider>
          {error ? <Alert variant="destructive"><AlertCircle className="size-4" /><AlertDescription>{error}</AlertDescription></Alert> : null}
        </div>
        <DialogFooter className="shrink-0 items-center gap-3 border-t border-border/40 px-5 py-4 sm:justify-between sm:space-x-0">
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {saving ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            {saving ? '正在保存模型设置…' : '选择后立即保存为新版本'}
          </p>
          <DialogClose asChild><Button type="button" size="sm" disabled={saving}>完成</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
