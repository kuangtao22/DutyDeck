import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createEmptySceneDefinition } from '@proma/shared'
import type { CapabilityScene, CapabilitySceneDraft } from '@proma/shared'
import { CapabilityFactoryDraftReview } from './CapabilityFactoryDraftReview'

/** 造一个「当前是空模板 v1 + 一份 Agent 草案」的场景，正是 2026-09-28 那次故障的形状。 */
function sceneWithDraft(overrides: { draft?: CapabilitySceneDraft | null } = {}): CapabilityScene {
  const name = '小说角色提取'
  const draft: CapabilitySceneDraft = {
    definition: {
      ...createEmptySceneDefinition(name),
      outputs: [{ name: 'characters', from: { stepId: 'scan' }, shape: 'structured' }],
      steps: [
        {
          id: 'scan', title: '扫描本批人物候选', type: 'extract', modelSlot: 'main',
          prompt: '按段落扫描', judgeFields: [{ name: 'name', type: 'string' }],
        },
      ],
      acceptance: {
        criteria: ['每个角色都必须有段落引用'],
        judgePrompt: '逐条核对证据',
        metrics: [{ name: 'anchorRecall', weight: 1, direction: 'positive' }],
      },
    },
    source: 'agent',
    note: '补齐四步链路',
    createdAt: 1,
  }
  return {
    id: 'scene-1',
    definition: createEmptySceneDefinition(name),
    currentVersion: 1,
    draft: overrides.draft === undefined ? draft : overrides.draft,
    createdAt: 1,
    updatedAt: 2,
  }
}

/** 渲染草案区；不参与断言的交互回调用空实现。 */
function render(overrides: Partial<React.ComponentProps<typeof CapabilityFactoryDraftReview>> = {}): string {
  return renderToStaticMarkup(
    <CapabilityFactoryDraftReview
      scene={sceneWithDraft()}
      busy={false}
      error={null}
      onAdopt={() => undefined}
      onDiscard={() => undefined}
      {...overrides}
    />,
  )
}

describe('待采纳草案区', () => {
  test('Given 没有草案 When 渲染 Then 整块不出现（不摆空壳）', () => {
    expect(render({ scene: sceneWithDraft({ draft: null }) })).toBe('')
  })

  test('Given Agent 写好草案 When 渲染 Then 给出版本与摘要，详情按需展开', () => {
    const html = render()

    expect(html).toContain('草案 v2')
    expect(html).toContain('来自 Agent')
    expect(html).toContain('补齐四步链路')
    expect(html).toContain('3 项改动')
    expect(html).toContain('查看改动')
  })

  test('Given 有草案 When 渲染 Then 同时给出采纳与放弃两个按钮（这是人唯一的决定入口）', () => {
    const html = render()

    expect(html).toContain('采纳 v2')
    expect(html).toContain('放弃草案')
  })

  test('Given 草案内容 When 初次渲染 Then 不把第二份完整流程堆在当前流程上方', () => {
    const html = render()

    expect(html).not.toContain('扫描本批人物候选')
    expect(html).toContain('aria-expanded="false"')
  })

  test('Given 采纳进行中 When 渲染 Then 两个按钮都锁住，避免重复提交', () => {
    const html = render({ busy: true })

    expect(html.match(/ disabled=""/g)?.length).toBe(2)
  })

  test('Given 采纳失败 When 渲染 Then 原因显示在草案区里', () => {
    const html = render({ error: '当前没有待采纳的草案' })

    expect(html).toContain('当前没有待采纳的草案')
    expect(html).toContain('role="alert"')
  })
})
