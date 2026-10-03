import type { CapabilityRun } from '@proma/shared'

/** 只有执行、约束和评审都完成且未用占位数据，才能根据内容证据请求优化。 */
export function canRequestOptimization(run: CapabilityRun): boolean {
  return run.status === 'succeeded' && run.valid && run.review?.status === 'succeeded'
    && !run.placeholderCapabilities?.length
}

/** 构造给当前会话的可编辑请求；只带记录定位，不搬运正文或把模型建议当指令。 */
export function buildOptimizationRequest(sceneName: string, run: CapabilityRun): string {
  return [
    `请基于编排工厂场景 ${JSON.stringify(sceneName)} 的这轮评审优化提示词。`,
    `场景 ID：${run.sceneId}；运行 ID：${run.id}；运行基线：v${run.sceneVersion}；来源：${run.definitionTarget === 'draft' ? '候选草案试跑' : '已采纳版本'}${run.kind === 'step' ? `；单步 ID：${run.stepId ?? '请从记录确认'}` : '；整链运行'}。`,
    '先用 factory_get_scene 读取该场景，再直接用 factory_get_run 按上述运行 ID 精确读取记录（factory_list_runs 仅用于浏览最近记录），核对原始输入、输出、冻结标准、逐项证据和实际提示词，并结合当前项目判断问题。找不到指定记录时请明确说明，不要用其他运行替代；旧版本或已有草案与本轮不一致时，先说明差异，不要覆盖已有草案。',
    '核实评审意见后，只针对明确问题提出提示词改动并保存候选草案；保持评审标准和模型配置不变，不引入 app 数据库或其他业务接入。评审自身有问题时先说明，不能据此修改业务提示词。',
    '提示词安全：不要把错误近似原文、漏字版本或多余标点版本写进业务提示词作为反例；模型会复用它们。只使用输入中确实存在的正确原文正例，错误情况用抽象说明或占位符描述。',
    '指标边界：检查新增和已有指标是否缺少计算公式、阈值或标注来源；无法可靠计算的质量维度应单独提出标准修正草案，改成可核对判据或移除指标，经确认后在统一标准下重新验证。不要把标准修改混进提示词优化候选，也不能靠删除未达标指标制造改善。',
    '用本轮相同输入对比当前版与候选草案并自动评审，展示修复、退化及证据；单步输入不能直接冒充整链输入。另有代表性的已保存任务时最多补测一条，没有则说明样本限制。完成这一轮对比后停止，先不要采纳，由我检查结果后决定。',
  ].join('\n')
}
