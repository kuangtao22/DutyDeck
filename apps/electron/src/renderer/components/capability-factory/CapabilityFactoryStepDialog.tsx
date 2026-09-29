/** 步骤定义弹窗：只编辑提示词与查看变量来源，执行和记录统一放在运行页。 */
import * as React from 'react'
import { ChevronDown, Save } from 'lucide-react'
import type { CapabilityScene, CapabilitySceneDefinition, Step } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CapabilityFactoryDefinitionDiff } from './CapabilityFactoryDefinitionDiff'
import { findSceneStep, getStepDraftChange, isDraftValueEqual, serializeDraftValue, updateStepPrompt } from './capability-factory-draft-view'
import { describeStepSlots, isPromptStep } from './capability-factory-run-view'

/** 定义表单只接受保存状态，不再接收输入草稿、运行进度和历史记录。 */
export interface CapabilityFactoryStepFormProps {
  scene: CapabilityScene
  step: Step
  saving: boolean
  /** 基线过期时仅禁止提交，仍允许阅读、复制和关闭。 */
  stale?: boolean
  error: string | null
  /** 保存到草案；adopt 为 true 时明确采纳为运行版本。 */
  onSave: (definition: CapabilitySceneDefinition, adopt: boolean) => void
  /** 对比已保存草案后直接采纳，保留草案来源与说明。 */
  onAdoptDraft?: () => void
  onClose: () => void
}

/** 编辑一步的提示词，保留其余场景配置与变量来源。 */
export function CapabilityFactoryStepForm({
  scene, step, saving, stale, error, onSave, onClose, onAdoptDraft,
}: CapabilityFactoryStepFormProps): React.ReactElement {
  /** 编辑以现有草案为基底，不能从旧版本重建并覆盖其他修改。 */
  const baseDefinition = scene.draft?.definition ?? scene.definition
  const editStep = scene.draft ? findSceneStep(baseDefinition, step.id) : step
  const change = getStepDraftChange(scene, step.id)
  /** 未保存内容保留在弹窗中；失败时不重置用户编辑。 */
  const [prompt, setPrompt] = React.useState(editStep && 'prompt' in editStep ? editStep.prompt : '')
  /** 有改动先看差异；无草案时维持原有直接编辑体验。 */
  const [view, setView] = React.useState(change.stepChanged ? 'compare' : 'edit')
  /** 提示词之外的绑定、字段与模型配置也必须能核对。 */
  const [part, setPart] = React.useState<'prompt' | 'config'>(
    (change.before && 'prompt' in change.before ? change.before.prompt : '') !== (change.after && 'prompt' in change.after ? change.after.prompt : '') ? 'prompt' : 'config',
  )
  const idPrefix = React.useId()
  const promptable = editStep !== null && isPromptStep(editStep)
  const slots = describeStepSlots(editStep ?? step)
  /** 未保存编辑同步进入对比，但不会提前变成已采纳版本。 */
  const editedStep = editStep && 'prompt' in editStep ? { ...editStep, prompt } : editStep
  const dirty = !isDraftValueEqual(editStep, editedStep)
  /** 只替换当前步骤的提示词，不改变绑定、模型或其它步骤。 */
  const definitionWithEdits = (): CapabilitySceneDefinition => updateStepPrompt(baseDefinition, step.id, prompt)

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {error ? <p role="alert" className="shrink-0 px-5 pb-3 text-xs leading-relaxed text-destructive">{error}</p> : null}
    {scene.draft ? <div className="shrink-0 space-y-2 px-5 pb-3">
      <Tabs value={view} onValueChange={setView}>
        <TabsList aria-label="步骤版本"><TabsTrigger value="compare">版本对比</TabsTrigger><TabsTrigger value="edit" disabled={!editStep}>编辑草案</TabsTrigger></TabsList>
      </Tabs>
      <p className="text-[11px] text-muted-foreground">当前运行 v{scene.currentVersion} · 草案 v{scene.currentVersion + 1} 尚未采纳{dirty ? ' · 含未保存修改' : ''}。采纳会应用整份场景草案。</p>
    </div> : null}
    {scene.draft && view === 'compare' ? <div className="flex min-h-0 flex-1 flex-col gap-2 px-5 pb-4">
      <Tabs value={part} onValueChange={(value) => setPart(value as 'prompt' | 'config')}>
        <TabsList aria-label="对比内容"><TabsTrigger value="prompt">提示词</TabsTrigger><TabsTrigger value="config">步骤配置</TabsTrigger></TabsList>
      </Tabs>
      <CapabilityFactoryDefinitionDiff currentVersion={scene.currentVersion} fileName={part === 'prompt' ? 'prompt.txt' : 'step.json'}
        before={part === 'prompt' ? change.before && 'prompt' in change.before ? change.before.prompt : '' : serializeDraftValue(change.before ? { position: change.beforePosition, step: change.before } : null)}
        after={part === 'prompt' ? editedStep && 'prompt' in editedStep ? editedStep.prompt : '' : serializeDraftValue(editedStep ? { position: change.afterPosition, step: editedStep } : null)} />
      {!editStep ? <p className="text-xs text-amber-600 dark:text-amber-400">此步骤将在采纳整份草案后移除。</p> : null}
    </div> : <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5">
      {promptable ? <>
        <Label htmlFor={idPrefix + '-prompt'} className="sr-only">提示词</Label>
        <Textarea id={idPrefix + '-prompt'} rows={16} value={prompt} disabled={saving}
          className="min-h-64 resize-y font-mono text-xs leading-6"
          onChange={(event) => setPrompt(event.target.value)} />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          保存并采纳后，在「运行」中提交任务、查看过程和评审结果。
        </p>
        {slots.length > 0 ? <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">变量来源</summary>
          <ul className="mt-2 space-y-1 [overflow-wrap:anywhere]">
            {slots.map((slot) => <li key={slot.name}><code>{'{{' + slot.name + '}}'}</code> · {slot.hint}</li>)}
          </ul>
        </details> : null}
      </> : <>
        <p className="text-xs leading-relaxed text-muted-foreground">
          这一步没有提示词。{editStep?.type === 'tool' ? '关联能力：' + editStep.capabilityId : '并行组的提示词由内部模型步骤定义。'}
        </p>
        {editStep?.type === 'tool' ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-sm bg-muted p-3 font-mono text-[11px]">{JSON.stringify(editStep.bindings, null, 2)}</pre> : null}
      </>}
    </div>}
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/50 px-5 py-4">
      {scene.draft && !dirty && onAdoptDraft ? <Button size="sm" disabled={saving || stale} onClick={onAdoptDraft}>采纳整份草案 v{scene.currentVersion + 1}</Button> : null}
      {promptable && (view === 'edit' || dirty || !scene.draft) ? <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" disabled={saving || stale || prompt.trim().length === 0}>
            <Save aria-hidden="true" />{saving ? '保存中…' : '保存'}<ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-[110]">
          <DropdownMenuItem onSelect={() => onSave(definitionWithEdits(), false)}>保存为草案</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSave(definitionWithEdits(), true)}>{scene.draft ? '保存并采纳整份草案' : '保存并采纳'}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu> : <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onClose}>关闭</Button>}
    </div>
  </div>
}

