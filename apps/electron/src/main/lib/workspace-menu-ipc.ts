import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import {
  WORKSPACE_MENU_IPC_CHANNELS,
  isWorkspaceMenuActionId,
  parseWorkspaceMenuInput,
} from '@proma/shared'
import type { ShowWorkspaceMenuInput, WorkspaceMenuActionId } from '@proma/shared'
import { getMainWindow } from './main-window-store'

/** 一次打开请求及本轮允许回传的操作白名单。 */
interface PendingWorkspaceMenu {
  resolve: (action: WorkspaceMenuActionId | null) => void
  actionIds: Set<WorkspaceMenuActionId>
  visible: boolean
}

/** 与主窗口绑定、可在多次打开间复用的菜单浮层。 */
interface WorkspaceMenuWindow {
  owner: BrowserWindow
  popup: BrowserWindow
  popupWebContentsId: number
  ownerWebContentsId: number
  ready: Promise<boolean>
  settleReady: (ready: boolean) => void
  readyState: boolean | null
  pending: PendingWorkspaceMenu | null
}

/** 按主窗口身份缓存菜单窗口，避免不同主窗口共享焦点与动作状态。 */
const workspaceMenuWindowsByOwner = new Map<number, WorkspaceMenuWindow>()
/** 由菜单 WebContents 身份定位缓存窗口，用于 ready、select 和 dismiss IPC。 */
const workspaceMenuWindowsByPopup = new Map<number, WorkspaceMenuWindow>()

/** 菜单使用固定应用宽度，条目数只影响按需计算出的窗口高度。 */
const WORKSPACE_MENU_WIDTH = 228
/** 透明留白容纳应用菜单自身的 CSS 阴影。 */
const WORKSPACE_MENU_GUTTER = 12

/** 估算应用菜单占用的 CSS 高度，供透明子窗口避开屏幕边缘。 */
function getWorkspaceMenuHeight(input: ShowWorkspaceMenuInput): number {
  /** 普通项使用现有菜单的文字、图标与上下内边距尺寸。 */
  const itemCount = input.entries.filter((entry) => entry.type === 'item').length
  /** 分隔线包含上下 margin，需要额外计入定位高度。 */
  const separatorCount = input.entries.filter((entry) => entry.type === 'separator').length
  return Math.min(640, 8 + itemCount * 32 + separatorCount * 9)
}

/** 设置 renderer 就绪状态，并兑现等待首次菜单显示的请求。 */
function settleWorkspaceMenuReady(windowState: WorkspaceMenuWindow, ready: boolean): void {
  if (windowState.readyState !== null) return
  windowState.readyState = ready
  windowState.settleReady(ready)
}

/** 结束当前菜单请求、清空条目并隐藏窗口；必要时把焦点还给主窗口。 */
function finishWorkspaceMenu(
  windowState: WorkspaceMenuWindow,
  action: WorkspaceMenuActionId | null,
  restoreFocus = false,
): void {
  const pending = windowState.pending
  if (!pending) return

  windowState.pending = null
  pending.resolve(action)
  if (!windowState.popup.isDestroyed()) {
    if (windowState.readyState && !windowState.popup.webContents.isDestroyed()) {
      try {
        windowState.popup.webContents.send(WORKSPACE_MENU_IPC_CHANNELS.UPDATE, null)
      } catch {
        /** renderer 正在退出时无需为清空菜单阻断主窗口焦点恢复。 */
      }
    }
    if (windowState.popup.isVisible()) windowState.popup.hide()
  }
  if (restoreFocus && !windowState.owner.isDestroyed()) windowState.owner.focus()
}

