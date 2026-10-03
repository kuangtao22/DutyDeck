import { atom } from 'jotai'

/** 仍挂载的模态内容数量；退出动画期间继续计入，嵌套弹窗独立释放。 */
export const browserModalCountAtom = atom(0)

/** 原生网页只订阅是否需要避让，避免多个弹窗切换时重复发布布局。 */
export const browserModalActiveAtom = atom((get) => get(browserModalCountAtom) > 0)

/**
 * 暂时盖住原生网页的 renderer 浮层数量，例如右侧工作区的加号菜单。
 * 菜单不能被 WebContentsView 盖住，也不应通过改变网页 bounds 把页面整体下推。
 */
export const browserOverlayCountAtom = atom(0)

/** 原生网页需要暂时隐藏的统一条件：模态内容或 renderer 浮层正在显示。 */
export const browserNativeViewHiddenAtom = atom((get) => (
  get(browserModalCountAtom) > 0 || get(browserOverlayCountAtom) > 0
))
