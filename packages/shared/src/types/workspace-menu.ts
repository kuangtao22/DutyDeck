/** 右侧工作区应用菜单使用的 IPC 通道。 */
export const WORKSPACE_MENU_IPC_CHANNELS = {
  SHOW: 'workspace-menu:show',
  SELECT: 'workspace-menu:select',
  DISMISS: 'workspace-menu:dismiss',
  UPDATE: 'workspace-menu:update',
  READY: 'workspace-menu:ready',
} as const

/** 主进程允许展示并回传的工作区菜单操作。 */
export const WORKSPACE_MENU_ACTION_IDS = [
  'new-browser-tab',
  'open-file',
  'new-terminal',
  'open-todos',
  'open-calendar',
  'open-skills',
  'open-mcp',
  'open-memory',
  'open-chat',
  'open-automations',
  'open-vault',
  'open-canvas',
  'open-server-ops',
  'open-api-workbench',
  'open-capability-factory',
] as const

export type WorkspaceMenuActionId = typeof WORKSPACE_MENU_ACTION_IDS[number]

/** 一个 renderer 菜单项，separator 用于保留既有功能分组。 */
export type WorkspaceMenuEntryInput =
  | { type: 'separator' }
  | { type: 'item'; id: WorkspaceMenuActionId; label: string; disabled?: boolean }

/** 从 renderer 请求展示应用样式工作区菜单的位置与内容。 */
export interface ShowWorkspaceMenuInput {
  /** 触发按钮右边缘相对主窗口内容区的横坐标，单位为 CSS 像素。 */
  x: number
  /** 触发按钮下边缘相对主窗口内容区的纵坐标，单位为 CSS 像素。 */
  y: number
  entries: WorkspaceMenuEntryInput[]
}

/** 验证菜单操作 ID，避免 renderer 把任意字符串作为主进程菜单动作回传。 */
export function isWorkspaceMenuActionId(value: unknown): value is WorkspaceMenuActionId {
  return typeof value === 'string' && (WORKSPACE_MENU_ACTION_IDS as readonly string[]).includes(value)
}

/** 验证菜单条目结构，避免 IPC 输入携带任意菜单配置或异常坐标。 */
export function parseWorkspaceMenuInput(value: unknown): ShowWorkspaceMenuInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('工作区菜单参数无效。')
  }

  /** 将 IPC 输入视为待验证记录，验证完成前不把它当成可信契约。 */
  const input = value as Record<string, unknown>
  if (
    typeof input.x !== 'number'
    || !Number.isFinite(input.x)
    || input.x < 0
    || input.x > 10000
    || typeof input.y !== 'number'
    || !Number.isFinite(input.y)
    || input.y < 0
    || input.y > 10000
    || !Array.isArray(input.entries)
    || input.entries.length === 0
    || input.entries.length > 40
  ) {
    throw new Error('工作区菜单参数无效。')
  }

  /** 每个条目只接受白名单动作、短标签或分隔线。 */
  const entries = input.entries.map((entry): WorkspaceMenuEntryInput => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('工作区菜单条目无效。')
    }

    /** 菜单条目的窄化记录，只用于当前条目校验。 */
    const candidate = entry as Record<string, unknown>
    if (candidate.type === 'separator') return { type: 'separator' }
    if (
      candidate.type !== 'item'
      || !isWorkspaceMenuActionId(candidate.id)
      || typeof candidate.label !== 'string'
      || candidate.label.trim().length === 0
      || candidate.label.length > 80
      || (candidate.disabled !== undefined && typeof candidate.disabled !== 'boolean')
    ) {
      throw new Error('工作区菜单条目无效。')
    }
    return {
      type: 'item',
      id: candidate.id,
      label: candidate.label,
      ...(candidate.disabled === true ? { disabled: true } : {}),
    }
  })

  return { x: input.x, y: input.y, entries }
}
