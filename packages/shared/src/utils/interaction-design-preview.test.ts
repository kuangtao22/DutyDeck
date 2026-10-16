import { runInNewContext } from 'node:vm'
import { describe, expect, test } from 'bun:test'
import { buildPrototypeExport, buildPrototypePreview, parsePrototypePreviewMessage, validatePrototypeStructure } from './interaction-design-preview'
import type { PrototypeDraft } from '../types/interaction-design'

/** 两页测试原型，包含受控字段与显式内部路由。 */
const draft: PrototypeDraft = { name: '测试', platform: 'mobile', brief: '', groups: [{ id: 'g', name: '分组' }], entryPageId: 'home', pages: [
  { id: 'home', groupId: 'g', name: '首页', html: '<button data-prototype-element="next" data-prototype-page="detail">继续</button><img src="prototype-asset:picture">' },
  { id: 'detail', groupId: 'g', name: '详情', html: '<button data-prototype-element="back">返回</button>' },
], flows: [{ id: 'return', fromPageId: 'detail', elementId: 'back', targetPageId: 'home' }] }

describe('交互原型预览合同', () => {
  test('Given 有效页面 When 构建预览 Then 注入先行CSP、模式桥与已授权图片', () => {
    const html = buildPrototypePreview(draft, 'home', { mode: 'play', token: 'token', revision: 1, assets: { picture: 'data:image/png;base64,AAAA' } })
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<button'))
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain("frame-src 'none'")
    expect(html).toContain("e.source!==host")
    expect(html).toContain("e.data.token!==config.token")
    expect(html).toContain('e.isTrusted')
    expect(html).toContain('prototype-mode')
    expect(html).toContain('data:image/png;base64,AAAA')
    expect(html).not.toContain('prototype-asset:picture')
  })
  test('Given 不受信图片与缺失页 When 构建 Then 拒绝协议注入和错误页面', () => {
    expect(buildPrototypePreview(draft, 'home', { mode: 'select', token: 'token', revision: 1, assets: { picture: 'https://example.com/image.png' } })).not.toContain('https://example.com')
    expect(() => buildPrototypePreview(draft, 'missing', { mode: 'play', token: 'token', revision: 1, assets: {} })).toThrow('页面不存在')
  })
  test('Given 不可信桥消息 When 解析 Then 只接受有限身份和正确字段', () => {
    const valid = { type: 'prototype-select' as const, token: 'token', pageId: 'home', revision: 1, elementId: 'next' }
    expect(parsePrototypePreviewMessage(valid)).toEqual(valid)
    for (const invalid of [null, {}, { ...valid, revision: NaN }, { ...valid, token: '' }, { ...valid, elementId: '../bad' }, { ...valid, type: 'save' }]) expect(parsePrototypePreviewMessage(invalid)).toBeNull()
  })
  test('Given 声明完整的两页闭环 When 结构检查 Then 不报告问题但不产生体验证据', () => {
    expect(validatePrototypeStructure(draft)).toEqual([])
    const broken = structuredClone(draft)
    broken.pages[0]!.html = '<span data-prototype-element="same"></span><span data-prototype-element="same"></span>'
    broken.flows[0]!.elementId = 'missing'
    expect(validatePrototypeStructure(broken)).toEqual(expect.arrayContaining(['首页：受控元素 ID 重复', '详情：连接元素 missing 不存在', '详情：从入口页不可达']))
  })
  test('Given 内含script闭合标签的页面 When 导出 Then 数据不能逃逸且仅创建一个iframe', () => {
    const html = buildPrototypeExport(draft, {})
    expect(html.match(/<iframe\b/g)).toHaveLength(1)
    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).toContain('e.source!==frame.contentWindow')
    expect(html).toContain('\\u003cbutton')
  })
})

test('Given 同元素HTML路由与流程冲突 When 检查 Then 采用流程优先级且报告失效路径', () => {
  /** 原首页声明到详情，但流程覆盖为返回首页，详情实际不可达。 */
  const conflict = structuredClone(draft)
  conflict.flows.push({ id: 'override', fromPageId: 'home', elementId: 'next', targetPageId: 'home' })
  expect(validatePrototypeStructure(conflict)).toEqual(expect.arrayContaining([
    '首页：元素 next 的 HTML 路由与流程连接冲突，预览采用流程目标 home',
    '详情：从入口页不可达',
  ]))
})

