import { randomBytes } from 'node:crypto'

/** 工具可操作的失败类型；不把模型参数错误误判为原始资料变化。 */
export type KnowledgeFailureCode = 'invalid_reference' | 'invalid_parameters' | 'stale_revision' | 'source_changed'
  | 'target_conflict' | 'source_unavailable' | 'source_unsupported' | 'evidence_unread' | 'evidence_mismatch'
  | 'user_evidence_changed' | 'permission_denied' | 'paused' | 'budget_exhausted' | 'recovery_exhausted' | 'operation_failed'

/** 错误恢复建议由宿主生成，中文 message 保留原有原因。 */
const failurePolicies: Record<KnowledgeFailureCode, { recoverable: boolean; scope: 'reference' | 'source' | 'item' | 'task'; action: string }> = {
  invalid_reference: { recoverable: true, scope: 'reference', action: 'read_status_or_search' },
  invalid_parameters: { recoverable: true, scope: 'reference', action: 'correct_parameters' },
  stale_revision: { recoverable: true, scope: 'reference', action: 'read_status_or_search' },
  source_changed: { recoverable: true, scope: 'source', action: 'refresh_source_then_read' },
  target_conflict: { recoverable: false, scope: 'item', action: 'review_target_preserve_edits' },
  source_unavailable: { recoverable: false, scope: 'source', action: 'continue_independent_items' },
  source_unsupported: { recoverable: false, scope: 'source', action: 'continue_independent_items' },
  evidence_unread: { recoverable: true, scope: 'source', action: 'read_source' },
  evidence_mismatch: { recoverable: true, scope: 'source', action: 'correct_quote_from_read_page' },
  user_evidence_changed: { recoverable: false, scope: 'item', action: 'request_current_user_fact' },
  permission_denied: { recoverable: false, scope: 'task', action: 'resolve_permission' },
  paused: { recoverable: false, scope: 'task', action: 'wait_for_user_resume' },
  budget_exhausted: { recoverable: false, scope: 'task', action: 'wait_for_user_continue' },
  recovery_exhausted: { recoverable: false, scope: 'source', action: 'continue_independent_items' },
  operation_failed: { recoverable: false, scope: 'item', action: 'inspect_failure' },
}

/** 供 facade、维护器和工具回执共同使用的稳定错误。 */
export class KnowledgeToolFailure extends Error {
  readonly recoverable: boolean
  readonly scope: 'reference' | 'source' | 'item' | 'task'
  readonly action: string
  constructor(readonly code: KnowledgeFailureCode, message: string) {
    super(message)
    this.name = 'KnowledgeToolFailure'
    const policy = failurePolicies[code]
    this.recoverable = policy.recoverable
    this.scope = policy.scope
    this.action = policy.action
  }
}

/** 兼容核心服务现有中文错误，逐类映射且保留原文，不改变事务行为。 */
export function classifyKnowledgeFailure(error: unknown): KnowledgeToolFailure {
  if (error instanceof KnowledgeToolFailure) return error
  const message = error instanceof Error ? error.message : String(error)
  let code: KnowledgeFailureCode = 'operation_failed'
  if (/不属于本轮|引用.*失效/.test(message)) code = 'invalid_reference'
  else if (/混用|非法|必填|缺少准确|需要来源|需要已读页面|invalid_parameters/.test(message)) code = 'invalid_parameters'
  else if (/预算|剩余读取/.test(message)) code = 'budget_exhausted'
  else if (/恢复一次/.test(message)) code = 'recovery_exhausted'
  else if (/暂停/.test(message)) code = 'paused'
  else if (/权限|归属|运行已取消|计划模式/.test(message)) code = 'permission_denied'
  else if (/知识正文.*版本冲突|目标文档已存在|知识正文.*不存在|人工修改|外部修改/.test(message)) code = 'target_conflict'
  else if (/已确认计划版本冲突|知识库大纲版本冲突/.test(message)) code = 'stale_revision'
  else if (/用户证据已变化|用户引用不属于当前用户原文/.test(message)) code = 'user_evidence_changed'
  else if (/尚未.*读取/.test(message)) code = 'evidence_unread'
  else if (/逐字.*不属于|引文.*不属于/.test(message)) code = 'evidence_mismatch'
  else if (/来源.*变化/.test(message)) code = 'source_changed'
  return new KnowledgeToolFailure(code, message)
}

/** 模型可选择短引用或旧身份；解析时拒绝同时提供两种表示。 */
export interface KnowledgeSourceReferenceInput {
  sourceRef?: string
  entryId?: string
  revision?: string
}
/** 页面证据必须是当前运行实际返回的逐字内容。 */
export interface KnowledgePageReferenceInput extends KnowledgeSourceReferenceInput {
  pageRef?: string
  quote: string
}
/** 由宿主保存的精确来源版本。 */
interface SourceIdentity { entryId: string; revision: string }
/** 所见大纲与已批准计划版本。 */
export interface KnowledgeFlowIdentity { planRevision: number; expectedRevision: number }
/** 所见正文版本，null 只表示当时尚无正文。 */
export interface KnowledgeTargetIdentity { planRevision: number; outlineRevision: number; itemId: string; expectedRevision: string | null }

