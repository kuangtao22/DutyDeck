import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createEmptySceneDefinition } from '@proma/shared'
import type { CapabilitySceneVersion } from '@proma/shared'
import { CapabilityFactoryVersionList } from './CapabilityFactoryVersionList'

/** 造一版历史记录。 */
function version(number: number, source: 'agent' | 'human' = 'human'): CapabilitySceneVersion {
  return {
    sceneId: 'scene-1', version: number, source, note: `第 ${number} 版`,
    definition: createEmptySceneDefinition('小说角色提取'),
    createdAt: number * 1000,
  }
}

/** 渲染版本列表。 */
function render(versions: CapabilitySceneVersion[], currentVersion: number): string {
  return renderToStaticMarkup(
    <CapabilityFactoryVersionList
      versions={versions}
      currentVersion={currentVersion}
      busy={false}
      onRequestRollback={() => undefined}
    />,
  )
}

describe('版本历史列表', () => {
  test('Given 有历史 When 渲染 Then 新版本在前、当前版本标注、来源可分辨', () => {
    const html = render([version(1), version(2, 'agent')], 2)

    expect(html).toContain('v2')
    expect(html).toContain('v1')
    expect(html).toContain('当前生效')
    expect(html).toContain('Agent 提出')
    expect(html).toContain('人工')
    /** 最新在前：v2 的出现位置早于 v1。 */
    expect(html.indexOf('v2')).toBeLessThan(html.indexOf('v1'))
  })

  test('Given 非当前版本 When 渲染 Then 给出"回到 vX"，当前版本不给（它不需要回去）', () => {
    const html = render([version(1), version(2), version(3)], 3)

    expect(html).toContain('回到 v1')
    expect(html).toContain('回到 v2')
    expect(html).not.toContain('回到 v3')
  })

  test('Given 版本列表为空 When 渲染 Then 如实说明，而不是空白', () => {
    expect(render([], 1)).toContain('还没有版本历史')
  })

  test('Given 回滚进行中 When 渲染 Then 回滚按钮锁住', () => {
    const html = renderToStaticMarkup(
      <CapabilityFactoryVersionList
        versions={[version(1), version(2)]}
        currentVersion={2}
        busy
        onRequestRollback={() => undefined}
      />,
    )

    /** 取「回到 v1」前面那个 button 标签本身，确认它带 disabled。 */
    const start = html.lastIndexOf('<button', html.indexOf('回到 v1'))
    const buttonTag = html.slice(start, html.indexOf('>', start))
    expect(buttonTag).toContain('disabled=""')
  })
})
