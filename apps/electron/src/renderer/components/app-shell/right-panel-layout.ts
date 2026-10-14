export const RIGHT_PANEL_MAX_VIEWPORT_RATIO = 3 / 5
export const MIN_MAIN_AREA_WIDTH = 320

export function getRightPanelMaxWidth(
  viewportWidth: number,
  leftSidebarOccupiedWidth: number,
  allowFullAvailableWidth = false,
  /** 最右菜单独立占位，不得被工作区或原生浏览器覆盖。 */
  toolsMenuWidth = 0,
): number {
  const availableWidth = viewportWidth - leftSidebarOccupiedWidth - toolsMenuWidth - MIN_MAIN_AREA_WIDTH
  return Math.max(
    0,
    allowFullAvailableWidth
      ? availableWidth
      : Math.min(
        Math.floor(viewportWidth * RIGHT_PANEL_MAX_VIEWPORT_RATIO),
        availableWidth,
      ),
  )
}

export function clampRightPanelWidth(
  width: number,
  viewportWidth: number,
  minimumWidth: number,
  leftSidebarOccupiedWidth: number,
  allowFullAvailableWidth = false,
  /** 菜单展开只限制当前展示宽度，不改变会话保存的偏好。 */
  toolsMenuWidth = 0,
): number {
  const maximumWidth = getRightPanelMaxWidth(
    viewportWidth,
    leftSidebarOccupiedWidth,
    allowFullAvailableWidth,
    toolsMenuWidth,
  )
  const effectiveMinimumWidth = Math.min(minimumWidth, maximumWidth)
  return Math.max(effectiveMinimumWidth, Math.min(maximumWidth, width))
}
