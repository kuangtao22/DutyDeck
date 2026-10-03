import * as React from 'react'
import { useStore } from 'jotai'
import { browserNativeViewHiddenAtom } from '@/atoms/browser-modal-atoms'
import { nextBrowserLayoutRevision } from './browser-layout-revision'

// 每次 publish（包括卸载隐藏）分配全局单调 revision。旧 slot 的 IPC 即使晚到，
// 主进程也不会覆盖随后已挂载 tab 的可见性和边界。
// WebContentsView 是原生子视图，天然盖在 renderer DOM 之上；CSS z-index 无法反转。
// 模态弹窗或 renderer 浮层临时隐藏原生网页，且保留会话；普通不遮挡网页的
// Popover、Toast 不触发避让。

export function BrowserSlot({ sessionId, tabId }: { sessionId: string; tabId: string }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null)
  /** 直接订阅模态布尔状态，避免重建 Slot Effect 或监听流式消息 DOM。 */
  const store = useStore()

  React.useLayoutEffect(() => {
    const element = ref.current
    const setLayout = (window.electronAPI as Partial<typeof window.electronAPI>).setAgentBrowserLayout
    if (!element || typeof setLayout !== 'function') return
    let frame = 0
    const commitLayout = (visible: boolean, preserveSessionOnHide: boolean) => {
      const rect = element.getBoundingClientRect()
      void setLayout({
        sessionId,
        tabId,
        revision: nextBrowserLayoutRevision(),
        visible: visible && rect.width > 4 && rect.height > 4,
        preserveSessionOnHide,
        bounds: {
          x: Math.round(rect.x), y: Math.round(rect.y),
          width: Math.round(rect.width), height: Math.round(rect.height),
        },
      })
    }
    const publish = (visible: boolean, preserveSessionOnHide = false, immediate = false) => {
      if (frame) cancelAnimationFrame(frame)
      if (immediate) {
        frame = 0
        commitLayout(visible, preserveSessionOnHide)
        return
      }
      frame = requestAnimationFrame(() => {
        frame = 0
        commitLayout(visible, preserveSessionOnHide)
      })
    }
    const publishCurrentVisibility = (immediate = false) => {
      /** 初次挂载、resize 和隐藏状态切换读取同一状态，避免迟到布局重新盖住浮层。 */
      const nativeViewHidden = store.get(browserNativeViewHiddenAtom)
      publish(!nativeViewHidden, nativeViewHidden, immediate)
    }
    /** 模态或浮层挂载立即避让；最后一个节点完成退出动画后才恢复。 */
    const unsubscribeNativeViewHidden = store.sub(browserNativeViewHiddenAtom, () => publishCurrentVisibility(true))
    const observer = new ResizeObserver(() => publishCurrentVisibility())
    const publishBounded = () => publishCurrentVisibility()
    observer.observe(element)
    window.addEventListener('resize', publishBounded)
    // Tab 切换时先前 Slot 会立即发出 hide。新 Slot 不能再等一帧才 show，
    // 否则快速左右切换时原生视图会停留在隐藏状态，表现为页面内容消失。
    publishCurrentVisibility(true)
    return () => {
      unsubscribeNativeViewHidden()
      observer.disconnect()
      window.removeEventListener('resize', publishBounded)
      if (frame) cancelAnimationFrame(frame)
      void setLayout({ sessionId, tabId, revision: nextBrowserLayoutRevision(), visible: false, preserveSessionOnHide: false, bounds: { x: 0, y: 0, width: 0, height: 0 } })
    }
  }, [sessionId, tabId, store])

  return <div ref={ref} className="flex-1 min-h-0 bg-muted/15 titlebar-no-drag" aria-label="受管浏览器页面" />
}