/** 每个 Agent facade 独享的引用表；不持久化，不接受前一轮引用。 */
export class KnowledgeRunReferences {
  /** 随机运行命名空间避免序号复用误命中旧历史。 */
  private readonly namespace = randomBytes(9).toString('base64url')
  /** 所有引用共享单调序号，仅作不透明身份。 */
  private sequence = 0
  /** 宿主见到的来源及页正文。 */
  private readonly sources = new Map<string, SourceIdentity>()
  private readonly pages = new Map<string, SourceIdentity & { offset: number; content: string }>()
  private readonly flows = new Map<string, KnowledgeFlowIdentity>()
  private readonly targets = new Map<string, KnowledgeTargetIdentity>()
  /** 相同不可变版本复用引用，控制上下文体积。 */
  private readonly keys = new Map<string, string>()

  /** 分配同一身份的稳定运行内引用。 */
  private key(kind: string, identity: unknown): string {
    const key = `${kind}:${JSON.stringify(identity)}`
    const existing = this.keys.get(key)
    if (existing) return existing
    const value = `${kind}_${this.namespace}_${++this.sequence}`
    this.keys.set(key, value)
    return value
  }
  /** 登记已发现来源，不代表正文已读。 */
  source(identity: SourceIdentity): string {
    const ref = this.key('src', identity)
    this.sources.set(ref, { ...identity })
    return ref
  }
  /** 仅在实际返回正文后登记页。 */
  page(identity: SourceIdentity, offset: number, content: string): string {
    const value = { ...identity, offset, content }
    const ref = this.key('page', value)
    this.pages.set(ref, value)
    return ref
  }
  /** 固定当前批准计划与所见大纲版本。 */
  flow(identity: KnowledgeFlowIdentity): string {
    const ref = this.key('flow', identity)
    this.flows.set(ref, { ...identity })
    return ref
  }
  /** 固定准确的正文目标版本。 */
  target(identity: KnowledgeTargetIdentity): string {
    const ref = this.key('target', identity)
    this.targets.set(ref, { ...identity })
    return ref
  }
  /** 解析来源，不把旧版本悄悄替换为当前版本。 */
  resolveSource(input: KnowledgeSourceReferenceInput): SourceIdentity {
    if (input.sourceRef !== undefined) {
      if (input.entryId !== undefined || input.revision !== undefined) throw new KnowledgeToolFailure('invalid_parameters', '来源短引用与旧身份不能混用')
      const source = this.sources.get(input.sourceRef)
      if (!source) throw new KnowledgeToolFailure('invalid_reference', '来源引用不属于本轮，请重新检索')
      return { ...source }
    }
    if (!input.entryId || !input.revision) throw new KnowledgeToolFailure('invalid_parameters', '来源必须提供本轮短引用或完整身份与版本')
    return { entryId: input.entryId, revision: input.revision }
  }
  /** 页面短引用同时绑定版本、所见页和逐字内容。 */
  resolveEvidence(input: KnowledgePageReferenceInput): SourceIdentity & { quote: string } {
    if (input.pageRef !== undefined) {
      if (input.sourceRef !== undefined || input.entryId !== undefined || input.revision !== undefined) throw new KnowledgeToolFailure('invalid_parameters', '页面短引用与旧身份不能混用')
      const page = this.pages.get(input.pageRef)
      if (!page) throw new KnowledgeToolFailure('invalid_reference', '页面引用不属于本轮，请重新读取')
      if (!input.quote.trim() || !page.content.includes(input.quote)) throw new KnowledgeToolFailure('evidence_mismatch', '逐字引文不属于该已读页')
      return { entryId: page.entryId, revision: page.revision, quote: input.quote }
    }
    if (input.sourceRef !== undefined) throw new KnowledgeToolFailure('invalid_parameters', '证据需要已读页面引用，来源引用不能代替页面')
    return { ...this.resolveSource(input), quote: input.quote }
  }
  /** 解析流程引用，旧数字版本继续兼容。 */
  resolveFlow(input: Partial<KnowledgeFlowIdentity> & { flowRef?: string }): KnowledgeFlowIdentity {
    if (input.flowRef !== undefined) {
      if (input.planRevision !== undefined || input.expectedRevision !== undefined) throw new KnowledgeToolFailure('invalid_parameters', '流程短引用与旧版本不能混用')
      const value = this.flows.get(input.flowRef)
      if (!value) throw new KnowledgeToolFailure('invalid_reference', '流程引用不属于本轮，请重新读取状态')
      return { ...value }
    }
    if (!Number.isSafeInteger(input.planRevision) || !Number.isSafeInteger(input.expectedRevision)) throw new KnowledgeToolFailure('invalid_parameters', '缺少准确的流程版本')
    return { planRevision: input.planRevision!, expectedRevision: input.expectedRevision! }
  }
  /** 解析目标引用；服务端仍须最终复验目标文件。 */
  resolveTarget(input: Partial<KnowledgeTargetIdentity> & { targetRef?: string }): KnowledgeTargetIdentity {
    if (input.targetRef !== undefined) {
      if (input.planRevision !== undefined || input.outlineRevision !== undefined || input.itemId !== undefined || input.expectedRevision !== undefined) throw new KnowledgeToolFailure('invalid_parameters', '目标短引用与旧版本不能混用')
      const value = this.targets.get(input.targetRef)
      if (!value) throw new KnowledgeToolFailure('invalid_reference', '目标引用不属于本轮，请重新读取状态')
      return { ...value }
    }
    if (!Number.isSafeInteger(input.planRevision) || !Number.isSafeInteger(input.outlineRevision) || !input.itemId || input.expectedRevision === undefined) throw new KnowledgeToolFailure('invalid_parameters', '缺少准确的文档目标版本')
    return { planRevision: input.planRevision!, outlineRevision: input.outlineRevision!, itemId: input.itemId, expectedRevision: input.expectedRevision }
  }
}
