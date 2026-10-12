/** 内容性质独立于事实确认状态；计划与历史不得冒充当前事实。 */
export type KnowledgeContentType = 'fact' | 'rule' | 'decision' | 'procedure' | 'plan' | 'hypothesis' | 'history'

/** Agent 提供的紧凑内容评估；宿主验证结构和引用，不证明语义真值。 */
export interface KnowledgeAdmissionInput {
  /** 知识语义类型。 */
  contentType: KnowledgeContentType
  /** 对业务的影响等级。 */
  importance: 'high' | 'normal'
  /** 保存后解决什么业务问题。 */
  purpose: string
  /** 适用对象、版本或时间范围。 */
  scope: string
  /** 时效敏感内容的截至时间。 */
  asOf?: string
  /** 关键断言与本次提交证据的映射，不要求逐句结构化。 */
  claims: Array<{
    /** 必须逐字出现在正文中的关键句。 */
    statement: string
    /** 对应 evidence 数组的零起点下标。 */
    evidenceIndexes: number[]
    /** 引用宿主验证后的用户原话。 */
    usesUserEvidence?: boolean
  }>
  /** 重要规则、业务流程及例外的覆盖说明。 */
  coverage: Array<{
    /** 被检查的业务问题。 */
    topic: string
    /** 是否覆盖；不适用必须说明理由。 */
    status: 'covered' | 'not_applicable' | 'gap'
    /** 覆盖、缺口或不适用的具体依据。 */
    reason: string
  }>
  /** 尚未解决的问题或冲突，非空时不能达标。 */
  issues: string[]
  /** Agent 建议结果；宿主仍须独立校验。 */
  outcome: 'eligible' | 'needs_evidence'
}

/** 宿主生成、绑定正文及证据版本的准入回执。 */
export interface KnowledgeAdmissionRecord extends KnowledgeAdmissionInput {
  /** 确定性校验规则版本。 */
  ruleVersion: 1
  /** 不含文件身份标记的正文 SHA-256。 */
  contentHash: string
  /** 来源引文与可信用户证据的 SHA-256。 */
  evidenceHash: string
  /** 来源或正文变化后旧结论失效。 */
  status: 'eligible' | 'needs_evidence' | 'invalidated'
}
