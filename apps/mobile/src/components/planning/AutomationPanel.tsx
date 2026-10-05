import { useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { CalendarClock, LoaderCircle, Pause, Play, RefreshCw, Zap } from 'lucide-react'
import { automationsAtom, tokenAtom } from '../../atoms'
import type { LanBridgeAutomationDto } from '@proma/shared'
import { wsReq } from '../../lib/ws-client'

/** 自动计划列表接口的最小响应形状。 */
interface AutomationListResponse {
  automations?: LanBridgeAutomationDto[]
}

/** 自动计划启停接口的最小响应形状。 */
interface AutomationResponse {
  automation?: LanBridgeAutomationDto
}

/** 自动计划面板的外部导航回调。 */
interface AutomationPanelProps {
  /** 打开某次自动运行生成的会话。 */
  onOpenSession?: (sessionId: string) => void
}

/** 把服务端调度字段转换为移动端紧凑的计划摘要。 */
export function formatAutomationSchedule(automation: LanBridgeAutomationDto): string {
  if (automation.scheduleType === 'once') {
    return automation.scheduledAt
      ? `一次性 · ${new Date(automation.scheduledAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : '一次性'
  }
  if (automation.scheduleType === 'daily') return `每天 ${automation.timeOfDay ?? '09:00'}`
  if (automation.scheduleType === 'weekly') return `每周${['日', '一', '二', '三', '四', '五', '六'][automation.dayOfWeek ?? 1]} ${automation.timeOfDay ?? '09:00'}`
  if (automation.scheduleType === 'monthly') return `每月 ${automation.dayOfMonth ?? 1} 日 ${automation.timeOfDay ?? '09:00'}`
  /** interval 的周限制沿用服务端 0=周日约定，避免客户端重算调度。 */
  const weekdays = automation.activeWeekdays && automation.activeWeekdays.length > 0
    ? ` · 周${automation.activeWeekdays.map((day) => ['日', '一', '二', '三', '四', '五', '六'][day] ?? '?').join('、')}`
    : ''
  /** interval 的时间窗口只展示服务端保存的边界，不在移动端推导下一次运行。 */
  const timeWindow = automation.activeWindowStart && automation.activeWindowEnd
    ? ` · ${automation.activeWindowStart}-${automation.activeWindowEnd}`
    : ''
  const minutes = automation.intervalMinutes
  const interval = minutes >= 60 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`
  return `${interval}${weekdays}${timeWindow}`
}

/** 格式化下一次真实触发时间，不在客户端自行推算运行状态。 */
function formatNextRun(automation: LanBridgeAutomationDto): string {
  if (!automation.active || automation.completedAt) return automation.completedAt ? '已完成' : '已暂停'
  return `下次 ${new Date(automation.nextRunAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
}

/** 渲染移动端自动计划列表，并把启停/立即运行交给服务端确认。 */
export function AutomationPanel({ onOpenSession }: AutomationPanelProps) {
  const token = useAtomValue(tokenAtom)
  const [automations, setAutomations] = useAtom(automationsAtom)
  const [loading, setLoading] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)

  /** 从服务端重新读取计划摘要。 */
  const refresh = async (): Promise<void> => {
    if (!token) return
    setLoading(true)
    try {
      const response = await wsReq('automations.list', { token }) as AutomationListResponse
      setAutomations(response.automations ?? [])
    } catch {
      // 连接错误由全局连接状态展示，此处保留旧快照避免闪烁。
    } finally {
      setLoading(false)
    }
  }

  /** 用服务端确认的对象替换单条计划，避免本地乐观状态漂移。 */
  const replaceAutomation = (next: LanBridgeAutomationDto): void => {
    setAutomations((current) => current.map((item) => item.id === next.id ? next : item))
  }

  /** 切换启停状态，并在服务端成功后更新列表。 */
  const toggle = async (automation: LanBridgeAutomationDto): Promise<void> => {
    if (!token) return
    try {
      const response = await wsReq('automations.toggle', { token, id: automation.id, active: !automation.active }) as AutomationResponse
      if (response.automation) replaceAutomation(response.automation)
    } catch {
      // 失败时保留服务端旧状态。
    }
  }

  /** 触发一次真实的自动计划执行，完成后刷新运行历史。 */
  const runNow = async (automation: LanBridgeAutomationDto): Promise<void> => {
    if (!token || runningId) return
    setRunningId(automation.id)
    try {
      await wsReq('automations.run_now', { token, id: automation.id })
      await refresh()
    } catch {
      // 计划不可运行时由下一次刷新呈现服务端状态。
    } finally {
      setRunningId(null)
    }
  }

  /** 面板首次打开时读取一次服务端快照；后续由用户显式刷新。 */
  useEffect(() => {
    void refresh()
  }, [token])

  return (
    <section aria-label="自动计划" className="flex h-full min-h-0 flex-col bg-content">
      <div className="flex min-h-12 items-center justify-between border-b border-border px-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarClock aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          <h2 className="truncate text-sm font-semibold">自动计划</h2>
          <span className="text-[10px] tabular-nums text-muted-foreground">{automations.length}</span>
        </div>
        <button
          type="button"
          aria-label="刷新自动计划"
          onClick={() => { void refresh() }}
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-control hover:text-foreground"
        >
          <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {automations.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center text-center text-xs text-muted-foreground">
            <CalendarClock aria-hidden="true" className="mb-3 h-5 w-5" />
            <p>暂无自动计划</p>
            <p className="mt-1 text-[11px]">请在桌面端创建计划后在这里查看</p>
          </div>
        ) : (
          <div className="space-y-2">
            {automations.map((automation) => (
              <article key={automation.id} data-automation-row className="rounded-md border border-border bg-card px-3 py-2.5">
                <div className="flex min-w-0 items-start gap-2">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${automation.active ? 'bg-green-500' : 'bg-muted-foreground/35'}`} aria-label={automation.active ? '已启用' : '已暂停'} role="status" />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-medium">{automation.name || '未命名计划'}</h3>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{formatAutomationSchedule(automation)}</p>
                    <p className="mt-1 text-[10px] tabular-nums text-muted-foreground/75">{formatNextRun(automation)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={automation.active ? '暂停自动计划' : '启用自动计划'}
                      aria-pressed={automation.active}
                      onClick={() => { void toggle(automation) }}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {automation.active ? <Pause aria-hidden="true" className="h-3.5 w-3.5" /> : <Play aria-hidden="true" className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      aria-label="立即运行自动计划"
                      disabled={runningId !== null}
                      onClick={() => { void runNow(automation) }}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-35"
                    >
                      {runningId === automation.id ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Zap aria-hidden="true" className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
                {automation.runHistory.length > 0 && (
                  <div className="mt-2 flex items-center gap-2 border-t border-border/60 pt-2 text-[10px] text-muted-foreground/75">
                    <span className="min-w-0 flex-1 truncate">
                      最近一次：{automation.runHistory[automation.runHistory.length - 1]?.status === 'success' ? '成功' : automation.runHistory[automation.runHistory.length - 1]?.status === 'error' ? '失败' : '跳过'}
                    </span>
                    {automation.lastSessionId && onOpenSession && (
                      <button
                        type="button"
                        onClick={() => onOpenSession(automation.lastSessionId!)}
                        className="shrink-0 text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
                      >
                        查看
                      </button>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
