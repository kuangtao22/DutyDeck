import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createEmptySceneDefinition } from '@proma/shared'
import { CapabilityFactoryModelSettings } from './CapabilityFactoryModelSettings'

describe('场景模型设置', () => {
  test('Given 当前场景 When 尚未打开模型设置 Then 只显示弹窗按钮而不铺开表单', () => {
    /** 最小场景用于检查标题栏入口默认不占用正文空间。 */
    const scene = { id: 's', currentVersion: 1, createdAt: 1, updatedAt: 1, draft: null,
      definition: { ...createEmptySceneDefinition('测试'), modelSlots: [{ id: 'main', model: 'declared-model', description: '主模型' }] } }
    /** 静态渲染不触发 IPC，也不依赖窗口环境。 */
    const html = renderToStaticMarkup(<CapabilityFactoryModelSettings sessionId="session" scene={scene} onSceneChanged={() => undefined} />)
    expect(html).toContain('模型设置')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('<details')
    expect(html).not.toContain('评审模型')
  })
})
