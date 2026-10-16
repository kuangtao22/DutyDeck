import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'

/** 一轮一次的设备定位请求；只保留身份，不保存图片或工具输入。 */
export interface MobileMirrorDeviceRequest { deviceId: string; runKey: string }
/** 按会话隔离的临时定位目标，不写入持久化配置。 */
export const mobileMirrorDeviceRequestsAtom = atom<Map<string, MobileMirrorDeviceRequest>>(new Map())
/** 用户暂停意图跟随会话保留，标签卸载或新轮定位都不能自动恢复截图。 */
export const mobileMirrorPausedAtomFamily = atomFamily((_sessionId: string) => atom(false))
