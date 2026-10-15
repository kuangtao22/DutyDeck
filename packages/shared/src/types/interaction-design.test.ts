import { describe, expect, test } from 'bun:test'
import { parseInteractionDesignCommand, parsePrototypeDraft } from './interaction-design-validation'
import type { PrototypeDraft } from './interaction-design'

/** 测试一条双页面路径，目录排序与连接独立。 */
function draft(): PrototypeDraft {
  return { name: '现有项目原型', platform: 'desktop', brief: '本地样例数据', groups: [{ id: 'main', name: '主要流程' }], pages: [{ id: 'home', groupId: 'main', name: '首页', html: '<button data-prototype-element="next">继续</button>' }, { id: 'detail', groupId: 'main', name: '详情', html: '<h1>详情</h1>' }], entryPageId: 'home', flows: [{ id: 'next-link', fromPageId: 'home', elementId: 'next', targetPageId: 'detail' }] }
}

describe('交互设计完整版本合同', () => {
  test('Given 两个页面 When 调整目录顺序 Then 保留原有交互路由', () => {
    const value = draft()
    value.pages.reverse()
    expect(parsePrototypeDraft(value).flows[0]?.targetPageId).toBe('detail')
  })
  test('Given 入口或分组丢失 When 解析 Then 拒绝半个版本', () => {
    expect(() => parsePrototypeDraft({ ...draft(), entryPageId: 'missing' })).toThrow('入口')
    expect(() => parsePrototypeDraft({ ...draft(), groups: [{ id: 'other', name: '其他' }] })).toThrow('分组')
  })
  test('Given 多级页面分组 When 解析 Then 保留父子关系并拒绝循环', () => {
    const base = draft()
    const nested = { ...base, groups: [{ id: 'root', name: '产品' }, { id: 'account', name: '账号', parentId: 'root' }, { id: 'settings', name: '设置', parentId: 'account' }], pages: [{ ...base.pages[0]!, groupId: 'settings' }, { ...base.pages[1]!, groupId: 'account' }] }
    expect(parsePrototypeDraft(nested).groups[2]!.parentId).toBe('account')
    expect(() => parsePrototypeDraft({ ...nested, groups: [{ id: 'root', name: '产品', parentId: 'settings' }, ...nested.groups.slice(1)] })).toThrow('分组')
  })
  test('Given 重复身份或动作 When 解析 Then 不容许模糊映射', () => {
    const value = draft()
    expect(() => parsePrototypeDraft({ ...value, pages: [...value.pages, value.pages[0]] })).toThrow('重复')
    expect(() => parsePrototypeDraft({ ...value, flows: [...value.flows, { ...value.flows[0], id: 'another' }] })).toThrow('多个跳转')
  })
  test('Given 模型附带权限/版本字段 When 保存 Then 只保留正文白名单', () => {
    const parsed = parseInteractionDesignCommand({ method: 'save', input: { sessionId: 'session-1', prototypeId: 'proto-1', baseRevision: 1, draft: { ...draft(), workspaceId: 'forged', revision: 99 }, summary: '局部修改', approved: true } })
    expect(parsed.input).not.toHaveProperty('approved')
    expect(parsed.input).not.toHaveProperty('draft.workspaceId')
    expect(parsed.input).not.toHaveProperty('draft.revision')
  })
  test('Given 页面入口创建请求 When 带页面名称 Then 保留页面名称并过滤未知字段', () => {
    const parsed = parseInteractionDesignCommand({ method: 'create', input: { sessionId: 'session-1', name: '内部空间', pageName: '登录页', platform: 'mobile', workspaceId: 'forged' } })
    expect(parsed.input).toEqual({ sessionId: 'session-1', name: '内部空间', pageName: '登录页', platform: 'mobile' })
  })
  test.each(['../secret.txt', '/etc/passwd', '.env', 'src/.private/key', 'C:\\secret', 'src/../../secret'])('Given 非法来源 %s When 读取 Then 拒绝', (path) => {
    expect(() => parseInteractionDesignCommand({ method: 'readSource', input: { sessionId: 'session-1', paths: [path] } })).toThrow()
  })
  test('Given 采纳请求缺基线或版本非整数 When 解析 Then 拒绝', () => {
    expect(() => parseInteractionDesignCommand({ method: 'adopt', input: { sessionId: 'session-1', prototypeId: 'proto-1', candidateId: 'candidate-1' } })).toThrow()
    expect(() => parseInteractionDesignCommand({ method: 'restore', input: { sessionId: 'session-1', prototypeId: 'proto-1', baseRevision: 1.1, revision: 1 } })).toThrow()
  })
  test('Given 固定版本 When 创建开发交接请求 Then 只接受明确的原型与版本', () => {
    const parsed = parseInteractionDesignCommand({ method: 'createHandoff', input: { sessionId: 'session-1', prototypeId: 'proto-1', revision: 3, ignored: true } })
    expect(parsed.input).toEqual({ sessionId: 'session-1', prototypeId: 'proto-1', revision: 3 })
    expect(() => parseInteractionDesignCommand({ method: 'createHandoff', input: { sessionId: 'session-1', prototypeId: 'proto-1', revision: 0 } })).toThrow()
  })
  test('Given 历史版本删除请求 When 缺少基线或版本无效 Then 拒绝越权删除', () => {
    /** 合法删除请求必须同时携带当前基线和历史目标。 */
    const parsed = parseInteractionDesignCommand({ method: 'deleteVersion', input: { sessionId: 'session-1', prototypeId: 'proto-1', baseRevision: 3, revision: 2 } })
    expect(parsed.input).toEqual({ sessionId: 'session-1', prototypeId: 'proto-1', baseRevision: 3, revision: 2 })
    expect(() => parseInteractionDesignCommand({ method: 'deleteVersion', input: { sessionId: 'session-1', prototypeId: 'proto-1', revision: 2 } })).toThrow()
    expect(() => parseInteractionDesignCommand({ method: 'deleteVersion', input: { sessionId: 'session-1', prototypeId: 'proto-1', baseRevision: 3, revision: 0 } })).toThrow()
  })
  test('Given 危险对象键 When 解析 Then 拒绝', () => {
    expect(() => parseInteractionDesignCommand({ method: 'load', input: { sessionId: 'session-1', prototypeId: '__proto__' } })).toThrow()
  })
})
