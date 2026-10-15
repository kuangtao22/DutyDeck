import { describe, expect, test } from 'bun:test'
import { KnowledgeRunReferences } from './project-knowledge-references'

describe('知识运行短引用', () => {
  test('Given 来源已发现 When 以短引用读取 Then 保留所见版本并拒绝混用', () => {
    const refs = new KnowledgeRunReferences()
    const sourceRef = refs.source({ entryId: 'entry', revision: 'old-version' })
    expect(refs.resolveSource({ sourceRef })).toEqual({ entryId: 'entry', revision: 'old-version' })
    expect(() => refs.resolveSource({ sourceRef, entryId: 'entry', revision: 'new-version' })).toThrow('混用')
    expect(() => new KnowledgeRunReferences().resolveSource({ sourceRef })).toThrow('本轮')
  })
  test('Given 已读页 When 引用其他页面的文本 Then 拒绝冒用并允许已读逐字证据', () => {
    const refs = new KnowledgeRunReferences()
    const pageRef = refs.page({ entryId: 'entry', revision: 'version' }, 0, '会员仅永久有效')
    expect(refs.resolveEvidence({ pageRef, quote: '仅永久' })).toEqual({ entryId: 'entry', revision: 'version', quote: '仅永久' })
    expect(() => refs.resolveEvidence({ pageRef, quote: '月度有效' })).toThrow('已读页')
    expect(() => refs.resolveEvidence({ sourceRef: refs.source({ entryId: 'entry', revision: 'version' }), quote: '仅永久' })).toThrow('页面')
  })
  test('Given 流程目标已见 When 使用旧目标 Then 固定旧版本而非自动升级', () => {
    const refs = new KnowledgeRunReferences()
    const targetRef = refs.target({ planRevision: 2, outlineRevision: 3, itemId: 'item', expectedRevision: null })
    expect(refs.resolveTarget({ targetRef })).toEqual({ planRevision: 2, outlineRevision: 3, itemId: 'item', expectedRevision: null })
    expect(() => refs.resolveTarget({ targetRef, planRevision: 4 })).toThrow('混用')
  })
})

test('Given 引用失效 When 宿主拒绝 Then 机器可读错误保持中文原因与恢复建议', () => {
  const refs = new KnowledgeRunReferences()
  try { refs.resolveSource({ sourceRef: 'src_previous_run' }) } catch (error) {
    expect(error).toMatchObject({ code: 'invalid_reference', recoverable: true, scope: 'reference', action: 'read_status_or_search' })
    expect((error as Error).message).toContain('不属于本轮')
    return
  }
  throw new Error('应拒绝旧运行引用')
})
