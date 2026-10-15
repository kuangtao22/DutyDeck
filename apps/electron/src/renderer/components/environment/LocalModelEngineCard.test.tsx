import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { LocalModelSnapshot } from '@proma/shared'
import { localModelErrorsAtom, localModelPendingAtom, localModelSnapshotAtom } from '@/atoms/local-model-atoms'
import { LocalModelEngineCard } from './LocalModelEngineCard'

/** 使用关于页真实组件验证引擎安装入口与已就绪态的分工。 */
function renderEngine(engine: NonNullable<LocalModelSnapshot['engine']>, pending: Record<string, string> = {}, error?: string): string {
  const store = createStore()
  const snapshot: LocalModelSnapshot = { catalog: [], assets: [], engine, runtime: { state: 'idle', endpointReady: false }, updatedAt: 1 }
  store.set(localModelSnapshotAtom, snapshot)
  store.set(localModelPendingAtom, pending)
  store.set(localModelErrorsAtom, { engine: error })
  return renderToStaticMarkup(<Provider store={store}><LocalModelEngineCard /></Provider>)
}

describe('关于页本地推理引擎卡片', () => {
  test('Given 安装请求在途 When 渲染取消入口 Then 可取消且仅取消请求在途时禁用', () => {
    // 两种 pending 状态应只影响各自的操作入口。
    const engine = { state: 'downloading' as const, available: false, source: 'none' as const }
    const activeHtml = renderEngine(engine, { engine: 'engine-download' })
    const cancellingHtml = renderEngine(engine, { engine: 'engine-download', 'engine:cancel': 'engine-cancel' })
    expect(activeHtml).toContain('取消安装')
    expect(activeHtml).not.toContain('disabled=')
    expect(cancellingHtml).toContain('disabled=')
  })

  test('Given 权威安装错误和 IPC 错误同时存在 When 渲染 Then 优先展示权威诊断', () => {
    const html = renderEngine({ state: 'error', available: false, source: 'none', message: '下载连接超时，请检查代理设置' }, {}, 'fetch failed')
    expect(html).toContain('下载连接超时，请检查代理设置')
    expect(html).not.toContain('fetch failed')
  })

  test('Given 引擎未安装 When 渲染 Then 展示安装入口和锁定说明', () => {
    const html = renderEngine({ state: 'not-installed', available: false, source: 'none', version: 'b11429' })
    expect(html).toContain('llama.cpp 推理引擎')
    expect(html).toContain('安装运行环境')
    expect(html).toContain('模型配置页才会解锁下载、加载和测试')
  })

  test('Given 引擎已安装 When 渲染 Then 不再展示重复安装入口而提供模型管理入口', () => {
    const html = renderEngine({ state: 'installed', available: true, source: 'user', version: 'b11429' })
    expect(html).toContain('已安装')
    expect(html).toContain('管理本地模型')
    expect(html).not.toContain('安装运行环境')
  })
})
