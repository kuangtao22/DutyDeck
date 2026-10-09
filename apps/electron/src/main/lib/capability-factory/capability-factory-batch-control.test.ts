import { describe, expect, test } from 'bun:test'
import { cancelCapabilityFactoryBatch, withCapabilityFactoryBatchControl } from './capability-factory-batch-control'

describe('工厂批次宿主生命周期', () => {
  test('Given 正在运行的批次 When 其它会话取消 Then 拒绝且原会话可以停止', async () => {
    /** 回调启动后再验证取消归属，避免计时器参与测试。 */
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const running = withCapabilityFactoryBatchControl({ rootDir: '/fixture/one', sessionId: 's1', sceneId: 'scene',
      execute: async (signal, bind) => {
        bind('batch-1'); started()
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return signal.aborted
      },
    })
    await ready
    expect(cancelCapabilityFactoryBatch('/fixture/one', 's2', 'scene', 'batch-1')).toBe(false)
    expect(cancelCapabilityFactoryBatch('/fixture/two', 's1', 'scene', 'batch-1')).toBe(false)
    expect(cancelCapabilityFactoryBatch('/fixture/one', 's1', 'scene', 'batch-1')).toBe(true)
    expect(await running).toBe(true)
    expect(cancelCapabilityFactoryBatch('/fixture/one', 's1', 'scene', 'batch-1')).toBe(false)
  })

  test('Given 同场景批次尚未结束 When 重复启动 Then 拒绝并在结束后释放锁', async () => {
    let release!: () => void
    const running = withCapabilityFactoryBatchControl({ rootDir: '/fixture/lock', sessionId: 's1', sceneId: 'scene',
      execute: async () => new Promise<void>((resolve) => { release = resolve }),
    })
    await expect(withCapabilityFactoryBatchControl({ rootDir: '/fixture/lock', sessionId: 's2', sceneId: 'scene',
      execute: async () => 1,
    })).rejects.toThrow('已有批次')
    release(); await running
    expect(await withCapabilityFactoryBatchControl({ rootDir: '/fixture/lock', sessionId: 's2', sceneId: 'scene', execute: async () => 2 })).toBe(2)
  })

  test('Given Agent 停止信号 When 批次执行 Then 传入同一取消语义且异常释放注册', async () => {
    const controller = new AbortController()
    await expect(withCapabilityFactoryBatchControl({ rootDir: '/fixture/abort', sessionId: 's1', sceneId: 'scene', signal: controller.signal,
      execute: async (signal, bind) => { bind('batch'); controller.abort(); expect(signal.aborted).toBe(true); throw new Error('取消测试') },
    })).rejects.toThrow('取消测试')
    expect(cancelCapabilityFactoryBatch('/fixture/abort', 's1', 'scene', 'batch')).toBe(false)
  })
})
