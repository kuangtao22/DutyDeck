import { describe, expect, test } from 'bun:test'
import type { CapabilityFactoryApi, CapabilityFactoryBatch, CapabilityRun } from '@proma/shared'
import { loadFactoryBatchRuns, describeFactoryBatchStatus } from './capability-factory-batch-view'

describe('持久批次证据读取', () => {
  test('Given 超过最近历史窗口的运行 When 按批次读取 Then 精确按 ID 获取并复用缓存', async () => {
    /** 部分记录足以证明读取使用身份而非最近历史排序。 */
    const run = { id: 'old-run', sceneId: 'scene', status: 'succeeded' } as CapabilityRun
    const calls: string[] = []
    const api = { invoke: async (_method: string, input: { runId: string }) => { calls.push(input.runId); return run } } as CapabilityFactoryApi
    const batch = { sceneId: 'scene', items: [{ baselineRunId: 'old-run', candidateRunId: 'old-run' }] } as CapabilityFactoryBatch
    const cache = new Map<string, CapabilityRun>()
    expect(await loadFactoryBatchRuns(api, 'session', 'scene', batch, cache)).toEqual([run])
    await loadFactoryBatchRuns(api, 'session', 'scene', batch, cache)
    expect(calls).toEqual(['old-run'])
  })
  test('Given 外场景证据 When 读取 Then 不注入当前视图', async () => {
    const api = { invoke: async () => ({ id: 'run', sceneId: 'other' }) } as CapabilityFactoryApi
    const batch = { sceneId: 'scene', items: [{ runId: 'run' }] } as CapabilityFactoryBatch
    await expect(loadFactoryBatchRuns(api, 'session', 'scene', batch, new Map())).rejects.toThrow('不匹配')
    expect(describeFactoryBatchStatus('interrupted')).toBe('已中断')
    expect(describeFactoryBatchStatus('cancelled')).toBe('已停止')
  })
})
