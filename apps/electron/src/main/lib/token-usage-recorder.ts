/** 主进程唯一写入入口；统计故障不改变已产生的模型响应。 */
import { join } from 'node:path'
import type { TokenUsageRecord } from '@proma/shared'
import { getConfigDir } from './config-paths'
import { TokenUsageStore } from './token-usage-store'

/** 延迟初始化避免模块加载时访问真实业务根，便于隔离测试。 */
let store: TokenUsageStore | undefined
/** 最近写入故障使统计页显式提示，不能静默宣称覆盖完整。 */
let recordingError: string | undefined

/** 取得进程固定数据根内的独立账本。 */
export function getTokenUsageStore(): TokenUsageStore {
  return store ??= new TokenUsageStore(join(getConfigDir(), 'token-usage'))
}
/** 可注入账本便于离线验证调用链；undefined 恢复生产延迟解析。 */
export function setTokenUsageStoreForTest(value: TokenUsageStore | undefined): void { store = value; recordingError = undefined }
/** 快照查询可展示采集错误，同时保留已经成功写入的部分。 */
export function getTokenUsageRecordingError(): string | undefined { return recordingError }
/** 在允许模型调用前固定统计起点，防止首次调用结束前的原生记录被当作历史重复导入。 */
export function initializeTokenUsageRecording(): void {
  try { getTokenUsageStore().coverage() } catch {
    recordingError = 'Token 统计初始化失败，采集可能不完整。请检查数据目录的可用空间和权限。'
    console.warn('[Token 统计] 初始化失败，正常会话继续运行')
  }
}
/** 调用方传入已冻结元数据；失败只记录统计故障，绝不影响模型业务终态。 */
export function recordTokenUsage(record: TokenUsageRecord): void {
  try { getTokenUsageStore().record(record) } catch {
    recordingError = '部分调用记录未能保存，本次运行的统计可能不完整。请检查数据目录的可用空间和权限。'
    console.warn('[Token 统计] 调用记录保存失败，模型响应不受影响')
  }
}