/** 按主窗口创建或取回已预热的透明菜单窗口。 */
function getOrCreateWorkspaceMenuWindow(owner: BrowserWindow): WorkspaceMenuWindow {
  /** 有效缓存代表菜单 renderer 已经在加载或可以直接复用。 */
  const ownerWebContentsId = owner.webContents.id
  const cached = workspaceMenuWindowsByOwner.get(ownerWebContentsId)
  if (cached && !cached.popup.isDestroyed() && cached.readyState !== false) return cached
  if (cached && !cached.popup.isDestroyed()) cached.popup.destroy()

  /** 初始 bounds 仅用于隐藏预热，真正显示前会按触发按钮重新定位。 */
  const ownerBounds = owner.getBounds()
  const popup = new BrowserWindow({
    x: ownerBounds.x,
    y: ownerBounds.y,
    width: WORKSPACE_MENU_WIDTH + WORKSPACE_MENU_GUTTER * 2,
    height: 320,
    parent: owner,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    focusable: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
    },
  })
  /** WebContents 销毁后只使用创建时缓存的数字 ID 清理映射。 */
  const popupWebContentsId = popup.webContents.id
  /** ready promise 在 renderer 主动握手后兑现，确保菜单更新不会丢失。 */
  let resolveReady: (ready: boolean) => void = () => undefined
  const ready = new Promise<boolean>((resolve) => { resolveReady = resolve })
  const windowState: WorkspaceMenuWindow = {
    owner,
    popup,
    popupWebContentsId,
    ownerWebContentsId,
    ready,
    settleReady: resolveReady,
    readyState: null,
    pending: null,
  }
  workspaceMenuWindowsByOwner.set(ownerWebContentsId, windowState)
  workspaceMenuWindowsByPopup.set(popupWebContentsId, windowState)

  /** 主窗口隐藏时同步关闭菜单，避免子窗口仍占有焦点或显示内容。 */
  const handleOwnerHide = (): void => finishWorkspaceMenu(windowState, null)
  /** 主窗口销毁时释放对应的长期复用菜单窗口。 */
  const handleOwnerClosed = (): void => {
    finishWorkspaceMenu(windowState, null)
    if (!popup.isDestroyed()) popup.destroy()
  }
  popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  popup.webContents.on('will-navigate', (navigationEvent) => navigationEvent.preventDefault())
  popup.on('blur', () => {
    /** 缓存触发失焦时的请求，防止旧事件关闭后续快速打开的菜单。 */
    const blurredRequest = windowState.pending
    if (!blurredRequest?.visible) return

    /** 让同一窗口可能正在进行的 show/focus 完成，再确认是否仍然失焦。 */
    setImmediate(() => {
      if (
        windowState.pending !== blurredRequest
        || popup.isDestroyed()
        || !popup.isVisible()
        || popup.isFocused()
      ) return
      finishWorkspaceMenu(windowState, null)
    })
  })
  owner.on('hide', handleOwnerHide)
  owner.once('closed', handleOwnerClosed)
  popup.on('closed', () => {
    settleWorkspaceMenuReady(windowState, false)
    finishWorkspaceMenu(windowState, null)
    owner.removeListener('hide', handleOwnerHide)
    owner.removeListener('closed', handleOwnerClosed)
    if (workspaceMenuWindowsByOwner.get(ownerWebContentsId) === windowState) {
      workspaceMenuWindowsByOwner.delete(ownerWebContentsId)
    }
    if (workspaceMenuWindowsByPopup.get(popupWebContentsId) === windowState) {
      workspaceMenuWindowsByPopup.delete(popupWebContentsId)
    }
  })
  popup.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    settleWorkspaceMenuReady(windowState, false)
    console.error(`[右侧工作区] 菜单 renderer 加载失败 (${errorCode}): ${errorDescription} (${validatedURL})`)
    if (!popup.isDestroyed()) popup.destroy()
  })
  popup.webContents.on('render-process-gone', (_event, details) => {
    if (windowState.readyState === null) settleWorkspaceMenuReady(windowState, false)
    else windowState.readyState = false
    console.error('[右侧工作区] 菜单 renderer 进程退出:', details.reason)
    finishWorkspaceMenu(windowState, null)
    if (!popup.isDestroyed()) popup.destroy()
  })

  /** 菜单 renderer 只由固定入口加载，动作和条目通过已校验 IPC 传递。 */
  const loadPopup = app.isPackaged
    ? popup.loadFile(join(__dirname, 'renderer', 'index.html'), { query: { window: 'workspace-menu' } })
    : popup.loadURL(`http://127.0.0.1:5174?${new URLSearchParams({ window: 'workspace-menu' }).toString()}`)
  void loadPopup.catch((error: unknown) => {
    settleWorkspaceMenuReady(windowState, false)
    console.error('[右侧工作区] 加载应用菜单失败:', error)
    if (!popup.isDestroyed()) popup.destroy()
  })

  return windowState
}

/** 主窗口加载完成后提前加载一次菜单 renderer，供后续点击复用。 */
export function prepareWorkspaceMenu(owner: BrowserWindow): void {
  if (owner.isDestroyed()) return
  getOrCreateWorkspaceMenuWindow(owner)
}

