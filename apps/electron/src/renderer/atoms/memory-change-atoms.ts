import { atom } from 'jotai'
import type { WorkspaceMemoryFileChange } from '@proma/shared'

/** Renderer-lifetime presentation state for the global, current-workspace Memory change dock. */
export const workspaceMemoryChangesAtom = atom<Map<string, WorkspaceMemoryFileChange[]>>(new Map())


/** 一次性记忆导航：会话入口明确指定目标，未指定时只路由到能力中心。 */
export interface WorkspaceMemoryNavigationRequest {
  workspaceSlug: string
  sessionId?: string
  relativePath: string
  mode: 'preview' | 'edit' | 'change'
}

/** 只让匹配项目和会话的实例消费；Diff 必须拥有当前会话身份。 */
export function matchesMemoryNavigation(
  request: WorkspaceMemoryNavigationRequest | null,
  workspaceSlug: string,
  sessionId?: string,
): boolean {
  return Boolean(request && request.workspaceSlug === workspaceSlug && request.sessionId === sessionId
    && (request.mode !== 'change' || sessionId))
}

/** 原子保存当前请求，消费者通过对象身份比较清理，避免清掉更新请求。 */
export const memoryFileNavigationAtom = atom<WorkspaceMemoryNavigationRequest | null>(null)
