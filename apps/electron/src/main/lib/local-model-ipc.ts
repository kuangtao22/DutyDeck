/** DutyDeck 本地模型 IPC：只允许主窗口请求固定资产，不能传入路径、URL 或执行参数。 */
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { LOCAL_MODEL_IPC_CHANNELS, type LocalModelAssetInput, type LocalModelEnabledInput, type LocalModelTestInput } from '@proma/shared'
import { getLocalModelRuntime } from './local-model-runtime-singleton'
import type { LocalModelRuntime } from './local-model-runtime'

/** 主窗口身份校验由 IPC 装配层提供；测试可注入不带 Electron 的替身。 */
export interface LocalModelIpcDependencies {
  runtime?: LocalModelRuntime
  assertSender: (event: IpcMainInvokeEvent) => void
  listTargets?: () => readonly Pick<WebContents, 'isDestroyed' | 'send'>[]
}

/** 校验 renderer DTO 的键集合，避免把未声明的 URL/路径等扩散进运行时。 */
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('本地模型操作参数无效')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('本地模型操作包含未知参数')
  return value
}

/** 稳定资产标识为单段，不允许目录或任意模型别名。 */
function asset(input: unknown, keys: readonly string[] = ['assetId']): LocalModelAssetInput {
  const value = record(input, keys)
  if (typeof value.assetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value.assetId) || value.assetId.includes('..')) throw new Error('本地模型资产 ID 无效')
  return { assetId: value.assetId }
}

/** 测试统一执行全部能力探测；用户输入只作为普通回复试用内容。 */
function testInput(input: unknown): LocalModelTestInput {
  const keys = ['assetId', 'prompt', 'includeToolCall', 'includeJson']
  const parsed = asset(input, keys)
  const value = record(input, keys)
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 4000) throw new Error('测试提示词应为 1–4000 个字符')
  for (const key of ['includeToolCall', 'includeJson']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('能力测试参数无效')
  return { ...parsed, prompt: value.prompt.trim(), includeToolCall: true, includeJson: true }
}

/** 只接受显式布尔开关，不能用字符串或 null 隐式开启。 */
function enabledInput(input: unknown): LocalModelEnabledInput {
  const parsed = asset(input, ['assetId', 'enabled'])
  const value = record(input, ['assetId', 'enabled'])
  if (typeof value.enabled !== 'boolean') throw new Error('模型启用状态无效')
  return { ...parsed, enabled: value.enabled }
}

/** 环境安装操作不接受任何路径、版本或 URL 参数。 */
function emptyInput(input: unknown): void {
  if (input !== undefined) record(input, [])
}

/** 注册四层 IPC 的主进程实现；返回值回收状态广播订阅。 */
export function registerLocalModelIpcHandlers(ipc: Pick<IpcMain, 'handle'>, dependencies: LocalModelIpcDependencies): () => void {
  const runtime = dependencies.runtime ?? getLocalModelRuntime()
  const broadcast = (channel: string, payload: unknown): void => {
    for (const target of dependencies.listTargets?.() ?? []) if (!target.isDestroyed()) target.send(channel, payload)
  }
  const unsubscribeSnapshot = runtime.subscribe((snapshot) => broadcast(LOCAL_MODEL_IPC_CHANNELS.CHANGED, snapshot))
  const unsubscribeProgress = runtime.subscribeProgress((progress) => broadcast(LOCAL_MODEL_IPC_CHANNELS.PROGRESS, progress))
  /** 所有入口先校验实际 sender，再解释参数或做副作用。 */
  const handle = (channel: string, operation: (input: unknown) => unknown): void => {
    ipc.handle(channel, (event, input: unknown) => { dependencies.assertSender(event); return operation(input) })
  }
  handle(LOCAL_MODEL_IPC_CHANNELS.LIST, () => runtime.listSnapshot())
  handle(LOCAL_MODEL_IPC_CHANNELS.DOWNLOAD, (input) => runtime.download(asset(input)))
  handle(LOCAL_MODEL_IPC_CHANNELS.CANCEL_DOWNLOAD, (input) => runtime.cancelDownload(asset(input)))
  handle(LOCAL_MODEL_IPC_CHANNELS.START, (input) => runtime.start(asset(input)))
  handle(LOCAL_MODEL_IPC_CHANNELS.STOP, () => runtime.stop())
  handle(LOCAL_MODEL_IPC_CHANNELS.TEST, (input) => runtime.test(testInput(input)))
  handle(LOCAL_MODEL_IPC_CHANNELS.SET_ENABLED, (input) => { const parsed = enabledInput(input); return runtime.setEnabled(parsed.assetId, parsed.enabled) })
  handle(LOCAL_MODEL_IPC_CHANNELS.ENGINE_DOWNLOAD, (input) => { emptyInput(input); return runtime.downloadEngine() })
  handle(LOCAL_MODEL_IPC_CHANNELS.ENGINE_CANCEL_DOWNLOAD, (input) => { emptyInput(input); runtime.cancelEngineDownload() })
  return () => { unsubscribeSnapshot(); unsubscribeProgress() }
}
