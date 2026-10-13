import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { LocalModelSnapshot } from '@proma/shared'
import { localModelSnapshotAtom } from '@/atoms/local-model-atoms'
import { LocalModelEngineCard } from './LocalModelEngineCard'

/** 使用关于页真实组件验证引擎安装入口与已就绪态的分工。 */
function renderEngine(engine: NonNullable<LocalModelSnapshot['engine']>): string {
  const store = createStore()
  const snapshot: LocalModelSnapshot = { catalog: [], assets: [], engine, runtime: { state: 'idle', endpointReady: false }, updatedAt: 1 }
  store.set(localModelSnapshotAtom, snapshot)
  return renderToStaticMarkup(<Provider store={store}><LocalModelEngineCard /></Provider>)
}

describe('关于页本地推理引擎卡片', () => {
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
