import { describe, expect, test } from 'bun:test'
import type { PrototypeDocument } from '@proma/shared'
import { buildPrototypeGroupTree, buildPrototypeHandoffPrompt, buildPrototypePrompt, copyPrototypeDraft, deletePrototypeGroup, deletePrototypePage, movePrototypePage, PrototypeRequestGate } from './interaction-design-model'

/** 独立测试文档包含跨组路由，验证目录操作不会改变业务路径。 */
const document: PrototypeDocument = { schemaVersion: 1, id: 'prototype-a', revision: 7, createdAt: 1, updatedAt: 2, name: '产品', platform: 'mobile', brief: '', groups: [{ id: 'g1', name: '开始' }, { id: 'g2', name: '业务', parentId: 'g1' }], pages: [{ id: 'p1', groupId: 'g1', name: '入口', html: '<h1>入口</h1>' }, { id: 'p2', groupId: 'g1', name: '列表', html: '<h1>列表</h1>' }, { id: 'p3', groupId: 'g2', name: '详情', html: '<h1>详情</h1>' }], entryPageId: 'p1', flows: [{ id: 'f1', fromPageId: 'p1', elementId: 'next', targetPageId: 'p2' }, { id: 'f2', fromPageId: 'p2', elementId: 'next', targetPageId: 'p3' }] }

describe('交互设计 renderer 身份与编辑边界', () => {
  test('Given 原型请求在途 When 切项目再切回 Then 原请求仍不可覆盖新上下文', () => {
    const gate = new PrototypeRequestGate()
    const old = gate.next(); gate.next(); const current = gate.next()
    expect(gate.accepts(old)).toBe(false); expect(gate.accepts(current)).toBe(true)
  })
  test('Given 候选正文 When 修改复制草稿 Then 当前已采纳内容不变', () => {
    const draft = copyPrototypeDraft(document)
    draft.pages[0]!.html = '<h1>候选</h1>'; draft.groups[0]!.name = '新分组'
    expect(document.pages[0]!.html).toBe('<h1>入口</h1>'); expect(document.groups[0]!.name).toBe('开始')
    expect(draft).not.toHaveProperty('revision')
  })
  test('Given 页面带跳转 When 跨组排序 Then 路由和入口保留', () => {
    const next = movePrototypePage(document, 'p2', 'g2', 'p3')
    expect(next.pages.map(page => page.id)).toEqual(['p1', 'p2', 'p3'])
    expect(next.pages[1]!.groupId).toBe('g2'); expect(next.flows).toEqual(document.flows); expect(next.entryPageId).toBe('p1')
    expect(document.pages[1]!.groupId).toBe('g1')
  })
  test('Given 多级分组 When 构建目录树 Then 保留父子顺序并阻止删除非空分组', () => {
    const tree = buildPrototypeGroupTree(document)
    expect(tree.map(item => item.group.id)).toEqual(['g1'])
    expect(tree[0]!.children.map(item => item.group.id)).toEqual(['g2'])
    expect(() => deletePrototypeGroup(document, 'g1')).toThrow('非空')
  })
  test('Given 页面身份失效 When 移动 Then 不产生未知页面或分组', () => {
    expect(movePrototypePage(document, 'missing', 'g2')).toEqual(copyPrototypeDraft(document))
    expect(movePrototypePage(document, 'p2', 'missing')).toEqual(copyPrototypeDraft(document))
  })
  test('Given 中间页面 When 删除 Then 入站和出站连接在同份版本中清理', () => {
    const next = deletePrototypePage(document, 'p2')
    expect(next.pages).toHaveLength(2); expect(next.flows).toHaveLength(0); expect(document.flows).toHaveLength(2)
  })
  test('Given 入口或最后一页 When 删除 Then 阻断而不隐式改入口', () => {
    expect(() => deletePrototypePage(document, 'p1')).toThrow('入口页')
    expect(() => deletePrototypePage({ ...document, pages: [document.pages[1]!] }, 'p2')).toThrow('最后一个页面')
  })
  test('Given 主会话引用 When 构建任务 Then 冻结原型版本和元素且要求候选不直接采纳', () => {
    const prompt = buildPrototypePrompt(document, '修改按钮文案', 'p2', 'submit')
    expect(prompt).toContain('prototypeId: prototype-a'); expect(prompt).toContain('baseRevision: 7'); expect(prompt).toContain('pageId: p2'); expect(prompt).toContain('elementId: submit'); expect(prompt).toContain('勿直接采纳')
  })
  test('Given 同页不同状态共享元素 ID When 引用空态 Then 任务精确携带状态且默认态不冒用状态 ID', () => {
    /** 空数据与有数据的标题身份相同，但修改范围需可区分。 */
    const emptyPrompt = buildPrototypePrompt(document, '修改空态标题', 'p2', 'title', 'empty')
    expect(emptyPrompt).toContain('stateId: empty')
    expect(emptyPrompt).toContain('pageId: p2')
    expect(emptyPrompt).toContain('elementId: title')
    const defaultPrompt = buildPrototypePrompt(document, '修改标题', 'p2', 'title')
    expect(defaultPrompt).toContain('默认状态（page.html')
    expect(defaultPrompt).not.toContain('stateId:')
  })
  test('Given 固定开发交接包 When 构建主会话提示 Then 保留版本、视口和元素身份', () => {
    const prompt = buildPrototypeHandoffPrompt({
      schemaVersion: 1, id: 'handoff-1', prototypeId: 'prototype-a', revision: 7, createdAt: 1, name: '产品', platform: 'mobile', brief: '主路径',
      groups: [{ id: 'g1', name: '开始', path: '开始' }], pages: [{ id: 'p1', name: '入口', groupId: 'g1', groupPath: '开始', elementIds: ['submit'], flowIds: ['f1'] }], entryPageId: 'p1', flows: document.flows, assets: [], designTokens: { '--gap': '16px' }, visualContract: { viewport: { width: 390, height: 844 }, preserve: ['布局比例'] }, manifestHash: 'a'.repeat(64),
    })
    expect(prompt).toContain('prototype_read_version'); expect(prompt).toContain('"revision": 7'); expect(prompt).toContain('"width": 390'); expect(prompt).toContain('submit'); expect(prompt).toContain('--gap')
  })
})
