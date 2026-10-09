import type { CapabilityFactoryApi, CapabilityFactoryBatch, CapabilityFactoryBatchStatus, CapabilityRun } from '@proma/shared'

/** 返回真实批次终态文案；“完成”仅指执行结束，质量另行展示。 */
export function describeFactoryBatchStatus(status: CapabilityFactoryBatchStatus): string {
  return { running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断' }[status]
}

/** 按批次精确读取完整证据；缓存仅用于已完成运行，并由调用方按会话场景隔离。 */
export async function loadFactoryBatchRuns(
  api: CapabilityFactoryApi, sessionId: string, sceneId: string, batch: CapabilityFactoryBatch,
  cache: Map<string, CapabilityRun>,
): Promise<CapabilityRun[]> {
  if (batch.sceneId !== sceneId) throw new Error('批次场景不匹配')
  const ids = [...new Set(batch.items.flatMap((item) => [item.runId, item.baselineRunId, item.candidateRunId])
    .filter((id): id is string => Boolean(id)))]
  return Promise.all(ids.map(async (runId) => {
    const run = cache.get(runId) ?? await api.invoke('getRun', { sessionId, sceneId, runId })
    if (!run || run.id !== runId || run.sceneId !== sceneId) throw new Error('批次运行证据缺失或身份不匹配')
    if (run.status !== 'running' && run.review?.status !== 'running') cache.set(runId, run)
    return run
  }))
}
