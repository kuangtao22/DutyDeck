import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { AgentFileChangeCapture, AgentRunFileChangesSnapshot } from '@proma/shared'
import { AgentRunFileTracker } from './agent-run-file-tracker'
import { subscribeAgentFileObservations } from './agent-file-observation-bus'

/** 单轮记录器的依赖；持久化和事件发送由已验证会话身份的编排层提供。 */
interface RunOptions {
  cwd: string
  roots: string[]
  files?: string[]
  startedAt: number
  persist: (snapshot: AgentRunFileChangesSnapshot) => void
  publish: (snapshot: AgentRunFileChangesSnapshot) => void
  /** 会话仍存在且未删除，允许保存旧轮自己的独立历史文件。 */
  isValid: () => boolean
  /** 是否仍为最新运行；旧轮不再观察或重读新轮的工作区。 */
  isCurrent?: () => boolean
}
/** 正在执行的采集器；只保存本轮有界基线，结束即释放。 */
const activeRuns = new Set<RunFileChanges>()

/** 将工具路径解析到运行目录，兼容 Pi 的 home 写法。 */
function normalizePath(path: string, cwd: string): string {
  return resolve(cwd, path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path)
}
// 复用既有监听，不创建第二套 fs.watch；同一共享根只有唯一工具证据才能归属。
subscribeAgentFileObservations((path) => {
  // Git 元数据会触发右侧累计差异刷新，但不属于业务文件修改。
  if (path.split(/[\\/]/).includes('.git')) return
  const candidates = [...activeRuns].filter(run => run.owns(path))
  const evidenced = candidates.filter(run => run.tracker.hasControlledPath(path))
  const owner = candidates.length === 1 ? candidates[0] : evidenced.length === 1 ? evidenced[0] : undefined
  if (owner) owner.tracker.observe([path])
  else for (const run of candidates) {
    run.unattributed = true
    run.tracker.invalidate(path)
  }
})

/** 主进程内的运行记录器，跨 Pi 重试共用；捕获失败只降低统计，不改变业务结果。 */
class RunFileChanges {
  /** 每个文件至多一次基线，tracker 自行执行容量与真实路径校验。 */
  readonly tracker: AgentRunFileTracker
  /** 写类工具的精确路径证据，避免把共享根的变化猜给某个会话。 */
  readonly touched = new Set<string>()
  /** 无法归属或达到采集预算时，不宣称总计完整。 */
  unattributed = false
  /** 结束标记防止旧 run 收尾后继续污染历史。 */
  private ended = false
  /** 递增版本抵御读取历史和实时推送之间的竞态。 */
  private revision = 0
  /** 采集超时后的路径永久降级，迟到的 before 也不能重新变成精确统计。 */
  private readonly invalidated = new Set<string>()
  /** 串行化捕获和收尾，取消发生在采集过程中也必须等待它落盘。 */
  private pending: Promise<void> = Promise.resolve()

  constructor(readonly options: RunOptions) {
    this.tracker = new AgentRunFileTracker(options)
    activeRuns.add(this)
  }

  /** 判断监听信号是否属于本轮显式授权范围；不读取路径内容。 */
  owns(path: string): boolean {
    if (this.ended || !this.options.isValid() || this.options.isCurrent?.() === false) return false
    return this.tracker.owns(path)
  }

  /** 接收权限通过后的采集阶段，返回可等待的完成边界。 */
  capture(capture: AgentFileChangeCapture): Promise<void> {
    if (this.ended) return Promise.resolve()
    if (capture.phase === 'invalidate' && capture.path && this.owns(capture.path)) {
      const path = normalizePath(capture.path, this.options.cwd)
      if (this.invalidated.size < 256) this.invalidated.add(path)
      this.unattributed = true
      this.tracker.observe([path])
    }
    this.pending = this.pending.then(async () => {
      if (!this.options.isValid() || this.options.isCurrent?.() === false) return
      if (capture.phase === 'before' && capture.path) {
        const absolute = normalizePath(capture.path, this.options.cwd)
        if (!this.owns(absolute)) return
        if (this.touched.size < 256) this.touched.add(absolute)
        else this.unattributed = true
        await this.tracker.before(capture.path)
      } else if (capture.phase === 'after' && capture.path) {
        await this.tracker.after(capture.path)
        await this.save()
      } else if (capture.phase === 'invalidate') {
        await this.save()
      } else if (capture.phase === 'verify') {
        await this.tracker.verify()
        await this.save()
      }
    }).catch(error => { this.unattributed = true; console.warn('[本轮文件统计] 采集失败', error) })
    return this.pending
  }

  /** 保存纯元数据；目录监听信号不作为文件行展示，缺失路径保留删除证据。 */
  private async save(endedAt?: number): Promise<void> {
    if (!this.options.isValid()) return
    const files = this.tracker.snapshot().map(file => this.invalidated.has(file.path)
      ? { path: file.path, status: 'unknown' as const, statsState: 'unavailable' as const } : file)
    const visible = await Promise.all(files.map(async file => {
      if (file.status !== 'unknown') return file
      try { return (await lstat(file.path)).isDirectory() ? null : file } catch { return file }
    }))
    const snapshot: AgentRunFileChangesSnapshot = {
      runId: String(this.options.startedAt), startedAt: this.options.startedAt,
      revision: ++this.revision, ...(endedAt !== undefined ? { endedAt } : {}),
      files: visible.filter(file => file !== null),
      ...(this.unattributed || this.tracker.truncated ? { hasUnattributedChanges: true } : {}),
    }
    // 先落盘再推送，重启与实时界面的数字使用同一份快照。
    this.options.persist(snapshot)
    this.options.publish(snapshot)
  }

  /** 等待未完成采集并冻结结果；之后的外部写入不能更改历史数字。 */
  async finish(): Promise<void> {
    if (this.ended) return
    this.ended = true
    activeRuns.delete(this)
    await this.pending
    try {
      if (this.options.isValid() && this.options.isCurrent?.() !== false) await this.tracker.verify()
      else if (this.options.isValid()) {
        // 新轮已开始，无法再验证旧轮最终内容；保存旧轮未知状态，不读新轮文件。
        this.unattributed = true
        for (const file of this.tracker.snapshot()) this.invalidated.add(file.path)
      }
      await this.save(Date.now())
    } catch (error) { console.warn('[本轮文件统计] 收尾失败', error) }
  }
}

/** 创建一轮独立采集器；调用方必须在 finally 中 finish。 */
export function createAgentRunFileChanges(options: RunOptions): RunFileChanges {
  return new RunFileChanges(options)
}
