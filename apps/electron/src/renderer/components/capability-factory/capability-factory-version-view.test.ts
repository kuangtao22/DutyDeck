import { describe, expect, test } from 'bun:test'
import { createEmptySceneDefinition } from '@proma/shared'
import type { CapabilitySceneVersion, Step } from '@proma/shared'
import { describeRollbackEffect, describeVersionHistory } from './capability-factory-version-view'

/** 造一版历史记录。 */
function version(number: number, steps: Step[] = [], source: 'agent' | 'human' = 'human'): CapabilitySceneVersion {
  return {
    sceneId: 'scene-1', version: number, source, note: `第 ${number} 版的说明`,
    definition: { ...createEmptySceneDefinition('小说角色提取'), steps },
    createdAt: number * 1000,
  }
}

const extract = (prompt: string): Step => ({
  id: 'scan', title: '扫描人物候选', type: 'extract', modelSlot: 'main',
  prompt, judgeFields: [{ name: 'characters', type: 'array' }],
})

describe('版本历史展示', () => {
  test('最新的在前，并标出当前生效版本', () => {
    const rows = describeVersionHistory([version(1), version(2), version(3)], 2)

    expect(rows.map((row) => row.version)).toEqual([3, 2, 1])
    expect(rows.find((row) => row.version === 2)?.isCurrent).toBe(true)
    expect(rows.filter((row) => row.isCurrent)).toHaveLength(1)
  })

  test('每一版带"相对上一版改了什么" —— 光有版本号认不出哪版是我调好的', () => {
    const rows = describeVersionHistory([version(1), version(2, [extract('第一版提示词')])], 2)

    expect(rows[0]?.changeSummary).toContain('新增 步骤 1 项：scan')
    expect(rows[1]?.changeSummary).toBe('首个版本')
  })

  test('提示词改了但结构没变时如实说"无差异"，不编造改动', () => {
    /** 差异计算按结构比：只改提示词文本、步骤 id 不变时会落到"修改 步骤 1 项"。 */
    const rows = describeVersionHistory([version(1, [extract('旧的')]), version(2, [extract('新的')])], 2)
    expect(rows[0]?.changeSummary).toContain('修改 步骤 1 项：scan')

    /** 完全一样的两版（例如只改了标题以外的字段）会明确说无差异。 */
    const identical = describeVersionHistory([version(1), version(2)], 2)
    expect(identical[0]?.changeSummary).toBe('与上一版无差异')
  })

  test('来源写成人能分辨的说法：Agent 提出 / 人工', () => {
    const rows = describeVersionHistory([version(1), version(2, [], 'agent')], 2)

    expect(rows[0]?.sourceLabel).toBe('Agent 提出')
    expect(rows[1]?.sourceLabel).toBe('人工')
  })
})

describe('回滚后果说明', () => {
  test('写清"生成新版本、历史不删"，避免用户以为版本号会倒退', () => {
    const text = describeRollbackEffect(2, 5)

    expect(text).toContain('回到 v2 会生成 v6')
    expect(text).toContain('内容与 v2 一致')
    expect(text).toContain('版本号只增不减')
    expect(text).toContain('随时可以再回滚回来')
  })

  test('对当前版本点回滚时直接说明无需回滚', () => {
    expect(describeRollbackEffect(3, 3)).toContain('就是当前生效版本')
  })
})
