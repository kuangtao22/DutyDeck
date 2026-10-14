import { atom } from 'jotai'

/** 视图偏好只驻留 renderer，正式设计版本由主进程保存。 */
export interface InteractionDesignView {
  /** 当前原型与页面身份，不依赖名称匹配。 */
  prototypeId: string | null
  pageId: string | null
  /** 设备与目录折叠不会改写设计版本。 */
  device: 'mobile' | 'desktop'
  collapsedGroups: string[]
}

/** 以真实项目身份隔离最近选择；不保存 HTML、候选或图片字节。 */
export const interactionDesignViewsAtom = atom<Record<string, InteractionDesignView>>({})
