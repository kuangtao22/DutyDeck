import { describe, expect, test } from 'bun:test'
import { assessKnowledgeAdmission, knowledgeEvidenceHash } from './admission'
import type { KnowledgeAdmissionInput } from '@proma/shared'

/** 可追溯的规则评估样本。 */
const assessment: KnowledgeAdmissionInput = {
  contentType: 'rule', importance: 'high', purpose: '回答会员权益', scope: '首发版本',
  claims: [{ statement: '永久会员可以更换图标。', evidenceIndexes: [0] }],
  coverage: [{ topic: '会员类型限制', status: 'covered', reason: '保留永久会员限定' }],
  issues: [], outcome: 'eligible',
}
/** 固定来源引文。 */
const evidence = [{ entryId: 'source', revision: 'rev', quote: '永久会员可以更换图标。' }]

describe('知识内容准入', () => {
  test('Given 规则与有效映射 When 校验 Then 绑定正文与证据哈希', () => {
    const result = assessKnowledgeAdmission(assessment, '# 权益\n永久会员可以更换图标。', evidence)
    expect(result?.status).toBe('eligible')
    expect(result?.contentHash).toHaveLength(64)
    expect(result?.evidenceHash).toHaveLength(64)
  })
  test('Given 模型宣称达标但有缺口 When 校验 Then 降为待补', () => {
    expect(assessKnowledgeAdmission({ ...assessment, issues: ['月度权益待核'] }, '永久会员可以更换图标。', evidence)?.status).toBe('needs_evidence')
  })
  test('Given 虚构正文断言或不存在的证据 When 校验 Then 拒绝', () => {
    expect(() => assessKnowledgeAdmission(assessment, '所有会员都有权益', evidence)).toThrow('正文')
    expect(() => assessKnowledgeAdmission(assessment, '永久会员可以更换图标。', [])).toThrow('证据')
    expect(() => assessKnowledgeAdmission({ ...assessment, claims: [{ statement: '永久会员可以更换图标。', evidenceIndexes: [], usesUserEvidence: true }] }, '永久会员可以更换图标。', [])).toThrow('用户')
  })
  test('Given 关键断言无证据或覆盖有缺口 When 评估 Then 不信任 eligible 声明', () => {
    expect(assessKnowledgeAdmission({ ...assessment, claims: [] }, '正文', evidence)?.status).toBe('needs_evidence')
    expect(assessKnowledgeAdmission({ ...assessment, coverage: [{ topic: '恢复', status: 'gap', reason: '未核验' }] }, '永久会员可以更换图标。', evidence)?.status).toBe('needs_evidence')
    expect(assessKnowledgeAdmission({ ...assessment, claims: [{ statement: '正文', evidenceIndexes: [] }] }, '正文', [])?.status).toBe('needs_evidence')
  })
  test('Given 用户证据或来源版本变化 When 计算绑定摘要 Then 旧评估不能复用', () => {
    /** 相同原句的新消息身份仍需新评估绑定。 */
    const original = { sessionId: 'session', messageId: 'message-1', quote: '业务规则' }
    expect(knowledgeEvidenceHash(evidence, original)).not.toBe(knowledgeEvidenceHash(evidence, { ...original, messageId: 'message-2' }))
    expect(knowledgeEvidenceHash(evidence, original)).not.toBe(knowledgeEvidenceHash([{ ...evidence[0]!, revision: 'new-revision' }], original))
    expect(knowledgeEvidenceHash(evidence, original)).not.toBe(knowledgeEvidenceHash(evidence, { ...original, quote: '新业务规则' }))
  })
  test('Given 旧用户证据缺完整消息指纹 When 模型宣称达标 Then 降为待补', () => {
    expect(assessKnowledgeAdmission({ ...assessment, claims: [{ statement: '正文', evidenceIndexes: [], usesUserEvidence: true }] }, '正文', [],
      { sessionId: 'session', messageId: 'message', quote: '正文' })?.status).toBe('needs_evidence')
  })
  test('Given 旧调用没有评估 When 保存 Then 保持未评估', () => {
    expect(assessKnowledgeAdmission(undefined, '旧正文', [])).toBeUndefined()
  })
})
