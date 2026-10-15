import * as React from 'react'
import { useAtom } from 'jotai'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ServerOpsTaskSummary } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { attachServerOpsTaskTerminal } from './server-ops-task-terminal-controller'
import { serverOpsTaskSelectionAtom } from './useServerOpsTaskFocus'

/** 已验证生命周期的中文展示，只有明确退出码才展示退出结果。 */
export function describeServerOpsTaskState(task: ServerOpsTaskSummary): string {
  if (task.state === 'exited') return task.exitCode === undefined ? `已退出${task.signal ? ` · 信号 ${task.signal}` : ' · 退出码未知'}` : `已退出 · 退出码 ${task.exitCode}`
  return { starting: '正在启动', running: '运行中', unknown: '结果未知', interrupted: '已中断' }[task.state]
}

/** 附着已有远程 PTY；切换标签仅销毁 xterm，不停止发布任务。 */
export function ServerOpsTaskTerminal({ task }: { task: ServerOpsTaskSummary }): React.ReactElement {
  /** 可见元数据与错误独立于 xterm 生命周期，输出通知不重建终端。 */
  const [current, setCurrent] = React.useState(task)
  const [error, setError] = React.useState<string | null>(null)
  const [generation, setGeneration] = React.useState(0)
  const [interrupting, setInterrupting] = React.useState(false)
  const hostRef = React.useRef<HTMLDivElement>(null)
  const taskRef = React.useRef(task)
  taskRef.current = task
  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setError(null)
    /** 终端颜色使用当前应用主题，避免任务页单独锁定深色。 */
    const style = getComputedStyle(host)
    const terminal = new Terminal({ cursorBlink: true, fontSize: 12, scrollback: 5000, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: style.backgroundColor, foreground: style.color, cursor: style.color } })
    const fit = new FitAddon()
    terminal.loadAddon(fit); terminal.open(host)
    return attachServerOpsTaskTerminal({ task: taskRef.current, api: window.electronAPI, terminal, onTask: setCurrent, onError: setError,
      fit: () => fit.fit(), observeResize: (callback) => { const observer = new ResizeObserver(callback); observer.observe(host); return () => observer.disconnect() } })
  }, [task.taskId, task.sessionId, generation])
  /** 用户显式中断任务，不把页面导航当作取消。 */
  const interrupt = async (): Promise<void> => {
    setInterrupting(true)
    try { setCurrent(await window.electronAPI.interruptServerOpsTask({ sessionId: task.sessionId, taskId: task.taskId })) }
    catch { setError('中断请求失败，请检查连接状态。') }
    finally { setInterrupting(false) }
  }
  return <div className="flex h-full min-h-0 flex-col bg-background">
    <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
      <span role="status">{describeServerOpsTaskState(current)}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={current.command}>{current.command}</span>
      <Button size="sm" variant="outline" disabled={interrupting || !['starting', 'running'].includes(current.state)} onClick={() => { void interrupt() }}>中断任务</Button>
    </div>
    <div className="px-3 py-1 text-xs text-muted-foreground">如需 sudo 密码，请直接在此终端输入；切换页面不会停止任务。</div>
    {current.message && <div className="px-3 py-1 text-xs">{current.message}</div>}
    {current.warnings?.map((warning, index) => <div key={index} className="px-3 py-1 text-xs text-muted-foreground">{warning}</div>)}
    {error && <div role="alert" className="flex items-center gap-2 px-3 py-1 text-xs text-destructive">{error}<Button size="sm" variant="ghost" onClick={() => setGeneration((value) => value + 1)}>重新加载</Button></div>}
    <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden bg-background p-2 text-foreground" aria-label="Agent 远程任务终端" />
  </div>
}

/** 任务和手动 SSH 使用显式选择器，避免把 Agent 输入混入用户 shell。 */
export function ServerOpsTaskTerminalSwitcher({ sessionId, hostId, manualTerminal }: {
  sessionId: string | null
  hostId: string
  manualTerminal: React.ReactNode
}): React.ReactElement {
  /** 当前会话任务索引只监听元数据；终端自己按游标读取输出。 */
  const [tasks, setTasks] = React.useState<ServerOpsTaskSummary[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [selections, setSelections] = useAtom(serverOpsTaskSelectionAtom)
  /** 使用组合身份，避免不同会话同主机串用选中任务。 */
  const selectionKey = JSON.stringify([sessionId, hostId])
  const selected = selections.get(selectionKey) ?? 'manual'
  const setSelected = (taskId: string): void => { setSelections((previous) => new Map(previous).set(selectionKey, taskId)) }
  const [reload, setReload] = React.useState(0)
  /** 初始载入与任务已被服务清理使用不同提示。 */
  const [loading, setLoading] = React.useState(true)
  React.useEffect(() => {
    setTasks([]); setError(null); setLoading(true)
    if (!sessionId) { setLoading(false); return }
    if (typeof window.electronAPI.onServerOpsTaskChanged !== 'function' || typeof window.electronAPI.listServerOpsTasks !== 'function') { setError('远程任务接口尚未就绪，请重启应用后重试。'); setLoading(false); return }
    let disposed = false
    /** 初始列表在途收到的更新优先于旧快照。 */
    const changed = new Map<string, ServerOpsTaskSummary>()
    const unsubscribe = window.electronAPI.onServerOpsTaskChanged((task) => {
      if (task.sessionId !== sessionId || task.hostId !== hostId || disposed) return
      changed.set(task.taskId, task)
      setTasks((previous) => [...previous.filter((item) => item.taskId !== task.taskId), task])
    })
    void window.electronAPI.listServerOpsTasks(sessionId).then((result) => {
      if (disposed) return
      const merged = new Map(result.filter((task) => task.hostId === hostId).map((task) => [task.taskId, task]))
      changed.forEach((task, id) => merged.set(id, task)); setTasks([...merged.values()])
    }).catch(() => { if (!disposed) setError('远程任务列表读取失败。') }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true; unsubscribe() }
  }, [sessionId, hostId, reload])
  const task = tasks.find((item) => item.taskId === selected)
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <Select value={selected} onValueChange={setSelected}><SelectTrigger className="h-8" aria-label="选择服务器终端"><SelectValue placeholder="选择服务器终端" /></SelectTrigger>
        <SelectContent><SelectItem value="manual">手动 SSH 终端</SelectItem>{[...tasks].sort((a, b) => b.createdAt - a.createdAt).map((item) => <SelectItem key={item.taskId} value={item.taskId}>{describeServerOpsTaskState(item)} · {item.command.slice(0, 80)}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    {error && <div role="alert" className="px-3 py-2 text-xs text-destructive">{error}<Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>重试</Button></div>}
    <div className="min-h-0 flex-1">{selected === 'manual' ? manualTerminal : task ? <ServerOpsTaskTerminal key={task.taskId} task={task} /> : <div className="p-4 text-sm text-muted-foreground">{loading ? '正在加载任务…' : '任务不可用或已被清理，请切换终端或刷新列表。'}{!loading && <Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>刷新列表</Button>}</div>}</div>
  </div>
}
