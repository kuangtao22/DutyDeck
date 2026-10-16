import { expect, test } from 'bun:test'
import type { CanvasTarget, MediaRunSnapshot } from '@proma/shared'
import { createCanvasSessionIdleGuard } from './canvas-session-idle-guard'

/** 测试中的完整 Canvas 身份。 */
const target: CanvasTarget = { projectId: 'project-1', canvasId: 'canvas-1' }

test('Given 媒体登记异步读取 When 新任务或既有任务状态变化 Then 最终同步检查拒删并释放订阅', async () => {
  /** 模拟模块读取结果尚未返回。 */
  const loading = Promise.withResolvers<string[]>()
  /** 期间收到的真实运行提交监听。 */
  let listener: ((run: MediaRunSnapshot) => void) | undefined
  /** 所有运行的最新权威阶段。 */
  const phases = new Map<string, MediaRunSnapshot['phase']>([['old', 'succeeded']])
  /** 准入后可变化的普通任务状态。 */
  let busy = false
  /** 只读取本图媒体运行，不接受其它画布的来源。 */
  const guard = createCanvasSessionIdleGuard({
    assertSynchronousIdle: () => { if (busy) throw new Error('BUSY_AGENT') },
    loadRunIds: () => loading.promise,
    runs: {
      get: (_projectId, runId) => ({ phase: phases.get(runId)! }),
      getOrigin: (_projectId, runId) => ({ canvasMedia: { ...target, canvasId: runId === 'foreign' ? 'other' : target.canvasId } }),
      subscribe: (callback) => { listener = callback; return () => { listener = undefined } },
    },
  })
  /** 开始异步准备删除检查。 */
  const prepared = guard(target)
  phases.set('new', 'prepared')
  listener?.({ id: 'new', projectId: target.projectId } as MediaRunSnapshot)
  loading.resolve(['old'])
  /** 检查必须捕获尚未登记到模块的运行。 */
  const check = await prepared
  expect(() => check.assertIdle()).toThrow('CANVAS_SESSION_BUSY')
  phases.set('new', 'cancelled')
  phases.set('old', 'running')
  expect(() => check.assertIdle()).toThrow('CANVAS_SESSION_BUSY')
  phases.set('old', 'succeeded')
  busy = true
  expect(() => check.assertIdle()).toThrow('BUSY_AGENT')
  busy = false
  listener?.({ id: 'foreign', projectId: target.projectId } as MediaRunSnapshot)
  expect(() => check.assertIdle()).not.toThrow()
  check.dispose()
  expect(listener).toBeUndefined()
})

test('Given 媒体登记读取失败 When 准备删除 Then 保留失败并自动释放订阅', async () => {
  /** 活跃订阅数用于证明异常不会泄漏观察者。 */
  let subscriptions = 0
  /** 读取失败的业务依赖。 */
  const guard = createCanvasSessionIdleGuard({
    assertSynchronousIdle: () => undefined,
    loadRunIds: async () => { throw new Error('READ_FAILED') },
    runs: {
      get: () => ({ phase: 'succeeded' }), getOrigin: () => ({}),
      subscribe: () => { subscriptions += 1; return () => { subscriptions -= 1 } },
    },
  })
  await expect(guard(target)).rejects.toThrow('READ_FAILED')
  expect(subscriptions).toBe(0)
})
