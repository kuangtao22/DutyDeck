/** 当前场景的流程与评审依据并排展示，两侧均读取已采纳版本。 */
import { Fragment } from 'react'
import type * as React from 'react'
import { getReviewSteps, getStepAcceptance, type CapabilityScene, type Step } from '@proma/shared'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { describeSceneShape } from './capability-factory-run-view'
import { buildSceneStepRows, getStepDraftChange } from './capability-factory-draft-view'

/** 定义页只负责展示；步骤编辑和版本管理仍由宿主处理。 */
interface CapabilityFactorySceneDefinitionProps {
  scene: CapabilityScene
  onSelectStep: (stepId: string) => void
  /** 点击步骤对应的评审卡，打开同样的定义编辑弹窗。 */
  onSelectAcceptance: (stepId: string) => void
  /** 版本历史沿用面板的按需加载与回滚入口。 */
  children?: React.ReactNode
}

/** 从当前场景取出流程和各步骤标准，不把待采纳草案混入当前定义。 */
export function CapabilityFactorySceneDefinition({ scene, onSelectStep, onSelectAcceptance, children }: CapabilityFactorySceneDefinitionProps): React.ReactElement {
  /** 两侧固定指向同一版本，避免流程已更新而评审依据仍显示旧内容。 */
  const { definition, currentVersion } = scene
  /** 复用已有流程体检，避免把 App 全链路误当作提示词编排。 */
  const shape = describeSceneShape(definition)
  /** 评审列表展开并行组内的模型步骤，工具和容器本身不要求内容标准。 */
  const reviewSteps = getReviewSteps(definition.steps)
  /** 把业务流程和对应的评审步骤组成同一组行，避免两列各自计算高度后错位。 */
  const rows = buildSceneStepRows(scene).map(({ step, change }, index) => ({
    step,
    change,
    index,
    reviewSteps: [...getReviewStepsInRow(step), ...getReviewStepsInRow(getStepDraftChange(scene, step.id).after ?? step)
      .filter((item) => !getReviewStepsInRow(step).some((current) => current.id === item.id))],
  }))

  return <div style={{ containerType: 'inline-size', containerName: 'factory-definition' }}>
    <style>{'@container factory-definition (min-width: 700px) { [data-factory-definition-columns], [data-factory-definition-rows], [data-factory-definition-footer] { grid-template-columns: repeat(2, minmax(0, 1fr)); } [data-factory-definition-columns] > :nth-child(even), [data-factory-definition-cell]:nth-child(even), [data-factory-definition-footer] > :nth-child(even) { border-left: 1px solid hsl(var(--border) / 0.6); } }'}</style>
    <div className="min-w-0 overflow-hidden rounded-md border border-border/60">
      <div data-factory-definition-columns className="grid min-w-0 grid-cols-1">
        <header aria-label="业务流程" className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-3">
          <h3 className="text-xs font-medium">业务流程</h3>
          <span className="text-[11px] text-muted-foreground">{definition.steps.length} 步 · v{currentVersion}</span>
        </header>
        <header aria-label="流程评审标准" className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-3">
          <h3 className="text-xs font-medium">流程评审标准</h3>
          <span className="text-[11px] text-muted-foreground">按步骤 · v{currentVersion}</span>
        </header>
      </div>

      <div data-factory-definition-rows className="grid min-w-0 grid-cols-1">
        {rows.length === 0 ? <>
          <div data-factory-definition-cell className="p-3 text-xs text-muted-foreground">还没有步骤，在当前会话中让 Agent 设计流程。</div>
          <div data-factory-definition-cell className="border-t border-border/60 p-3 text-xs text-muted-foreground">还没有可评审的流程步骤。</div>
        </> : rows.map(({ step, change, index, reviewSteps: rowReviewSteps }) => {
          const acceptance = getStepAcceptance(change === 'added' && scene.draft ? scene.draft.definition : definition, step.id)
          /** 纯顺序调整也改变执行语义，不能只标出提示词文本差异。 */
          const positions = getStepDraftChange(scene, step.id)
          return <Fragment key={step.id}>
            <div data-factory-definition-cell className="border-t border-border/60 p-3">
              <div className="rounded-md border border-border/60">
                <Button type="button" variant="outline" onClick={() => onSelectStep(step.id)}
                  className={cn('flex h-auto w-full items-center gap-3 whitespace-normal rounded-b-none border-0 px-3 py-4 text-left font-normal',
                    (step.type === 'llm' || step.type === 'extract') && 'border-l-2 border-l-emerald-500/60')}>
                  <span className="font-mono text-[10px] text-muted-foreground">{index + 1}</span>
                  <span className="min-w-0 flex-1 break-words text-[12.5px]">{step.title}</span>
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Button>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
                  <span>{step.type === 'map' ? '组内模型步骤分别评审' : step.type === 'tool' ? '按工具执行结果校验' : acceptance ? `${acceptance.criteria.length} 条判据 · ${acceptance.metrics.length} 个指标` : '未配置步骤评审'}</span>
                  {change ? <span className="text-amber-600 dark:text-amber-400">{change === 'added' ? '新增' : change === 'removed' ? '待移除' : '新版本'} v{currentVersion + 1} · 待采纳</span> : null}
                  {positions.beforePosition && positions.afterPosition && positions.beforePosition !== positions.afterPosition ? <span>位置 {positions.beforePosition} → {positions.afterPosition}</span> : null}
                </div>
              </div>
            </div>
            <div data-factory-definition-cell className="border-t border-border/60 p-3 [overflow-wrap:anywhere]">
              {rowReviewSteps.length === 0 ? <p className="text-[11px] text-muted-foreground">{reviewSteps.length === 0 ? '还没有可评审的流程步骤。' : step.type === 'tool' ? '工具步骤按执行结果校验，不配置内容评审。' : '该流程没有需要内容评审的模型步骤。'}</p> : <div className="space-y-2">
                {rowReviewSteps.map((reviewStep, reviewIndex) => {
                  /** 新增步骤读取草案摘要；既有步骤仍显示当前标准，改动另作标记。 */
                  const reviewChange = getStepDraftChange(scene, reviewStep.id)
                  const reviewAcceptance = getStepAcceptance(!reviewChange.before && scene.draft ? scene.draft.definition : definition, reviewStep.id)
                  return <div key={reviewStep.id} className="rounded-md border border-border/60">
                    <Button type="button" variant="outline" onClick={() => onSelectAcceptance(reviewStep.id)}
                      className="flex h-auto w-full items-center gap-3 whitespace-normal rounded-b-none border-0 border-l-2 border-l-emerald-500/60 px-3 py-4 text-left font-normal"
                      aria-label={`编辑${reviewStep.title}评审标准`}>
                      <span className="font-mono text-[10px] text-muted-foreground">{step.type === 'map' ? `${index + 1}.${reviewIndex + 1}` : index + 1}</span>
                      <span className="min-w-0 flex-1 break-words text-[12.5px]">{reviewStep.title}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{reviewAcceptance ? '已配置' : '待配置'}</span>
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </Button>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
                      <span>{reviewAcceptance ? `${reviewAcceptance.criteria.length} 条判据 · ${reviewAcceptance.metrics.length} 个指标` : '尚未配置该步骤评审标准。'}</span>
                      {reviewChange.acceptanceChanged ? <span className="text-amber-600 dark:text-amber-400">新版本 v{currentVersion + 1} · 待采纳</span> : null}
                    </div>
                  </div>
                })}
              </div>}
            </div>
          </Fragment>
        })}
      </div>

      <div data-factory-definition-footer className="grid min-w-0 grid-cols-1">
        <div className="border-t border-border/60 p-3">
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button type="button" size="sm" variant="ghost" className="w-full justify-between text-muted-foreground">场景说明<ChevronDown aria-hidden="true" /></Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
              {definition.description ? <p>{definition.description}</p> : null}
              <p>{definition.inputs.length} 个输入 · {shape.modelSteps} 个模型步骤</p>
              {shape.advice ? <p className="text-amber-600 dark:text-amber-400">{shape.advice}</p> : null}
              <p>点击步骤编辑提示词，在运行页验证和对比后采纳。</p>
            </CollapsibleContent>
          </Collapsible>
          {children}
        </div>
        <div className="border-t border-border/60 p-3 text-[11px] leading-5 text-muted-foreground">标准随场景版本保存。修改请在当前会话中提出，采纳后用于后续运行；历史评审保留当时的依据。</div>
      </div>
    </div>
  </div>
}

/** 获取一个业务步骤行中需要展示的模型评审步骤，并展开并行组。 */
function getReviewStepsInRow(step: Step): Array<Extract<Step, { type: 'llm' | 'extract' }>> {
  return step.type === 'map' ? getReviewSteps(step.body)
    : step.type === 'llm' || step.type === 'extract' ? [step] : []
}
