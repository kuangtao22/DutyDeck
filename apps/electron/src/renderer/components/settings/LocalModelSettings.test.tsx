import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { LocalModelAsset, LocalModelSnapshot } from '@proma/shared'
import { localModelSnapshotAtom } from '@/atoms/local-model-atoms'
import { LocalModelSettings } from './LocalModelSettings'

/** 使用实际组件与独立 Jotai store 验证重进页后的操作状态。 */
function renderModel(assetOverrides: Partial<LocalModelAsset> = {}, engine: LocalModelSnapshot['engine'] = undefined): string {
  const store = createStore()
  const asset: LocalModelAsset = { assetId: 'qwen', modelId: 'qwen', name: 'Qwen', family: 'qwen', revision: 'r1', fileName: 'qwen.gguf', sha256: 'sha', sizeBytes: 1024, status: 'installed', enabled: false, capability: { state: 'unknown' }, installedAt: 1, updatedAt: 1, ...assetOverrides }
  const snapshot: LocalModelSnapshot = { catalog: [], assets: [asset], engine, runtime: { state: 'idle', endpointReady: false }, updatedAt: 1 }
  store.set(localModelSnapshotAtom, snapshot)
  return renderToStaticMarkup(<Provider store={store}><LocalModelSettings /></Provider>)
}

describe('本地模型真实组件输出', () => {
  test('Given 已安装未加载 When 渲染 Then 展示加载且测试与启用禁用', () => {
    const html = renderModel()
    expect(html).toContain('已安装，未加载')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>测试<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="启用 Qwen"/)
    expect(html).not.toContain('模型 ID（')
  })
  test('Given 下载来自先前页面 When 重进设置 Then 取消按钮仍可操作', () => {
    const html = renderModel({ status: 'downloading', installedAt: undefined })
    const cancel = html.match(/<button[^>]*>取消下载<\/button>/)?.[0]
    expect(cancel).toBeDefined()
    expect(cancel).not.toContain('disabled=')
    expect(html).toContain('下载进度')
  })
  test('Given 下载错误 When 渲染 Then 展示真实失败与重试入口', () => {
    const html = renderModel({ status: 'error', installedAt: undefined, lastError: '哈希校验失败' })
    expect(html).toContain('哈希校验失败')
    expect(html).toContain('重试下载')
    expect(html).toContain('role="alert"')
  })
  test('Given llama.cpp 未安装 When 渲染 Then 展示环境状态跳转并锁定模型下载', () => {
    const html = renderModel({ status: 'not-installed', installedAt: undefined }, { state: 'not-installed', available: false, source: 'none', version: 'b11429' })
    expect(html).toContain('llama.cpp 推理引擎')
    expect(html).toContain('前往关于/更新安装')
    expect(html).toContain('安装并校验 llama.cpp 后，模型下载按钮才会解锁。')
    expect(html).not.toMatch(/<button[^>]*>下载<\/button>/)
  })
})
