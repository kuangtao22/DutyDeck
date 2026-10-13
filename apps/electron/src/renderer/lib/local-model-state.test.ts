import { describe, expect, test } from 'bun:test'
import type { LocalModelAsset, LocalModelSnapshot } from '@proma/shared'
import { localModelControls, localModelStatus } from './local-model-state'

/** 构造最小本地模型快照，覆盖下载、加载和启用边界。 */
function fixture(overrides: Partial<LocalModelAsset> = {}, runtime: Partial<LocalModelSnapshot['runtime']> = {}, engine: LocalModelSnapshot['engine'] = undefined): { asset: LocalModelAsset; snapshot: LocalModelSnapshot } {
  const asset: LocalModelAsset = { assetId: 'qwen', modelId: 'qwen', name: 'Qwen', family: 'qwen', revision: 'r1', fileName: 'qwen.gguf', sha256: 'sha', sizeBytes: 1, status: 'installed', enabled: false, capability: { state: 'unknown' }, updatedAt: 1, installedAt: 1, ...overrides }
  return { asset, snapshot: { catalog: [], assets: [asset], engine, runtime: { state: 'idle', endpointReady: false, ...runtime }, updatedAt: 1 } }
}

describe('本地模型状态合同', () => {
  test('Given 已安装文件损坏 When 加载失败 Then 仍提供重新下载修复入口', () => {
    const { asset, snapshot } = fixture({ status: 'error', lastError: 'SHA-256 校验失败' })
    expect(localModelControls(asset, snapshot).canRedownload).toBe(true)
    expect(localModelControls(asset, snapshot).canStart).toBe(true)
  })
  test('Given 任务持有模型 When 查看设置 Then 禁止停止而不改启用开关', () => {
    const { asset, snapshot } = fixture({ enabled: true }, { state: 'running', assetId: 'qwen', endpointReady: true, busy: true })
    expect(localModelControls(asset, snapshot).canStop).toBe(false)
    expect(asset.enabled).toBe(true)
  })
  test('Given 已安装但未验证模型 When 计算控制项 Then 禁止启用但允许加载', () => {
    const { asset, snapshot } = fixture()
    const controls = localModelControls(asset, snapshot)
    expect(controls.canStart).toBe(true)
    expect(controls.canEnable).toBe(false)
    expect(localModelStatus(asset.status)).toBe('已安装，未加载')
  })
  test('Given 主进程正在下载 When 页面重进 Then 仍可取消且显示下载中', () => {
    const { asset, snapshot } = fixture({ status: 'downloading' })
    const controls = localModelControls(asset, snapshot)
    expect(controls.downloading).toBe(true)
    expect(controls.canStart).toBe(false)
    expect(localModelStatus(asset.status)).toBe('下载中')
  })
  test('Given 运行中并通过能力检查 When 启用 Then 允许开关', () => {
    const { asset, snapshot } = fixture({ capability: { state: 'available' } }, { state: 'running', assetId: 'qwen', endpointReady: true })
    expect(localModelControls(asset, snapshot).canEnable).toBe(true)
    expect(localModelControls(asset, snapshot).loaded).toBe(true)
  })
  test('Given llama.cpp 尚未安装 When 计算模型控制项 Then 下载、加载和启用全部锁定', () => {
    const { asset, snapshot } = fixture({ status: 'not-installed', installedAt: undefined }, {}, { state: 'not-installed', available: false, source: 'none' })
    const controls = localModelControls(asset, snapshot)
    expect(controls.canDownload).toBe(false)
    expect(controls.canStart).toBe(false)
    expect(controls.canEnable).toBe(false)
  })
  test('Given llama.cpp 已校验安装 When 模型尚未下载 Then 只解锁模型下载', () => {
    const { asset, snapshot } = fixture({ status: 'not-installed', installedAt: undefined }, {}, { state: 'installed', available: true, source: 'user' })
    const controls = localModelControls(asset, snapshot)
    expect(controls.canDownload).toBe(true)
    expect(controls.canStart).toBe(false)
    expect(controls.canEnable).toBe(false)
  })
})
