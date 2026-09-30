import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChannelAuthorizationNotice } from './ChannelAuthorizationNotice'

describe('Copilot 授权结果展示', () => {
  test('Given 授权成功且目录为空 When 展示反馈 Then 明确暂无可用模型', () => {
    /** 空目录授权反馈，不应提示可立即使用。 */
    const html = renderToStaticMarkup(<ChannelAuthorizationNotice enabledModelCount={0} onViewModels={() => {}} onDismiss={() => {}} />)
    expect(html).toContain('当前订阅暂无可用模型')
    expect(html).not.toContain('现在可在 Agent')
  })
  test('Given 授权成功且目录有模型 When 展示反馈 Then 提供 Agent 使用入口说明', () => {
    /** 两个已授权模型的成功反馈。 */
    const html = renderToStaticMarkup(<ChannelAuthorizationNotice enabledModelCount={2} onViewModels={() => {}} onDismiss={() => {}} />)
    expect(html).toContain('2 个模型已启用')
    expect(html).toContain('role="status"')
    expect(html).toContain('查看模型')
  })
})
