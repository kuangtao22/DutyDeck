/** 步骤评审标准弹窗：编辑判据、评审提示词与质量指标，并沿用场景版本保存。 */
import * as React from 'react'
import { ChevronDown, Plus, Save, Trash2 } from 'lucide-react'
import { getReviewSteps, getStepAcceptance, type CapabilityScene, type CapabilitySceneDefinition, type SceneAcceptance, type SceneMetric } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CapabilityFactoryDefinitionDiff } from './CapabilityFactoryDefinitionDiff'
import { findSceneStep, getStepDraftChange, isDraftValueEqual, serializeDraftValue } from './capability-factory-draft-view'

/** 评审编辑弹窗属性。 */
export interface CapabilityFactoryAcceptanceDialogProps {
  open: boolean
  sessionId: string
  scene: CapabilityScene | null
  stepId: string | null
  /** 清单不可用时保留正在编辑的内容，并禁用保存。 */
  unavailable?: boolean
  onSceneChanged: () => void
  onOpenChange: (open: boolean) => void
}

/** 表单中的指标草稿保留字符串权重，允许用户先清空再输入新值。 */
interface MetricDraft {
  name: string
  weight: string
  direction: SceneMetric['direction']
}

/** 评审规则编辑表单，提交时再清理空行并转换指标权重。 */
export interface CapabilityFactoryAcceptanceFormProps {
  scene: CapabilityScene
  stepId: string
  acceptance: SceneAcceptance | null
  saving: boolean
  /** 基线变化只禁止提交，不把冲突误显示为正在保存。 */
  stale?: boolean
  error: string | null
  onSave: (definition: CapabilitySceneDefinition, adopt: boolean) => void
  onClose: () => void
  /** 向对比页回传未保存修改；null 表示表单已恢复初始内容。 */
  onDraftChange?: (definition: CapabilitySceneDefinition | null) => void
}

/** 复制一份旧规则到表单，避免直接修改当前生效版本。 */
function initialMetricDrafts(acceptance: SceneAcceptance | null): MetricDraft[] {
  return acceptance?.metrics.map((metric) => ({
    name: metric.name,
    weight: String(metric.weight),
    direction: metric.direction,
  })) ?? []
}

/** 为旧场景补齐每个模型步骤的顶层评审标准，避免首次编辑一步时丢掉其它步骤的兼容规则。 */
function explicitStepAcceptances(scene: CapabilityScene): Record<string, SceneAcceptance> {
  const current = { ...(scene.definition.stepAcceptances ?? {}) }
  if (scene.definition.stepAcceptances !== undefined) return current
  for (const step of getReviewSteps(scene.definition.steps)) {
    const acceptance = getStepAcceptance(scene.definition, step.id)
    if (acceptance) current[step.id] = structuredClone(acceptance)
  }
  return current
}

