import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createApiRequestDraft } from '@proma/shared'
import type { ApiRequestDefinition } from '@proma/shared'
import { ApiRequestDocumentation } from './ApiRequestDocumentation'

/** 创建包含公开值、秘密值和响应约束的已保存接口定义。 */
function requestFixture(): ApiRequestDefinition {
  return {
    ...createApiRequestDraft('collection-1'),
    id: 'request-1',
    revision: 7,
    updatedAt: Date.UTC(2026, 9, 8),
    name: '创建订单',
    folder: '订单/写入',
    description: '创建一笔待支付订单。',
    method: 'POST',
    url: '{{baseUrl}}/orders',
    query: [
      { id: 'query-1', name: 'dryRun', value: 'true', enabled: true },
      { id: 'query-2', name: 'internal', value: 'secret-query', enabled: false, secret: true },
    ],
    headers: [
      { id: 'header-1', name: 'X-Trace', value: '{{traceId}}', enabled: true },
      { id: 'header-2', name: 'Authorization', value: 'Bearer secret-token', enabled: true, secret: true },
    ],
    auth: { type: 'bearer', value: { value: 'auth-secret', secret: true } },
    body: { kind: 'json', text: '{"sku":"A-1","quantity":1}', fields: [] },
    assertions: [{ id: 'assert-1', kind: 'status', path: '', expected: '201' }],
    extractions: [{ id: 'extract-1', name: 'orderId', from: 'json', path: 'data.id', secret: false }],
    cases: [{ id: 'case-1', name: '库存充足', assertions: [], source: 'user' }],
  }
}

describe('接口只读文档', () => {
  test('Given 已保存请求 When 查看文档 Then 展示保存版本与真实请求结构且隐藏秘密值', () => {
    const html = renderToStaticMarkup(<ApiRequestDocumentation request={requestFixture()} collectionName="交易接口" />)
    expect(html).toContain('创建订单')
    expect(html).toContain('保存版本 7')
    expect(html).toContain('POST')
    expect(html).toContain('{{baseUrl}}/orders')
    expect(html).toContain('创建一笔待支付订单')
    expect(html).toContain('dryRun')
    expect(html).toContain('true')
    expect(html).toContain('X-Trace')
    expect(html).toContain('{{traceId}}')
    expect(html).toContain('已配置秘密值')
    expect(html).not.toContain('secret-token')
    expect(html).not.toContain('auth-secret')
    expect(html).not.toContain('secret-query')
    expect(html).toContain('{&quot;sku&quot;:&quot;A-1&quot;,&quot;quantity&quot;:1}')
  })

  test('Given 请求仅定义断言和提取规则 When 查看响应文档 Then 不编造响应 schema', () => {
    const html = renderToStaticMarkup(<ApiRequestDocumentation request={requestFixture()} collectionName="交易接口" />)
    expect(html).toContain('未定义响应结构')
    expect(html).toContain('状态码等于 201')
    expect(html).toContain('data.id')
    expect(html).toContain('orderId')
    expect(html).not.toContain('响应字段')
    expect(html).not.toContain('response schema')
  })

  test('Given 没有已保存请求 When 打开文档 Then 引导先保存而不展示草稿', () => {
    const html = renderToStaticMarkup(<ApiRequestDocumentation request={null} collectionName={null} />)
    expect(html).toContain('选择一条已保存请求')
    expect(html).toContain('未保存草稿不会生成文档')
  })

  test('Given 保存定义包含未标记凭据 When 查看文档 Then URL、字段和正文按名称脱敏', () => {
    const request = requestFixture()
    request.url = 'https://api.example.test/orders?token=url-secret&safe=visible'
    request.headers = [{ id: 'header-token', name: 'X-Api-Key', value: 'header-secret', enabled: true }]
    request.query = [{ id: 'query-password', name: 'password', value: 'query-secret', enabled: true }]
    request.body = { kind: 'json', text: '{"token":"body-secret","sku":"A-1"}', fields: [] }
    const html = renderToStaticMarkup(<ApiRequestDocumentation request={request} collectionName="交易接口" />)
    expect(html).toContain('safe=visible')
    expect(html).toContain('A-1')
    expect(html).not.toContain('url-secret')
    expect(html).not.toContain('header-secret')
    expect(html).not.toContain('query-secret')
    expect(html).not.toContain('body-secret')
  })

  test('Given 秘密字段尚未写入值或引用 When 查看文档 Then 显示待填写', () => {
    const request = requestFixture()
    request.query = []
    request.headers = [{ id: 'empty-secret', name: 'Authorization', value: '', enabled: true, secret: true }]
    const html = renderToStaticMarkup(<ApiRequestDocumentation request={request} collectionName="交易接口" />)
    expect(html).toContain('待填写')
    expect(html).not.toContain('已配置秘密值')
  })
})
