import type { InteractionDesignInputs, InteractionDesignMethod, InteractionDesignResults, PrototypeJob } from '@proma/shared'
import type { InteractionDesignExecutor } from './access'

/** 单轮主会话只结算本轮签发的任务；不扫描、接管其他运行的任务。 */
export function createInteractionDesignRun(sessionId: string, access: InteractionDesignExecutor, cleanup: InteractionDesignExecutor) {
  /** 本轮实际 beginJob 返回的可信身份，不采纳模型提供的任意任务。 */
  const ownedJobs = new Map<string, PrototypeJob>()
  return {
    async execute<M extends InteractionDesignMethod>(method: M, input: InteractionDesignInputs[M], signal?: AbortSignal): Promise<InteractionDesignResults[M]> {
      const result = await access.execute(method, input, signal)
      if (method === 'beginJob') {
        const job = result as PrototypeJob
        ownedJobs.set(job.id, job)
      }
      return result
    },
    /**
     * 收尾只更新仍等待结果的本轮任务，服务端保持 candidate/failed/cancelled 不变。
     * cleanup 固定原项目归属并检查当前权限，但允许已结束的运行保存真实终态。
     */
    async finish(stopped: boolean): Promise<void> {
      const errors: unknown[] = []
      for (const job of ownedJobs.values()) {
        try {
          if (stopped) await cleanup.execute('cancelJob', { sessionId, prototypeId: job.prototypeId, jobId: job.id })
          else await cleanup.execute('failJob', { sessionId, prototypeId: job.prototypeId, jobId: job.id, message: '本轮 Agent 已结束，未提交可预览候选；可根据主会话结果重新发起。' })
        } catch (error) { errors.push(error) }
      }
      ownedJobs.clear()
      if (errors.length) throw new AggregateError(errors, '部分原型任务终态未能保存')
    },
  }
}