/** 评审标准编辑内容。 */
export function CapabilityFactoryAcceptanceForm({
  scene, stepId, acceptance, saving, stale, error, onSave, onClose, onDraftChange,
}: CapabilityFactoryAcceptanceFormProps): React.ReactElement {
  /** 空标准保留一个可直接填写的判据行，减少首次配置的理解成本。 */
  const [criteria, setCriteria] = React.useState<string[]>(() => acceptance?.criteria.length ? [...acceptance.criteria] : [''])
  const [judgePrompt, setJudgePrompt] = React.useState(() => acceptance?.judgePrompt ?? '')
  const [metrics, setMetrics] = React.useState<MetricDraft[]>(() => initialMetricDrafts(acceptance))
  /** 本地表单校验错误，不覆盖主进程返回的保存错误。 */
  const [validationError, setValidationError] = React.useState<string | null>(null)
  const idPrefix = React.useId()
  /** 初始值只用于识别用户编辑，避免首次打开就生成新草案。 */
  const initialFormState = React.useRef(JSON.stringify([criteria, judgePrompt, metrics]))

  /** 把当前表单转换为场景定义，并只改当前步骤的评审标准。 */
  const definitionWithEdits = (): CapabilitySceneDefinition => {
    const stepAcceptances = explicitStepAcceptances(scene)
    stepAcceptances[stepId] = {
      criteria: criteria.map((item) => item.trim()).filter(Boolean),
      judgePrompt: judgePrompt.trim(),
      metrics: metrics
        .map((metric) => ({
          name: metric.name.trim(),
          weight: Number(metric.weight),
          direction: metric.direction,
        }))
        .filter((metric) => metric.name.length > 0 && Number.isFinite(metric.weight) && metric.weight >= 0 && metric.weight <= 1),
    }
    return { ...scene.definition, stepAcceptances }
  }

  React.useEffect(() => {
    onDraftChange?.(JSON.stringify([criteria, judgePrompt, metrics]) === initialFormState.current ? null : definitionWithEdits())
  }, [criteria, judgePrompt, metrics, scene, stepId, onDraftChange])

  /** 校验指标权重后提交，避免无效数字被静默丢弃。 */
  const submit = (adopt: boolean): void => {
    const invalid = metrics.find((metric) => metric.name.trim() && (!Number.isFinite(Number(metric.weight)) || Number(metric.weight) < 0 || Number(metric.weight) > 1))
    if (invalid) {
      setValidationError('指标权重必须是 0 到 1 之间的数字。')
      return
    }
    setValidationError(null)
    onSave(definitionWithEdits(), adopt)
  }

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5">
      {(validationError ?? error) ? <p role="alert" className="text-xs leading-relaxed text-destructive">{validationError ?? error}</p> : null}

      <section className="space-y-2" aria-labelledby={`${idPrefix}-criteria-heading`}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 id={`${idPrefix}-criteria-heading`} className="text-xs font-medium">判据</h3>
            <p className="mt-1 text-[11px] text-muted-foreground">每条都应能从模型输出中判断通过、未通过或待确认。</p>
          </div>
          <Button type="button" size="sm" variant="ghost" disabled={saving || criteria.length >= 32}
            onClick={() => setCriteria((current) => [...current, ''])}>
            <Plus className="size-3.5" aria-hidden="true" />添加
          </Button>
        </div>
        <div className="space-y-2">
          {criteria.map((criterion, index) => <div key={`${idPrefix}-criterion-${index}`} className="flex items-start gap-2">
            <Input aria-label={`判据 ${index + 1}`} value={criterion} disabled={saving}
              placeholder="例如：每个角色都必须有原文证据"
              onChange={(event) => setCriteria((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} />
            <Button type="button" size="icon" variant="ghost" aria-label={`删除判据 ${index + 1}`} disabled={saving || criteria.length <= 1}
              onClick={() => setCriteria((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          </div>)}
        </div>
      </section>

      <section className="space-y-2" aria-labelledby={`${idPrefix}-prompt-heading`}>
        <Label id={`${idPrefix}-prompt-heading`} htmlFor={`${idPrefix}-judge-prompt`} className="text-xs font-medium">评审提示词</Label>
        <Textarea id={`${idPrefix}-judge-prompt`} value={judgePrompt} disabled={saving} rows={6}
          className="resize-y font-mono text-xs leading-5"
          placeholder="说明评审模型如何核对这一步的输出、证据和边界。"
          onChange={(event) => setJudgePrompt(event.target.value)} />
      </section>

      <section className="space-y-2" aria-labelledby={`${idPrefix}-metrics-heading`}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 id={`${idPrefix}-metrics-heading`} className="text-xs font-medium">指标</h3>
            <p className="mt-1 text-[11px] text-muted-foreground">可选，用于观察质量趋势；权重范围 0 到 1。</p>
          </div>
          <Button type="button" size="sm" variant="ghost" disabled={saving || metrics.length >= 16}
            onClick={() => setMetrics((current) => [...current, { name: '', weight: '1', direction: 'positive' }])}>
            <Plus className="size-3.5" aria-hidden="true" />添加
          </Button>
        </div>
        {metrics.length === 0 ? <p className="rounded-md border border-dashed border-border/70 px-3 py-3 text-[11px] text-muted-foreground">暂未配置指标。</p> : <div className="space-y-2">
          {metrics.map((metric, index) => <div key={`${idPrefix}-metric-${index}`} className="grid grid-cols-[minmax(0,1fr)_72px_108px_auto] items-center gap-2">
            <Input aria-label={`指标 ${index + 1} 名称`} value={metric.name} disabled={saving} placeholder="指标名称"
              onChange={(event) => setMetrics((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} />
            <Input aria-label={`指标 ${index + 1} 权重`} type="number" min="0" max="1" step="0.1" value={metric.weight} disabled={saving}
              onChange={(event) => setMetrics((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, weight: event.target.value } : item))} />
            <Select value={metric.direction} disabled={saving} onValueChange={(direction: SceneMetric['direction']) => setMetrics((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, direction } : item))}>
              <SelectTrigger aria-label={`指标 ${index + 1} 方向`} className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="positive">越高越好</SelectItem><SelectItem value="negative">越低越好</SelectItem></SelectContent>
            </Select>
            <Button type="button" size="icon" variant="ghost" aria-label={`删除指标 ${index + 1}`} disabled={saving}
              onClick={() => setMetrics((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          </div>)}
        </div>}
      </section>
    </div>
    <div className="flex shrink-0 items-center justify-end border-t border-border/50 px-5 py-4">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>取消</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" disabled={saving || stale}>
              <Save className="size-3.5" aria-hidden="true" />{saving ? '保存中…' : '保存'}<ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-[110]">
            <DropdownMenuItem onSelect={() => submit(false)}>保存为草案</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => submit(true)}>{scene.draft ? '保存并采纳整份草案' : '保存并采纳'}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  </div>
}

/** 评审标准弹窗：保存后沿用场景草案与人工采纳机制。 */
export function CapabilityFactoryAcceptanceDialog({
  open, sessionId, scene, stepId, onSceneChanged, onOpenChange, unavailable,
}: CapabilityFactoryAcceptanceDialogProps): React.ReactElement {
  return <>{open && scene && stepId ? <OpenedAcceptanceDialog key={`${sessionId}:${scene.id}:${stepId}`} open={open}
    sessionId={sessionId} scene={scene} stepId={stepId} unavailable={unavailable} onSceneChanged={onSceneChanged} onOpenChange={onOpenChange} /> : null}</>
}

/** 编辑期间固定当前版与草案，不让面板轮询覆盖未保存表单。 */
function OpenedAcceptanceDialog({ open, sessionId, scene, stepId, onSceneChanged, onOpenChange, unavailable }: CapabilityFactoryAcceptanceDialogProps & { scene: CapabilityScene; stepId: string }): React.ReactElement {
  const [snapshot] = React.useState(() => structuredClone(scene))
  const stale = unavailable || !isDraftValueEqual([snapshot.currentVersion, snapshot.draft], [scene.currentVersion, scene.draft])
  /** 草案编辑使用完整草案作为基底，保留业务提示词等并行修改。 */
  const editScene = React.useMemo(() => ({ ...snapshot, definition: snapshot.draft?.definition ?? snapshot.definition }), [snapshot])
  /** 切回对比时保留并显示用户尚未保存的评审编辑。 */
  const [acceptanceEdits, setAcceptanceEdits] = React.useState<CapabilitySceneDefinition | null>(null)
  const change = getStepDraftChange(snapshot, stepId)
  const [view, setView] = React.useState(change.acceptanceChanged ? 'compare' : 'edit')
  /** 同一弹窗只允许一个保存请求，避免草案版本被连续点击覆盖。 */
  const saveLock = React.useRef(false)
  /** 保存中状态用于锁定表单和阻止关闭。 */
  const [saving, setSaving] = React.useState(false)
  /** 主进程保存失败的可读原因。 */
  const [error, setError] = React.useState<string | null>(null)
  /** 用会话、场景和步骤隔离异步回执，避免切换后污染新弹窗。 */
  const target = sessionId + ':' + (scene?.id ?? '') + ':' + (stepId ?? '')
  const targetRef = React.useRef(target)
  targetRef.current = target
  React.useEffect(() => { setError(null) }, [target, open])

  /** 当前点击的模型步骤；工具步骤不会进入评审编辑弹窗。 */
  const step = findSceneStep(editScene.definition, stepId)
  /** 删除的步骤仍有旧标题和标准可用于差异查看，但不能重新编辑。 */
  const title = step?.title ?? change.before?.title ?? '流程评审标准'
  /** 当前步骤的已采纳评审标准，旧场景由共享兼容函数回退顶层标准。 */
  const acceptance = step ? getStepAcceptance(editScene.definition, stepId) : null

  /** 保存为草案或保存并采纳，沿用步骤提示词弹窗的版本闭环。 */
  const save = async (definition: CapabilitySceneDefinition | null, adopt: boolean): Promise<void> => {
    if (saveLock.current || stale) return
    saveLock.current = true
    setSaving(true)
    setError(null)
    try {
      const saved = definition ? await window.electronAPI.capabilityFactory.invoke('saveDraft', {
        sessionId, sceneId: snapshot.id, definition, note: `修改步骤「${title}」评审标准`,
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
        <DialogTitle className="text-base">{title} · 评审标准</DialogTitle>
        <DialogDescription className="text-xs">修改这一步的评审依据；保存后生成场景草案，运行时按步骤独立评审。</DialogDescription>
      </DialogHeader>
      {snapshot.draft ? <div className="shrink-0 space-y-2 px-5 pb-3">
        <Tabs value={view} onValueChange={setView}><TabsList aria-label="评审标准版本"><TabsTrigger value="compare">版本对比</TabsTrigger><TabsTrigger value="edit" disabled={!step}>编辑草案</TabsTrigger></TabsList></Tabs>
        <p className="text-[11px] text-muted-foreground">当前 v{snapshot.currentVersion} → 草案 v{snapshot.currentVersion + 1}{acceptanceEdits ? ' · 含未保存修改' : ' · 待采纳'}。采纳会应用整份场景草案。</p>
      </div> : null}
      {snapshot.draft && view === 'compare' ? <>
        {(stale || error) ? <p role="alert" className="px-5 pb-3 text-xs text-destructive">{stale ? '场景或草案已更新，请关闭后重新打开，核对新版本再保存。' : error}</p> : null}
        <div className="flex min-h-0 flex-1 flex-col px-5 pb-4">
          <CapabilityFactoryDefinitionDiff currentVersion={snapshot.currentVersion} fileName="acceptance.json"
            before={serializeDraftValue(change.before ? getStepAcceptance(snapshot.definition, stepId) : null)} after={serializeDraftValue(acceptanceEdits ? getStepAcceptance(acceptanceEdits, stepId) : acceptance)} />
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border/50 px-5 py-4">
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>关闭</Button>
          {acceptanceEdits ? <Button size="sm" variant="outline" onClick={() => setView('edit')}>返回编辑并保存</Button> : null}
          <Button size="sm" disabled={saving || stale || Boolean(acceptanceEdits)} onClick={() => { void save(null, true) }}>采纳整份草案 v{snapshot.currentVersion + 1}</Button>
        </div>
      </> : null}
      <div className={snapshot.draft && view === 'compare' ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
      {step ? <CapabilityFactoryAcceptanceForm key={target} scene={editScene} stepId={stepId}
        acceptance={acceptance} saving={saving} stale={stale} error={stale ? '场景或草案已更新。你的输入已保留，请关闭后重新打开，核对新版本再保存。' : error}
        onSave={(definition, adopt) => { void save(definition, adopt) }}
        onDraftChange={setAcceptanceEdits}
        onClose={() => onOpenChange(false)} /> : null}
      </div>
    </DialogContent>
  </Dialog>
}
