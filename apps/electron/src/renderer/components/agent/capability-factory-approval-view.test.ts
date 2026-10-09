import { describe, expect, test } from 'bun:test'
import { describeCapabilityFactoryApproval } from './capability-factory-approval-view'

/** 一份宿主富化后的审批快照。 */
const approval = {
  tool: 'factory_save_draft',
  sceneId: 'scene-1',
  sceneName: '账号状态查询',
  currentVersion: 4,
  changes: [
    { kind: 'steps', detail: '修改 步骤 1 项：params' },
    { kind: 'acceptance', detail: '评审（判据 / 评审提示词 / 指标权重）已修改' },
  ],
  appliesImmediately: false,
  note: '把第 2 步的抽取规则改严',
}

describe('编排工厂审批卡视图', () => {
  test('Given 实际差异与采纳说明 When 投影视图 Then 保留待验证理由且不从原始入参补造测试收益', () => {
    const view = describeCapabilityFactoryApproval('factory_apply_operation', {
      proposal: { expectedBenefit: '伪造原始收益' },
      approval: {
        kind: 'operation', operation: 'adoptDraft', title: '采纳草案', lines: ['v2 → v3'],
        destructive: false, appliesImmediately: true,
        adoption: { changes: ['引用规则：允许改写 → 逐字引用'], rationale: '修正引用格式',
          proposal: { problem: '允许改写易导致无法定位原文', expectedBenefit: '减少引用失配' },
          benefits: [], currentProblems: [], remainingRisks: [], validation: '尚未对比测试' },
      },
    })
    expect(view?.adoption?.changes).toEqual(['引用规则：允许改写 → 逐字引用'])
    expect(view?.adoption?.rationale).toBe('修正引用格式')
    expect(view?.adoption?.proposal?.expectedBenefit).toBe('减少引用失配')
    expect(view?.adoption?.benefits).toEqual([])
  })
  test('Given 采纳审批 When 存在真实对比摘要 Then 分组展示收益、当前问题和剩余限制', () => {
    const view = describeCapabilityFactoryApproval('factory_apply_operation', { approval: {
      kind: 'operation', tool: 'factory_apply_operation', operation: 'adoptDraft', title: '采纳人物提取草案',
      lines: ['v2 -> v3'], destructive: false, appliesImmediately: true,
      adoption: { benefits: ['原文证据引用已修复'], currentProblems: ['当前版有错误引用'], remainingRisks: ['仅验证两个样本'], validation: '2 条同条件对比，候选 2/2 通过' },
    } })
    expect(view?.adoption?.benefits).toEqual(['原文证据引用已修复'])
    expect(view?.adoption?.currentProblems).toEqual(['当前版有错误引用'])
    expect(view?.adoption?.remainingRisks).toEqual(['仅验证两个样本'])
    expect(view?.adoption?.validation).toContain('2/2')
  })
  test('Given 采纳没有可用证据 When 显示审核 Then 明示未验证且不从原始参数伪造收益', () => {
    const view = describeCapabilityFactoryApproval('factory_apply_operation', { benefits: ['完美效果'], approval: {
      kind: 'operation', tool: 'factory_apply_operation', operation: 'adoptDraft', title: '采纳草案',
      lines: ['v2 -> v3'], destructive: false, appliesImmediately: true,
    } })
    expect(view?.adoption?.validation).toContain('未验证')
    expect(view?.adoption?.benefits.join('')).not.toContain('完美效果')
  })
  test('Given 采纳或删除操作 When 显示宿主快照 Then 展示真实影响而非草案提示', () => {
    const view = describeCapabilityFactoryApproval('factory_apply_operation', { approval: {
      kind: 'operation', tool: 'factory_apply_operation', operation: 'deleteScene', title: '删除场景',
      lines: ['场景：测试场景（v3）', '删除此场景'], destructive: true, appliesImmediately: true,
    } })
    expect(view?.title).toBe('删除场景')
    expect(view?.lines).toContain('场景：测试场景（v3）')
    expect(view?.warnings.length).toBeGreaterThan(0)
    expect(view?.lines.join('')).not.toContain('不立即生效')
    expect(describeCapabilityFactoryApproval('factory_apply_operation', { approval: { kind: 'operation' } })).toBeNull()
  })
  test('只对本模块的写入工具生效，其它工具交给各自的视图', () => {
    expect(describeCapabilityFactoryApproval('api_send_request', { approval })).toBeNull()
    expect(describeCapabilityFactoryApproval('factory_list_scenes', {})).toBeNull()
  })

  test('缺少快照时返回 null，让横幅降级到原始展示而不是画一张空卡', () => {
    expect(describeCapabilityFactoryApproval('factory_apply_draft', {})).toBeNull()
    expect(describeCapabilityFactoryApproval('factory_apply_draft', { approval: { changes: 'nope' } })).toBeNull()
  })

  test('逐条列出改动，并标明改的是哪个版本', () => {
    const view = describeCapabilityFactoryApproval('factory_apply_draft', { approval })
    expect(view?.kind).toBe('capability-factory-draft')
    expect(view?.lines[0]).toBe('场景：账号状态查询（当前 v4）')
    expect(view?.lines).toContain('· 修改 步骤 1 项：params')
    expect(view?.lines).toContain('· 评审（判据 / 评审提示词 / 指标权重）已修改')
  })

  test('卡片必须常驻说明"只写草案、不生效" —— 否则用户会以为点下去就改了线上', () => {
    const view = describeCapabilityFactoryApproval('factory_apply_draft', { approval })
    expect(view?.lines.join('\n')).toContain('本次只写入草案，不会改变当前生效的定义')
  })

  test('畸形改动条目被丢弃，不把 undefined 画到卡上', () => {
    const view = describeCapabilityFactoryApproval('factory_apply_draft', {
      approval: { ...approval, changes: [{ kind: 'steps' }, { detail: '正常一条' }, 'bad'] },
    })
    expect(view?.lines).toContain('改动 1 处：')
    expect(view?.lines).toContain('· 正常一条')
  })

  test('与接口工作台视图结构可互换：同样提供 title / files / steps，横幅可走同一条渲染路径', () => {
    const view = describeCapabilityFactoryApproval('factory_apply_draft', { approval })
    expect(typeof view?.title).toBe('string')
    expect(view?.files).toEqual([])
    expect(view?.steps).toEqual([])
  })

  test('虚拟接入走同一套卡：列出能力 id、形状预览、被哪些场景用到，并说明它不进包', () => {
    const view = describeCapabilityFactoryApproval('factory_apply_stub', {
      approval: {
        kind: 'stub',
        tool: 'factory_set_stub',
        capabilityId: 'corpus.build',
        payloadPreview: '{ corpusText: "…24 字", paragraphCount: 0 }',
        usedByScenes: ['小说角色提取'],
        appliesImmediately: false,
        note: '取自真实响应',
      },
    })
    const text = view?.lines.join('\n') ?? ''

    expect(view?.title).toContain('虚拟接入')
    expect(text).toContain('能力：corpus.build')
    expect(text).toContain('corpusText')
    expect(text).toContain('小说角色提取')
    expect(text).toContain('桩不进场景版本、不进能力包')
    /** 形状不对是最贵的错误，卡片必须说清这一条。 */
    expect(text).toContain('字段名与类型必须与真实返回一致')
  })

  test('虚拟接入快照缺字段时返回 null，让横幅降级到原始展示', () => {
    expect(describeCapabilityFactoryApproval('factory_apply_stub', {})).toBeNull()
    expect(describeCapabilityFactoryApproval('factory_apply_stub', {
      approval: { kind: 'stub', capabilityId: 'a.b' },
    })).toBeNull()
    /** 草案形态的快照不该被桩卡片误吃。 */
    expect(describeCapabilityFactoryApproval('factory_apply_stub', { approval })).toBeNull()
  })
})
