/** 优化比较纯逻辑由 shared 统一维护；此文件保留 UI 既有导入路径。 */
import { isPromptOnlyOptimization, optimizationKey, sceneStandardsKey } from '@proma/shared'
import type { CapabilityFactoryApi, CapabilitySavedTask, CapabilityScene, OptimizationPair } from '@proma/shared'

export {
  canAdoptOptimization,
  compareOptimizationPair,
  groupOptimizationRuns,
  isAdoptableOptimizationBatch,
  isAdoptableOptimizationComparison,
  isPromptOnlyOptimization,
  optimizationKey,
  sceneStandardsKey,
  type OptimizationPair,
} from '@proma/shared'

/** 顺序执行两版，降低并发调用开销；页面离开后不启动剩余任务。 */
export async function runOptimizationBatch(options: {
  api: CapabilityFactoryApi
  sessionId: string
  scene: CapabilityScene
  tasks: CapabilitySavedTask[]
  onPair: (pair: OptimizationPair) => void
  isActive: () => boolean
}): Promise<void> {
  const { api, sessionId, onPair, isActive } = options
  const scene = structuredClone(options.scene)
  const tasks = structuredClone(options.tasks)
  if (!scene.draft) throw new Error('先在当前会话中让 Agent 提出优化草案。')
  if (sceneStandardsKey(scene) !== optimizationKey(scene.draft.definition.stepAcceptances ?? scene.draft.definition.acceptance)) {
    throw new Error('草案修改了评审标准。请先单独确认标准，再按同一标准重新验证两版；本次不作优化比较。')
  }
  if (optimizationKey(scene.definition.modelSlots) !== optimizationKey(scene.draft.definition.modelSlots)) {
    throw new Error('草案修改了模型配置。提示词优化对比需保持两版模型配置一致。')
  }
  if (!isPromptOnlyOptimization(scene.definition, scene.draft.definition)) {
    throw new Error('草案包含流程或契约改动。提示词优化对比只允许修改模型步骤提示词。')
  }
  if (!tasks.length || tasks.length > 10 || tasks.some((task) => task.sceneId !== scene.id)) {
    throw new Error('请选择当前场景的 1–10 条任务。')
  }
  for (const task of tasks) {
    if (!isActive()) return
    const comparisonId = crypto.randomUUID()
    const baseline = await api.invoke('runScene', {
      sessionId, sceneId: scene.id, input: task.input, target: 'current', expectedVersion: scene.currentVersion,
      comparisonId, comparisonRole: 'baseline',
    })
    if (!isActive()) return
    onPair({ id: comparisonId, baseline })
    if (baseline.status !== 'succeeded' || baseline.sceneVersion !== scene.currentVersion || !baseline.valid) {
      throw new Error(baseline.error ?? '基线执行或格式校验失败，对比已停止。')
    }
    if (baseline.review?.status !== 'succeeded') throw new Error('基线评审未完成，请先处理评审异常，再优化业务提示词。')
    const candidate = await api.invoke('runScene', {
      sessionId, sceneId: scene.id, input: task.input, target: 'draft', expectedVersion: scene.currentVersion,
      expectedDraftCreatedAt: scene.draft.createdAt, comparisonId, comparisonRole: 'candidate',
      expectedDraftDefinition: scene.draft.definition,
    })
    if (!isActive()) return
    onPair({ id: comparisonId, baseline, candidate })
    if (candidate.status !== 'succeeded' || candidate.sceneVersion !== scene.currentVersion || !candidate.valid) {
      throw new Error(candidate.error ?? '候选执行或格式校验失败，对比已停止。')
    }
    if (candidate.review?.status !== 'succeeded') throw new Error('候选评审未完成，结果已保留，请先处理评审异常。')
  }
}
