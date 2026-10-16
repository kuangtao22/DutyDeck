import { describe, expect, test } from 'bun:test'
import { parseInteractionDesignCommand, parsePrototypeDraft, PROTOTYPE_LIMITS } from './interaction-design-validation'
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


describe('业务页面与附加状态合同', () => {
  test('Given 旧页面 When 解析 Then 不补状态字段且保持原内容身份输入', () => {
    expect(parsePrototypeDraft(draft())).toEqual(draft())
    expect(parsePrototypeDraft(draft()).pages[0]).not.toHaveProperty('states')
    expect(parsePrototypeDraft(draft()).pages[0]).not.toHaveProperty('defaultStateName')
  })
  test('Given 同页不同状态 When 解析 Then 保留名称正文且允许跨页面复用状态身份', () => {
    /** 各页各自拥有空状态。 */
    const value = draft()
    value.pages = value.pages.map(page => ({ ...page, defaultStateName: '有数据', states: [{ id: 'empty', name: '无数据', html: '<p>暂无记录</p>' }] }))
    expect(parsePrototypeDraft(value)).toEqual(value)
    expect(parsePrototypeDraft(value).pages).toHaveLength(2)
  })
  test('Given 重复状态或超限内容 When 解析 Then 拒绝且状态正文计入整体预算', () => {
    /** 单页状态边界样本。 */
    const value = draft()
    value.pages[0]!.states = [{ id: 'empty', name: '无数据', html: '' }, { id: 'empty', name: '加载', html: '' }]
    expect(() => parsePrototypeDraft(value)).toThrow('重复')
    value.pages[0]!.states = Array.from({ length: 13 }, (_, index) => ({ id: `state-${index}`, name: '状态', html: '' }))
    expect(() => parsePrototypeDraft(value)).toThrow('状态集合')
    value.pages[0]!.states = [{ id: 'empty', name: '无数据', html: 'x'.repeat(PROTOTYPE_LIMITS.pageChars + 1) }]
    expect(() => parsePrototypeDraft(value)).toThrow('状态 HTML')
    value.pages = value.pages.map(page => ({ ...page, states: Array.from({ length: 12 }, (_, index) => ({ id: `state-${index}`, name: '状态', html: 'x'.repeat(PROTOTYPE_LIMITS.pageChars) })) }))
    expect(() => parsePrototypeDraft(value)).toThrow('预算')
  })
})

describe('项目还原任务合同', () => {
  test('Given 页面规划 When 开始项目还原任务 Then 保留分组状态和源码证据', () => {
    const plan = {
      schemaVersion: 1,
      summary: '按路由拆分业务页面',
      groups: [{ id: 'core', name: '核心导航' }],
      pages: [{
        id: 'home', name: '首页', groupId: 'core', route: '/', role: '核心入口', entry: true,
        defaultStateName: '有数据',
        states: [{ id: 'empty', name: '无数据' }],
        evidence: [{ path: 'src/routes.tsx', sourceKind: 'code', relation: 'route', hash: 'a'.repeat(64) }],
      }],
      entryPageId: 'home',
      flows: [],
      unresolved: ['错误状态尚未在源码中确认'],
    }
    const parsed = parseInteractionDesignCommand({ method: 'beginJob', input: {
      sessionId: 'session-1', prototypeId: 'proto-1', baseRevision: 1,
      instruction: '根据现有项目拆分多页面', mode: 'project-restore', plan,
    } as never })
    expect(parsed.input).toMatchObject({ mode: 'project-restore', plan })
  })

  test('Given 项目还原任务 When 解析页面清单 Then 保留模式与页面边界', () => {
    const parsed = parseInteractionDesignCommand({ method: 'beginJob', input: {
      sessionId: 'session-1', prototypeId: 'proto-1', baseRevision: 1,
      instruction: '根据现有项目拆分多页面', mode: 'project-restore',
      pageManifest: [{ id: 'home', name: '首页' }, { id: 'settings', name: '设置' }],
    } })
    expect(parsed.input).toMatchObject({ mode: 'project-restore', pageManifest: [{ id: 'home', name: '首页' }, { id: 'settings', name: '设置' }] })
  })
})
