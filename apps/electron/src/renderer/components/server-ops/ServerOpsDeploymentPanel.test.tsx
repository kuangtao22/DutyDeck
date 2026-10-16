import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ServerOpsDeploymentPanel } from './ServerOpsDeploymentPanel'

describe('部署双 Tab 面板', () => {
  test('Given 未连接飞牛 When 渲染发布页 Then 显示连接门禁和证据未完成提示', () => {
    const html = renderToStaticMarkup(<ServerOpsDeploymentPanel projectId="10000000-0000-4000-8000-000000000001" hostId="10000000-0000-4000-8000-000000000002" connected={false} active />)
    expect(html).toContain('发布版本')
    expect(html).toContain('部署历史')
    expect(html).toContain('连接飞牛 NAS 后才能读取和检查 Compose 现场')
    expect(html).toContain('发布暂未开放')
  })
  test('Given 首期尚未具备完整产物与迁移证据 When 渲染 Then 发布按钮保持禁用', () => {
    const html = renderToStaticMarkup(<ServerOpsDeploymentPanel projectId="10000000-0000-4000-8000-000000000001" hostId="10000000-0000-4000-8000-000000000002" connected active />)
    expect(html).toContain('待完成镜像 digest、数据库迁移与恢复证据后开放')
  })
})