/** 弹窗仍复用已有草案/采纳接口，不承担运行请求。 */
export interface CapabilityFactoryStepDialogProps {
  open: boolean
  sessionId: string
  scene: CapabilityScene | null
  step: Step | null
  /** 实时清单不可用时保留表单，但不能依据旧状态提交。 */
  unavailable?: boolean
  onSceneChanged: () => void
  onOpenChange: (open: boolean) => void
}

/** 保存成功回到场景；失败时保留提示词并显示原因。 */
export function CapabilityFactoryStepDialog({
  open, sessionId, scene, step, onSceneChanged, onOpenChange, unavailable,
}: CapabilityFactoryStepDialogProps): React.ReactElement {
  return <>{open && scene && step ? <OpenedStepDialog key={`${sessionId}:${scene.id}:${step.id}`} open={open}
    sessionId={sessionId} scene={scene} step={step} unavailable={unavailable} onSceneChanged={onSceneChanged} onOpenChange={onOpenChange} /> : null}</>
}

/** 打开时冻结对比基线；后台刷新不能替换用户正在编辑的内容。 */
function OpenedStepDialog({ open, sessionId, scene, step, onSceneChanged, onOpenChange, unavailable }: CapabilityFactoryStepDialogProps & { scene: CapabilityScene; step: Step }): React.ReactElement {
  const [snapshot] = React.useState(() => structuredClone(scene))
  /** 同毫秒更新也比较完整定义；发现新草案时保留输入并阻止旧内容覆盖。 */
  const stale = unavailable || !isDraftValueEqual([snapshot.currentVersion, snapshot.draft], [scene.currentVersion, scene.draft])
  /** 同步锁防止连续选择保存动作发出重复请求。 */
  const saveLock = React.useRef(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  /** 保存回执仅影响发起请求的会话、场景与步骤。 */
  const target = sessionId + ':' + (scene?.id ?? '') + ':' + (step?.id ?? '')
  const targetRef = React.useRef(target)
  targetRef.current = target
  React.useEffect(() => { setError(null) }, [target, open])

  const save = async (definition: CapabilitySceneDefinition | null, adopt: boolean): Promise<void> => {
    if (saveLock.current || stale) return
    saveLock.current = true
    setSaving(true)
    setError(null)
    try {
      /** 保存锁定打开时的版本；采纳再锁定刚保存的草案，防止中途被替换。 */
      const saved = definition ? await window.electronAPI.capabilityFactory.invoke('saveDraft', {
        sessionId, sceneId: snapshot.id, definition, note: '修改步骤「' + step.title + '」提示词',
        expectedState: { currentVersion: snapshot.currentVersion, draft: snapshot.draft ? { createdAt: snapshot.draft.createdAt, definition: snapshot.draft.definition } : null },
      }) : snapshot
      if (adopt && saved.draft) await window.electronAPI.capabilityFactory.invoke('adoptDraft', {
        sessionId, sceneId: saved.id, expectedVersion: saved.currentVersion,
        expectedDraftCreatedAt: saved.draft.createdAt, expectedDraftDefinition: saved.draft.definition,
      })
      if (targetRef.current !== target) return
      onSceneChanged()
      onOpenChange(false)
    } catch (cause) {
      if (targetRef.current === target) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!next && saving) return; onOpenChange(next) }}>
    <DialogContent className={`flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 ${snapshot.draft ? 'h-[min(780px,85dvh)] max-w-6xl' : 'max-w-3xl'}`}>
      <DialogHeader className="min-w-0 shrink-0 px-5 pb-4 pt-5 pr-12">
        <DialogTitle className="text-base">{step?.title ?? '步骤提示词'}</DialogTitle>
        <DialogDescription className="text-xs">配置这一步的提示词；测试内容与运行记录统一在「运行」中查看。</DialogDescription>
      </DialogHeader>
      <CapabilityFactoryStepForm key={snapshot.id + ':' + step.id}
        scene={snapshot} step={step} saving={saving} stale={stale} error={stale ? '场景或草案已更新。你的输入已保留，请关闭后重新打开，核对新版本再保存。' : error}
        onSave={(definition, adopt) => { void save(definition, adopt) }}
        onAdoptDraft={() => { void save(null, true) }}
        onClose={() => onOpenChange(false)} />
    </DialogContent>
  </Dialog>
}
