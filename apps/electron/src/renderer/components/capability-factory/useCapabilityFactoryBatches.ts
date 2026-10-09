import * as React from 'react'
import type { CapabilityFactoryBatch, CapabilityFactoryBatchKind, CapabilityFactoryBatchRequest, CapabilityFactoryBatchSummary, CapabilityRun } from '@proma/shared'
import { loadFactoryBatchRuns } from './capability-factory-batch-view'

/** UI 与 Agent 共读后端批次；事件刷新不重放执行，迟到结果按作用域和请求代次丢弃。 */
export function useCapabilityFactoryBatches(sessionId: string, sceneId: string, kind: CapabilityFactoryBatchKind) {
  const [batches, setBatches] = React.useState<CapabilityFactoryBatchSummary[]>([])
  const [batch, setBatch] = React.useState<CapabilityFactoryBatch | null>(null)
  const [runs, setRuns] = React.useState<CapabilityRun[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  /** 手动选中历史后保持阅读位置；null 表示跟随最新批次。 */
  const selected = React.useRef<string | null>(null)
  const active = React.useRef(false)
  /** 作用域身份独立于刷新代次，切回同名场景也不能接收旧请求。 */
  const scope = React.useMemo(() => ({}), [sessionId, sceneId, kind])
  const currentScope = React.useRef(scope)
  currentScope.current = scope
  /** 同步提交锁避免同一帧的重复调用。 */
  const submittingRef = React.useRef(false)
  const generation = React.useRef(0)
  const cache = React.useRef(new Map<string, CapabilityRun>())

  /** 只拉当前用途摘要与选中批次，长输出按运行 ID 缓存。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    if (!active.current || currentScope.current !== scope) return
    const ticket = ++generation.current
    const runCache = cache.current
    try {
      const all = await window.electronAPI.capabilityFactory.invoke('listBatches', { sessionId, sceneId })
      const matching = all.filter((item) => item.kind === kind)
      const id = matching.find((item) => item.id === selected.current)?.id ?? matching[0]?.id
      const current = id ? await window.electronAPI.capabilityFactory.invoke('getBatch', { sessionId, sceneId, batchId: id }) : null
      const records = current ? await loadFactoryBatchRuns(window.electronAPI.capabilityFactory, sessionId, sceneId, current, runCache) : []
      if (!active.current || currentScope.current !== scope || ticket !== generation.current) return
      setBatches(matching); setBatch(current); setRuns(records); setError(null)
    } catch (cause) {
      if (active.current && currentScope.current === scope && ticket === generation.current) { setError(cause instanceof Error ? cause.message : String(cause)); setBatch(null); setRuns([]) }
    }
  }, [sessionId, sceneId, kind, scope])

  React.useEffect(() => {
    active.current = true; selected.current = null; cache.current = new Map()
    submittingRef.current = false
    setBatch(null); setBatches([]); setRuns([]); setSubmitting(false)
    void refresh()
    /** 同一用例产生的密集事件合并一次读取，不增加常驻轮询。 */
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.electronAPI.capabilityFactory.onChanged?.((event) => {
      if (event.sessionId !== sessionId || (event.sceneId && event.sceneId !== sceneId)) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { void refresh() }, 80)
    })
    return () => { active.current = false; generation.current += 1; if (timer !== undefined) clearTimeout(timer); unsubscribe?.() }
  }, [sessionId, sceneId, refresh])

  /** 开始一个有限批次；切换页面不会重跑，结果由主进程持久保存。 */
  const start = async (request: Omit<CapabilityFactoryBatchRequest, 'sceneId' | 'kind'>): Promise<void> => {
    if (!active.current || currentScope.current !== scope || submittingRef.current || batches.some((item) => item.status === 'running')) return
    submittingRef.current = true
    selected.current = null; setSubmitting(true); setError(null)
    try {
      await window.electronAPI.capabilityFactory.invoke('runBatch', { sessionId, sceneId, kind, ...request })
      if (active.current && currentScope.current === scope) await refresh()
    } catch (cause) {
      if (active.current && currentScope.current === scope) {
        await refresh()
        if (active.current && currentScope.current === scope) setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (active.current && currentScope.current === scope) { submittingRef.current = false; setSubmitting(false) }
    }
  }

  const running = batches.find((item) => item.status === 'running')
  /** 取消只针对当前会话的精确批次；不回滚已经保存的结果。 */
  const cancel = async (): Promise<void> => {
    if (!running) return
    try {
      const result = await window.electronAPI.capabilityFactory.invoke('cancelBatch', { sessionId, sceneId, batchId: running.id })
      if (!result.cancelled) throw new Error('批次已结束，或不属于当前会话。')
      if (active.current && currentScope.current === scope) await refresh()
    } catch (cause) { if (active.current && currentScope.current === scope) setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  /** 用户显式选取历史记录后，后台事件只更新内容，不改变选择。 */
  const select = (batchId: string): void => { selected.current = batchId; void refresh() }
  return { batches, batch, runs, error, running, busy: submitting || Boolean(running), refresh, start, cancel, select }
}
