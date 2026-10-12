import { createHash } from 'node:crypto'
import type { KnowledgeAdmissionInput, KnowledgeAdmissionRecord, KnowledgeEntry } from '@proma/shared'

/** 对正文或证据绑定串计算稳定摘要。 */
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 检查有界必填文字，拒绝仅空白和超大评估。 */
function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw new Error(`知识准入${label}非法`)
}

/** 固定顺序绑定实际证据，避免信任 Agent 传入的摘要。 */
export function knowledgeEvidenceHash(evidence: KnowledgeEntry['evidence'], userEvidence?: KnowledgeEntry['userEvidence']): string {
  return hash(JSON.stringify({ evidence: evidence ?? [], userEvidence: userEvidence ?? null }))
}

/** 校验正文原句、证据下标和覆盖声明；语义支持仍由 Agent 与人工评估。 */
export function assessKnowledgeAdmission(
  input: KnowledgeAdmissionInput | undefined,
  content: string,
  evidence: NonNullable<KnowledgeEntry['evidence']>,
  userEvidence?: KnowledgeEntry['userEvidence'],
): KnowledgeAdmissionRecord | undefined {
  if (input === undefined) return undefined
  if (!input || JSON.stringify(input).length > 65536) throw new Error('知识准入评估非法或过长')
  if (!['fact', 'rule', 'decision', 'procedure', 'plan', 'hypothesis', 'history'].includes(input.contentType)
    || !['high', 'normal'].includes(input.importance)
    || !['eligible', 'needs_evidence'].includes(input.outcome)) throw new Error('知识准入类型非法')
  requireText(input.purpose, '用途')
  requireText(input.scope, '范围')
  if (input.asOf !== undefined) requireText(input.asOf, '截至时间')
  if (!Array.isArray(input.claims) || input.claims.length > 32
    || !Array.isArray(input.coverage) || input.coverage.length > 32
    || !Array.isArray(input.issues) || input.issues.length > 32) throw new Error('知识准入覆盖结构非法')
  /** 没有关键断言或覆盖说明，不能仅靠 outcome 通过。 */
  let incomplete = input.claims.length === 0 || input.coverage.length === 0
    || Boolean(userEvidence && (!userEvidence.sha256 || !/^[a-f0-9]{64}$/.test(userEvidence.sha256)))
  for (const claim of input.claims) {
    if (!claim) throw new Error('知识准入断言非法')
    requireText(claim.statement, '正文断言')
    if (!content.includes(claim.statement)) throw new Error('知识准入断言不在正文中')
    if (!Array.isArray(claim.evidenceIndexes) || claim.evidenceIndexes.length > 8
      || claim.evidenceIndexes.some((index) => !Number.isInteger(index) || index < 0 || !evidence[index])) throw new Error('知识准入证据映射非法')
    if (claim.usesUserEvidence !== undefined && typeof claim.usesUserEvidence !== 'boolean') throw new Error('知识准入用户证据标记非法')
    if (claim.usesUserEvidence && !userEvidence) throw new Error('知识准入缺少可信用户证据')
    if (claim.evidenceIndexes.length === 0 && !claim.usesUserEvidence) incomplete = true
  }
  for (const coverage of input.coverage) {
    if (!coverage) throw new Error('知识准入覆盖结构非法')
    requireText(coverage.topic, '覆盖主题')
    requireText(coverage.reason, '覆盖理由')
    if (!['covered', 'not_applicable', 'gap'].includes(coverage.status)) throw new Error('知识准入覆盖状态非法')
    if (coverage.status === 'gap') incomplete = true
  }
  for (const issue of input.issues) requireText(issue, '待解决问题')
  return {
    ...input, ruleVersion: 1, contentHash: hash(content), evidenceHash: knowledgeEvidenceHash(evidence, userEvidence),
    status: incomplete || input.issues.length > 0 || input.outcome === 'needs_evidence' ? 'needs_evidence' : 'eligible',
  }
}

/** 校验落盘评估与当前正文、证据是否仍相符；未知版本默认失效。 */
export function isKnowledgeAdmissionCurrent(entry: KnowledgeEntry, content: string): boolean {
  return entry.admission?.ruleVersion === 1 && entry.admission.contentHash === hash(content)
    && entry.admission.evidenceHash === knowledgeEvidenceHash(entry.evidence, entry.userEvidence)
}
