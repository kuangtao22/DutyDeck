import { atom } from 'jotai'
import type { LocalModelProgressEvent, LocalModelSnapshot, LocalModelTestResult } from '@proma/shared'

/** 权威快照及过程进度跨设置页保留，重新进入时仍会向主进程校准。 */
export const localModelSnapshotAtom = atom<LocalModelSnapshot | null>(null)
export const localModelProgressAtom = atom<Record<string, LocalModelProgressEvent>>({})
/** 操作和错误按资产保存，页面退出不会清除尚未结束的请求。 */
export const localModelPendingAtom = atom<Record<string, string | undefined>>({})
export const localModelErrorsAtom = atom<Record<string, string | undefined>>({})
export const localModelLoadErrorAtom = atom<string | null>(null)
/** 唯一测试弹窗的草稿与回执，重新打开可继续检查结果。 */
export const localModelTestAssetAtom = atom<string | null>(null)
export const localModelPromptAtom = atom('帮我把“本周发布新版本”拆成 3 个可执行的任务。')
export const localModelTestResultsAtom = atom<Record<string, LocalModelTestResult | undefined>>({})

/** 接收快照只前进不回退，避免初次查询覆盖更新事件。 */
export const acceptLocalModelSnapshotAtom = atom(null, (get, set, snapshot: LocalModelSnapshot) => {
  if (snapshot.updatedAt >= (get(localModelSnapshotAtom)?.updatedAt ?? 0)) set(localModelSnapshotAtom, snapshot)
})

/** 接收 IPC 异常，返回去除 Electron 通道包装的可读诊断；普通业务错误保持原文。 */
function localModelErrorMessage(error: unknown): string {
  // Electron invoke 拒绝在业务诊断外添加通道与异常类型，界面不需要展示这些协议细节。
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/, '')
}

/** 重新读取权威状态；读取失败保留当前内容并显示可重试错误。 */
export const refreshLocalModelsAtom = atom(null, async (_get, set) => {
  try {
    set(acceptLocalModelSnapshotAtom, await window.electronAPI.listLocalModels())
    set(localModelLoadErrorAtom, null)
  } catch (error) {
    set(localModelLoadErrorAtom, localModelErrorMessage(error))
  }
})

/** 页面操作合同；取消独立于正在等待的下载/启动承诺。 */
interface LocalModelAction { assetId?: string; action: 'engine-download' | 'engine-cancel' | 'download' | 'cancel' | 'start' | 'stop' | 'test' | 'toggle' }
/** 执行 IPC 并重新读取快照，不在 renderer 推测已安装或启用状态。 */
export const performLocalModelActionAtom = atom(null, async (get, set, input: LocalModelAction) => {
  const { action } = input
  const assetId = input.assetId ?? 'engine'
  // 取消下载和停止加载有独立槽位，不能被它们所取消的长操作阻挡。
  const key = action === 'engine-cancel' || action === 'cancel' || action === 'stop' ? `${assetId}:cancel` : assetId
  if (get(localModelPendingAtom)[key]) return
  set(localModelPendingAtom, (previous) => ({ ...previous, [key]: action }))
  set(localModelErrorsAtom, (previous) => ({ ...previous, [assetId]: undefined }))
  try {
    if (action === 'engine-download') await window.electronAPI.downloadLocalModelEngine()
    if (action === 'engine-cancel') await window.electronAPI.cancelLocalModelEngineDownload()
    if (action === 'download') await window.electronAPI.downloadLocalModel({ assetId })
    if (action === 'cancel') await window.electronAPI.cancelLocalModelDownload({ assetId })
    if (action === 'start') await window.electronAPI.startLocalModel({ assetId })
    if (action === 'stop') await window.electronAPI.stopLocalModel()
    if (action === 'test') {
      set(localModelTestResultsAtom, (previous) => ({ ...previous, [assetId]: undefined }))
      const result = await window.electronAPI.testLocalModel({ assetId, prompt: get(localModelPromptAtom).trim(), includeToolCall: true, includeJson: true })
      set(localModelTestResultsAtom, (previous) => ({ ...previous, [assetId]: result }))
    }
    if (action === 'toggle') {
      const asset = get(localModelSnapshotAtom)?.assets.find((item) => item.assetId === assetId)
      if (!asset || (!asset.enabled && asset.capability.state !== 'available')) throw new Error('请先加载模型并通过能力测试')
      await window.electronAPI.setLocalModelEnabled({ assetId, enabled: !asset.enabled })
    }
  } catch (error) {
    set(localModelErrorsAtom, (previous) => ({ ...previous, [assetId]: localModelErrorMessage(error) }))
  } finally {
    set(localModelPendingAtom, (previous) => ({ ...previous, [key]: undefined }))
    await set(refreshLocalModelsAtom)
  }
})