/** 注册菜单 IPC，并仅允许主窗口 renderer 打开或菜单浮层回传动作。 */
export function registerWorkspaceMenuIpcHandlers(): void {
  ipcMain.on(WORKSPACE_MENU_IPC_CHANNELS.READY, (event) => {
    /** ready 只能来自已登记的菜单窗口，不能让普通 renderer 伪造预热状态。 */
    const windowState = workspaceMenuWindowsByPopup.get(event.sender.id)
    if (windowState) settleWorkspaceMenuReady(windowState, true)
  })

  ipcMain.handle(WORKSPACE_MENU_IPC_CHANNELS.SHOW, (event, value: unknown): Promise<WorkspaceMenuActionId | null> => {
    /** 菜单只能由拥有受管浏览器的主窗口 renderer 请求。 */
    const owner = getMainWindow()
    if (!owner || owner.isDestroyed() || owner.webContents.id !== event.sender.id) {
      throw new Error('仅主窗口可以打开工作区菜单。')
    }

    /** 先严格验证 renderer 提交的位置与菜单条目。 */
    const input = parseWorkspaceMenuInput(value)
    const windowState = getOrCreateWorkspaceMenuWindow(owner)
    /** 同一主窗口只保留最近的打开请求，重复点击会完成前一次等待。 */
    finishWorkspaceMenu(windowState, null)

    return new Promise((resolve) => {
      /** 本次可执行动作仍严格限制为启用状态的共享白名单 ID。 */
      const pending: PendingWorkspaceMenu = {
        resolve,
        actionIds: new Set(input.entries.flatMap((entry) => (
          entry.type === 'item' && !entry.disabled ? [entry.id] : []
        ))),
        visible: false,
      }
      windowState.pending = pending

      /** 首次冷启动时等待预热握手；之后只改 bounds 和内容即可显示。 */
      void windowState.ready.then((rendererReady) => {
        if (windowState.pending !== pending) return
        if (!rendererReady || windowState.readyState !== true || owner.isDestroyed() || windowState.popup.isDestroyed()) {
          finishWorkspaceMenu(windowState, null)
          return
        }

        /** CSS 坐标乘窗口缩放后转成 Electron 使用的 DIP 坐标。 */
        const zoomFactor = owner.webContents.getZoomFactor()
        const ownerBounds = owner.getContentBounds()
        const anchorRight = ownerBounds.x + Math.round(input.x * zoomFactor)
        const anchorBottom = ownerBounds.y + Math.round(input.y * zoomFactor)
        /** 子窗口必须完整落在触发器所在显示器的可用区域内。 */
        const display = screen.getDisplayNearestPoint({ x: anchorRight, y: anchorBottom })
        const workArea = display.workArea
        const gutter = Math.round(WORKSPACE_MENU_GUTTER * zoomFactor)
        const menuWidth = Math.round(WORKSPACE_MENU_WIDTH * zoomFactor)
        const menuHeight = Math.round(getWorkspaceMenuHeight(input) * zoomFactor)
        const width = Math.min(menuWidth + gutter * 2, workArea.width - 8)
        const height = Math.min(menuHeight + gutter * 2, workArea.height - 8)
        const x = Math.max(workArea.x + 4, Math.min(anchorRight - menuWidth - gutter, workArea.x + workArea.width - width - 4))
        const yBelow = anchorBottom - gutter
        const yAbove = anchorBottom - menuHeight - gutter
        const y = yBelow + height <= workArea.y + workArea.height - 4
          ? yBelow
          : Math.max(workArea.y + 4, yAbove)

        try {
          windowState.popup.setBounds({ x, y, width, height })
          windowState.popup.webContents.setZoomFactor(zoomFactor)
          windowState.popup.webContents.send(WORKSPACE_MENU_IPC_CHANNELS.UPDATE, input.entries)
          pending.visible = true
          windowState.popup.show()
          windowState.popup.focus()
        } catch (error) {
          console.error('[右侧工作区] 显示应用菜单失败:', error)
          finishWorkspaceMenu(windowState, null)
        }
      })
    })
  })

  ipcMain.handle(WORKSPACE_MENU_IPC_CHANNELS.SELECT, (event, value: unknown): boolean => {
    /** 只接受属于当前 popup 且确实显示过的菜单项。 */
    const windowState = workspaceMenuWindowsByPopup.get(event.sender.id)
    const pending = windowState?.pending
    if (!windowState || !pending?.visible || !isWorkspaceMenuActionId(value) || !pending.actionIds.has(value)) return false
    finishWorkspaceMenu(windowState, value, true)
    return true
  })

  ipcMain.handle(WORKSPACE_MENU_IPC_CHANNELS.DISMISS, (event): boolean => {
    /** 仅当前显示的菜单浮层可以结束自己的展示请求。 */
    const windowState = workspaceMenuWindowsByPopup.get(event.sender.id)
    if (!windowState?.pending?.visible) return false
    finishWorkspaceMenu(windowState, null, true)
    return true
  })
}
