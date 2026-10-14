import { describe, expect, test } from 'bun:test'
import { clampRightPanelWidth, getRightPanelMaxWidth, MIN_MAIN_AREA_WIDTH } from './right-panel-layout'

describe('右侧菜单占位与工作区宽度', () => {
  test('Given 最右菜单展开 When 工作区使用可用宽度 Then 给菜单和主区留下独立空间', () => {
    expect(getRightPanelMaxWidth(1280, 61, true, 208)).toBe(691)
    expect(getRightPanelMaxWidth(1280, 61, true, 78)).toBe(821)
  })

  test('Given 窄窗口和分屏下限 When 扣除菜单 Then 内容宽度不突破剩余空间', () => {
    expect(clampRightPanelWidth(720, 900, 720, 241, false, 208)).toBe(131)
    expect(clampRightPanelWidth(720, 580, 720, 241, true, 208)).toBe(0)
  })

  test('Given 用户保存宽度 When 菜单展开再收起 Then 仅暂时夹紧展示宽度', () => {
    /** 保存值保持不变；折叠菜单后恢复用户原宽度。 */
    const preferredWidth = 760
    expect(clampRightPanelWidth(preferredWidth, 1280, 360, 61, true, 208)).toBe(691)
    expect(clampRightPanelWidth(preferredWidth, 1280, 360, 61, true, 78)).toBe(preferredWidth)
    expect(1280 - 61 - 208 - getRightPanelMaxWidth(1280, 61, true, 208)).toBe(MIN_MAIN_AREA_WIDTH)
  })
})
