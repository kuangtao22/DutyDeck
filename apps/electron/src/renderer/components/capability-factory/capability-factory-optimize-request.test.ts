import { expect, test } from 'bun:test'
import type { CapabilityRun } from '@proma/shared'
import { buildOptimizationRequest, canRequestOptimization } from './capability-factory-optimize-request'

/** 仅填优化入口依赖的运行事实，原始正文不应复制到会话草稿。 */
const run: CapabilityRun = { id: 'run-7', sceneId: 'scene-2', sceneVersion: 3, kind: 'full', status: 'succeeded', valid: true,
  input: { text: '整篇私有正文' }, outputs: {}, steps: [], startedAt: 1, finishedAt: 2,
  review: { status: 'succeeded', passed: false, summary: '证据不足', acceptance: { criteria: ['有证据'], judgePrompt: '核对证据', metrics: [] }, criteria: [], metrics: [], suggestions: [], startedAt: 2, finishedAt: 3 },
}

test('Given 一次真实评审 When 请求优化 Then 固定记录身份、同标准测试与人工采纳，不重复粘贴大正文', () => {
  expect(canRequestOptimization(run)).toBe(true)
  const prompt = buildOptimizationRequest('角色提取', run)
  for (const text of ['角色提取', 'scene-2', 'run-7', 'v3', 'factory_list_runs', 'factory_get_run', '评审标准', '候选草案', '不要采纳', '找不到', '错误近似原文', '计算公式、阈值或标注来源']) expect(prompt).toContain(text)
  expect(prompt).not.toContain('整篇私有正文')
})

test('Given 评审失败、未完成、占位或格式失败 When 展示 Then 不把它当作提示词优化依据', () => {
  for (const record of [
    { ...run, review: undefined }, { ...run, valid: false }, { ...run, placeholderCapabilities: ['empty'] },
    ...(['running', 'failed', 'skipped'] as const).map((status) => ({ ...run, review: { ...run.review!, status } })),
  ]) expect(canRequestOptimization(record)).toBe(false)
})
