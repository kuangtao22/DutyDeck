import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createEmptySceneDefinition } from '@proma/shared'
import type { CapabilityScene } from '@proma/shared'
import {
  CapabilityFactorySceneRail, formatCapabilitySceneSubtitle,
} from './CapabilityFactorySceneRail'
import type { CapabilitySceneRenameState } from './CapabilityFactorySceneRail'

/** 造一个只有名称与版本的最小场景，测试只关心列表行的呈现。 */
function scene(id: string, name: string, version: number, hasDraft: boolean): CapabilityScene {
  return {
    id,
    definition: createEmptySceneDefinition(name),
    currentVersion: version,
    draft: hasDraft
      ? { definition: createEmptySceneDefinition(name), source: 'agent', note: '改严第 2 步', createdAt: 1 }
      : null,
    createdAt: 1,
    updatedAt: 2,
  }
}

/** 不参与断言的交互态桩，避免每个用例重复写一遍。 */
const rename: CapabilitySceneRenameState = {
  sceneId: null, value: '', onChange: () => undefined,
  onStart: () => undefined, onSubmit: () => undefined, onCancel: () => undefined,
}

/** 渲染抽屉；关闭时必须不产生任何节点。 */
function render(overrides: Partial<React.ComponentProps<typeof CapabilityFactorySceneRail>> = {}): string {
  return renderToStaticMarkup(
    <CapabilityFactorySceneRail
      open
      scenes={[scene('scene-1', '账号状态查询', 4, true)]}
      selectedSceneId="scene-1"
      workspaceLabel="车本本"
      error={null}
      createBusy={false}
      rename={rename}
      onRequestCreate={() => undefined}
      onSelectScene={() => undefined}
      onRequestDelete={() => undefined}
      onOpenChange={() => undefined}
      {...overrides}
    />,
  )
}

describe('编排工厂场景抽屉', () => {
  test('Given 抽屉关闭 When 渲染 Then 不产生任何节点', () => {
    expect(render({ open: false })).toBe('')
  })

  test('Given 抽屉展开 When 渲染 Then 面板与遮罩都在面板容器内绝对定位', () => {
    const html = render()

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="场景列表"')
    /** 关键：容器内绝对定位，而不是通用 Sheet 的 fixed 全窗锚定（否则会飞到窗口最左侧）。 */
    expect(html).toContain('absolute inset-y-0 left-0')
    expect(html).not.toContain('fixed inset-y-0 left-0')
    /** 遮罩可点击关闭；键盘用户还能用 Esc（见组件内的 keydown 监听）。 */
    expect(html).toContain('aria-label="关闭场景列表"')
    /** 与运维抽屉同构的栏头四件套：标题 + 副标题 + 新建 + 收起。 */
    expect(html).toContain('车本本')
    expect(html).toContain('aria-label="新建场景"')
    expect(html).toContain('aria-label="收起场景列表"')
  })

  test('Given 抽屉展开 When 渲染 Then 底部不再挂新建输入行（新建走弹窗）', () => {
    const html = render()

    expect(html).not.toContain('aria-label="新场景名称"')
    expect(html).not.toContain('placeholder="新场景名称"')
  })

  test('Given 有场景 When 渲染 Then 每行给出名称、摘要与行内管理入口', () => {
    const html = render()

    expect(html).toContain('账号状态查询')
    expect(html).toContain('0 步 · v4 · 草案待采纳')
    expect(html).toContain('aria-label="管理场景：账号状态查询"')
  })

  test('Given 清单还在读或读取失败 When 渲染 Then 如实说明，不冒充空列表', () => {
    expect(render({ scenes: null })).toContain('正在读取场景')
    const failed = render({ scenes: [], error: '读取场景失败：磁盘不可写' })
    expect(failed).toContain('读取场景失败：磁盘不可写')
    expect(failed).not.toContain('还没有场景')
  })

  test('Given 正在重命名 When 渲染 Then 该行换成输入框，其余行仍是按钮', () => {
    const html = render({
      scenes: [scene('scene-1', '账号状态查询', 4, false), scene('scene-2', '批量巡检', 1, false)],
      rename: { ...rename, sceneId: 'scene-1', value: '账号状态查询（改）' },
    })

    expect(html).toContain('aria-label="重命名场景：账号状态查询"')
    expect(html).toContain('aria-label="管理场景：批量巡检"')
  })

  test('Given 新建进行中 When 渲染 Then ＋ 被禁用，避免连点开出两个弹窗', () => {
    expect(render({ createBusy: true })).toMatch(/aria-label="新建场景" disabled/)
    expect(render({ createBusy: false })).not.toMatch(/aria-label="新建场景" disabled/)
  })
})

describe('场景行摘要', () => {
  test('草案与版本都要出现在摘要里，方便在列表里一眼分辨待采纳项', () => {
    expect(formatCapabilitySceneSubtitle(scene('scene-1', '账号状态查询', 4, true))).toBe('0 步 · v4 · 草案待采纳')
    expect(formatCapabilitySceneSubtitle(scene('scene-2', '批量巡检', 2, false))).toBe('0 步 · v2')
  })
})