test('Given 注释脚本伪路由和无引号真实声明 When 检查 Then 只使用实际开始标签声明', () => {
  /** 正文中的脚本和注释不会创建可点击元素。 */
  const source = structuredClone(draft)
  source.pages[0]!.html = '<!-- <button data-prototype-page="detail"> --><script>const demo="<a data-prototype-page=detail>"</script><button title="a > b" data-prototype-element=next>继续</button>'
  expect(validatePrototypeStructure(source)).toContain('详情：从入口页不可达')
  source.flows.push({ id: 'forward', fromPageId: 'home', elementId: 'next', targetPageId: 'detail' })
  expect(validatePrototypeStructure(source)).toEqual([])
})

test('Given 同页多状态 When 预览与结构校验 Then 正文隔离且跨状态元素允许复用', () => {
  /** 附加状态含不同正文及默认状态已有的稳定元素。 */
  const source = structuredClone(draft)
  source.pages[0]!.states = [{ id: 'empty', name: '无数据', html: '<button data-prototype-element="next" data-prototype-page="detail">EMPTY_STATE_ONLY</button>' }]
  expect(validatePrototypeStructure(source)).toEqual([])
  const options = { mode: 'play' as const, token: 'token', revision: 1, assets: {} }
  expect(buildPrototypePreview(source, 'home', options)).not.toContain('EMPTY_STATE_ONLY')
  expect(buildPrototypePreview(source, 'home', { ...options, stateId: 'empty' })).toContain('EMPTY_STATE_ONLY')
  expect(() => buildPrototypePreview(source, 'home', { ...options, stateId: 'missing' })).toThrow('页面状态不存在')
  source.pages[0]!.states[0]!.html += '<button data-prototype-element="next" data-prototype-page="missing">重复</button>'
  expect(validatePrototypeStructure(source)).toEqual(expect.arrayContaining(['首页 / 无数据：受控元素 ID 重复', '首页 / 无数据：导航目标 missing 不存在']))
})

test('Given 流程元素仅在附加状态存在 When 检查 Then 不误报缺失元素', () => {
  const source = structuredClone(draft)
  source.pages[1]!.html = '<p>默认</p>'
  source.pages[1]!.states = [{ id: 'empty', name: '无数据', html: '<button data-prototype-element="back">返回</button>' }]
  expect(validatePrototypeStructure(source)).toEqual([])
  const message = { type: 'prototype-select' as const, token: 'token', pageId: 'home', stateId: 'empty', revision: 1, elementId: 'next' }
  expect(parsePrototypePreviewMessage(message)).toEqual(message)
  expect(parsePrototypePreviewMessage({ ...message, stateId: '../invalid' })).toBeNull()
})


test('Given 离线多状态导出 When 切换状态与跨页跳转 Then 状态可浏览且导航恢复默认', () => {
  /** 运行真实导出脚本，最小DOM替身仅承接select和iframe操作。 */
  const source = structuredClone(draft)
  source.pages[0]!.states = [{ id: 'empty', name: '无数据', html: '<p>EMPTY_VIEW</p>' }]
  const frame = { srcdoc: '', contentWindow: {} }
  const createSelect = () => ({ value: '', onchange: undefined as (() => void) | undefined, append(_option: unknown) {}, replaceChildren() {} })
  const pageSelect = createSelect()
  const stateSelect = createSelect()
  const nav = { hidden: false }
  let onMessage: ((event: { source: object; data: object }) => void) | undefined
  const html = buildPrototypeExport(source, {})
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))
  runInNewContext(script, {
    document: { querySelector(selector: string) { return selector === 'iframe' ? frame : nav }, querySelectorAll() { return [pageSelect, stateSelect] }, createElement() { return { value: '', textContent: '' } } },
    window: { addEventListener(_type: string, listener: typeof onMessage) { onMessage = listener } },
  })
  expect(nav.hidden).toBe(false)
  expect(frame.srcdoc).not.toContain('EMPTY_VIEW')
  stateSelect.value = 'empty'
  stateSelect.onchange!()
  expect(frame.srcdoc).toContain('EMPTY_VIEW')
  onMessage!({ source: frame.contentWindow, data: { type: 'prototype-navigate', token: 'offline-prototype', pageId: 'home', stateId: 'empty', revision: 0, targetPageId: 'detail' } })
  expect(pageSelect.value).toBe('detail')
  expect(stateSelect.value).toBe('')
  pageSelect.value = 'home'
  pageSelect.onchange!()
  expect(frame.srcdoc).not.toContain('EMPTY_VIEW')
})
