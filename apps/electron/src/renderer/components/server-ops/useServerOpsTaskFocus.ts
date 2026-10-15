import * as React from 'react'
import { atom, useSetAtom, useStore } from 'jotai'
import type { ServerOpsTaskSummary } from '@proma/shared'
import { createServerOpsTaskFocusGate } from './server-ops-task-terminal-controller'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'

/** 新任务定位请求仅驻留当前 renderer，不恢复历史请求或跨窗口抢焦点。 */
export const serverOpsTaskFocusAtom = atom<ServerOpsTaskSummary | null>(null)

/** 终端选择按会话和主机保存在内存，手动切回 SSH 后不会被历史定位覆盖。 */
export const serverOpsTaskSelectionAtom = atom(new Map<string, string>())

/** 仅当前前台会话的新启动任务触发自动展示；输出与后台任务不改变焦点。 */
export function useServerOpsTaskFocus(sessionId: string, open: () => void): void {
  const store = useStore()
  const setFocus = useSetAtom(serverOpsTaskFocusAtom)
  const setSelection = useSetAtom(serverOpsTaskSelectionAtom)
  const openRef = React.useRef(open)
  openRef.current = open
  React.useEffect(() => {
    if (typeof window.electronAPI.onServerOpsTaskChanged !== 'function') return
    /** 按事件创建时间与首次身份判断新任务，不扫描历史列表。 */
    const accept = createServerOpsTaskFocusGate(sessionId, Date.now())
    return window.electronAPI.onServerOpsTaskChanged((task) => {
      if (!accept(task, store.get(currentAgentSessionIdAtom))) return
      setSelection((previous) => new Map(previous).set(JSON.stringify([sessionId, task.hostId]), task.taskId))
      setFocus(task); openRef.current()
    })
  }, [sessionId, store, setFocus, setSelection])
}
