import type {
  CapabilityFactoryBatch,
  CapabilityFactoryBatchSummary,
  CapabilityRun,
  CapabilityRunReview,
  CapabilityScene,
  CapabilitySceneDefinition,
  SceneAcceptance,
} from '@proma/shared'
import { stableCapabilityValueKey, canAdoptOptimization, compareOptimizationPair } from '@proma/shared'

/**
 * 采纳弹窗的冻结摘要：changes/rationale 来自真实草案，proposal 是 Agent 待验证判断，
 * benefits/currentProblems/remainingRisks 才由匹配批次与运行证据推导。
 */
export interface CapabilityFactoryAdoptionSummary {
  changes: string[]
  /** 草案作者保存的说明；不是测试结论。 */
  rationale: string
  /** Agent 对问题、预期收益和取舍的待验证判断。 */
  proposal?: CapabilityFactoryAdoptionProposal
  benefits: string[]
  currentProblems: string[]
  remainingRisks: string[]
  validation: string
}

export interface CapabilityFactoryAdoptionProposal {
  problem: string
  expectedBenefit: string
  risk?: string
}

export interface CapabilityFactoryAdoptionSummaryOptions {
  scene: CapabilityScene
  proposal?: CapabilityFactoryAdoptionProposal
  testedBatchId?: string
  listBatches?: (sceneId: string) => CapabilityFactoryBatchSummary[]
  getBatch?: (sceneId: string, batchId: string) => CapabilityFactoryBatch | null
  /** 一次加载所需运行，避免每个 runId 重读完整 JSONL 历史。 */
  getRunsByIds: (sceneId: string, runIds: readonly string[]) => CapabilityRun[]
}

interface MatchedPair {
  baseline: CapabilityRun
  candidate: CapabilityRun
}

/**
 * 从冻结草案、持久批次和精确 runId 生成审核摘要。
 * 返回的 evidenceKey 与摘要一起存入 prepared operation，apply 前用于检测证据变化。
 */
export function createCapabilityFactoryAdoptionSummary(options: CapabilityFactoryAdoptionSummaryOptions): {
  adoption: CapabilityFactoryAdoptionSummary
  evidenceKey: string
} {
  const summaries = options.testedBatchId === undefined
    ? (options.listBatches?.(options.scene.id) ?? []).slice(0, 100)
    : []
  const selection = selectBatch(options, summaries)
  /** 身份或完成状态不匹配时无需读取大块运行输出，仍将批次本身纳入失效校验。 */
  const evidenceRuns = selection.batch && batchMatchesCurrentDraft(selection.batch, options.scene)
    ? loadRuns(options, selection.batch) : []
  const evidenceKey = stableCapabilityValueKey({ summaries, batch: selection.batch, runs: evidenceRuns })
  const draftContext = adoptionDraftContext(options.scene, options.proposal)

  if (!selection.batch || !batchMatchesCurrentDraft(selection.batch, options.scene)) {
    return {
      adoption: finalizeAdoption({
        ...draftContext,
        benefits: [],
        currentProblems: [],
        remainingRisks: [],
        validation: selection.reason,
      }),
      evidenceKey,
    }
  }

  const pairs = collectMatchedPairs(options.scene, selection.batch, evidenceRuns)
  if (pairs.length === 0) {
    return {
      adoption: finalizeAdoption({
        ...draftContext,
        benefits: [],
        currentProblems: [],
        remainingRisks: [],
        validation: `批次 ${selection.batch.id} 与当前草案匹配，但没有完整可比的运行证据`,
      }),
      evidenceKey,
    }
  }

  const comparisons = pairs.map(({ baseline, candidate }) => compareOptimizationPair(baseline, candidate))
  const comparable = comparisons.flatMap((comparison, index) => comparison.comparable
    ? [{ comparison, pair: pairs[index] as MatchedPair }]
    : [])
  const benefits = unique(comparable.flatMap(({ comparison }) => comparison.fixed.map((item) => `已改善：${item}`))).slice(0, 3)
  const currentProblems = unique(pairs.flatMap(({ baseline }) => baselineProblems(baseline))).slice(0, 3)
  const evidenceRisks = unique([
    ...pairs.flatMap(({ candidate }) => candidateRisks(candidate)),
    ...comparisons.flatMap((comparison) => [...comparison.regressed.map((item) => `出现退化：${item}`), ...comparison.unknown, ...comparison.reasons]),
  ])
  const unverifiedRisk = options.testedBatchId === undefined
    ? ['未指定验证批次，本次采纳不代表优化通过']
    : []
  const riskCapacity = options.testedBatchId === undefined ? 1 : 2
  const visibleEvidenceRisks = summarizeEvidenceRisks(evidenceRisks, riskCapacity)
  /** 覆盖范围与普通采纳的未认证状态必须始终展示，不能被其它风险挤出最多三条的窗口。 */
  const remainingRisks = [
    ...visibleEvidenceRisks,
    ...unverifiedRisk,
    `仅覆盖 ${pairs.length} 个测试样本，未覆盖的输入仍有风险`,
  ]

  return {
    adoption: finalizeAdoption({
      ...draftContext,
      benefits,
      currentProblems,
      remainingRisks,
      validation: options.testedBatchId === undefined
        ? `参考最近批次 ${selection.batch.id} 的 ${comparable.length}/${selection.batch.items.length} 组同条件对比；仅作参考，本次未申请已验证采纳`
        : `验证批次 ${selection.batch.id}：${comparable.length}/${selection.batch.items.length} 组同条件对比可采信`,
    }),
    evidenceKey,
  }
}

/** 指定批次优先；普通采纳只寻找最新且与当前草案完全匹配的 comparison。 */
function selectBatch(
  options: CapabilityFactoryAdoptionSummaryOptions,
  summaries: CapabilityFactoryBatchSummary[],
): { batch: CapabilityFactoryBatch | null; reason: string } {
  if (!options.getBatch) return { batch: null, reason: '没有可读取的对比结果，本次优化未经验证' }
  if (options.testedBatchId !== undefined) {
    const batch = options.getBatch(options.scene.id, options.testedBatchId)
    if (!batch) return { batch: null, reason: `指定批次 ${options.testedBatchId} 不存在，本次优化未经验证` }
    if (batch.status !== 'succeeded') {
      return { batch, reason: `指定批次 ${batch.id} 未完整成功（${batch.status}），本次优化未经验证` }
    }
    if (!batchMatchesCurrentDraft(batch, options.scene)) {
      return { batch, reason: `指定批次 ${batch.id} 与当前草案不匹配，本次优化未经验证` }
    }
    return { batch, reason: '' }
  }

  const ordered = [...summaries].sort((left, right) => right.updatedAt - left.updatedAt)
  for (const summary of ordered) {
    if (summary.kind !== 'comparison') continue
    const batch = options.getBatch(options.scene.id, summary.id)
    if (batch && batchMatchesCurrentDraft(batch, options.scene)) return { batch, reason: '' }
  }
  return { batch: null, reason: '没有匹配当前草案的对比批次，本次优化未经验证' }
}

/** 完整草案身份必须匹配，避免把旧草案的收益带入本次采纳。 */
function batchMatchesCurrentDraft(batch: CapabilityFactoryBatch, scene: CapabilityScene): boolean {
  return Boolean(scene.draft)
    && batch.sceneId === scene.id
    && batch.kind === 'comparison'
    && batch.status === 'succeeded'
    && batch.snapshot.sceneVersion === scene.currentVersion
    && batch.snapshot.draftCreatedAt === scene.draft?.createdAt
    && stableCapabilityValueKey(batch.snapshot.draftDefinition) === stableCapabilityValueKey(scene.draft?.definition)
}

/** 按批次索引精确读取运行，证据指纹保留 null 以检测记录被删除。 */
function loadRuns(options: CapabilityFactoryAdoptionSummaryOptions, batch: CapabilityFactoryBatch): Array<CapabilityRun | null> {
  /** 保留缺失位置与配对顺序，让删除运行仍会改变证据指纹。 */
  const ids = batch.items.flatMap((item) => [item.baselineRunId, item.candidateRunId])
  const records = options.getRunsByIds(options.scene.id, ids.filter((id): id is string => !!id))
  const byId = new Map(records.map((run) => [run.id, run]))
  return ids.map((id) => id ? byId.get(id) ?? null : null)
}

/** 只接纳批次输入、比较身份、基线与候选草案均完全一致的运行对。 */
function collectMatchedPairs(
  scene: CapabilityScene,
  batch: CapabilityFactoryBatch,
  runs: Array<CapabilityRun | null>,
): MatchedPair[] {
  const pairs: MatchedPair[] = []
  for (let index = 0; index < batch.items.length; index += 1) {
    const item = batch.items[index]
    const baseline = runs[index * 2]
    const candidate = runs[index * 2 + 1]
    if (!item || !baseline || !candidate || item.status !== 'succeeded') continue
    if (baseline.id !== item.baselineRunId || candidate.id !== item.candidateRunId) continue
    if (!item.comparisonId || baseline.comparisonId !== item.comparisonId || candidate.comparisonId !== item.comparisonId) continue
    if (baseline.comparisonRole !== 'baseline' || candidate.comparisonRole !== 'candidate') continue
    if (baseline.sceneId !== scene.id || baseline.sceneVersion !== scene.currentVersion) continue
    if (stableCapabilityValueKey(baseline.input) !== stableCapabilityValueKey(item.input)
      || stableCapabilityValueKey(candidate.input) !== stableCapabilityValueKey(item.input)) continue
    if (baseline.definitionTarget !== 'current'
      || stableCapabilityValueKey(baseline.definitionSnapshot) !== stableCapabilityValueKey(scene.definition)) continue
    if (!canAdoptOptimization(candidate, scene)) continue
    pairs.push({ baseline, candidate })
  }
  return pairs
}

/** 当前缺点只来自基线明确失败的判据或证据问题，不采用模型自报的营销文案。 */
function baselineProblems(run: CapabilityRun): string[] {
  return unique([
    ...(run.evidenceIssues ?? []).map((item) => `基线证据问题：${item}`),
    ...reviewEntries(run).flatMap(({ label, review }) => review.criteria
      .filter((criterion) => criterion.passed === false)
      .map((criterion) => `基线未通过：${label}${criterion.criterion}`)),
  ])
}

/** 剩余风险只来自候选的明确失败、无法判断与证据异常。 */
function candidateRisks(run: CapabilityRun): string[] {
  const status = run.status === 'succeeded' && run.valid ? [] : [`候选执行或格式未通过：${run.error ?? run.status}`]
  return unique([
    ...status,
    ...(run.evidenceIssues ?? []).map((item) => `候选证据问题：${item}`),
    ...reviewEntries(run).flatMap(({ label, review }) => review.criteria
      .filter((criterion) => criterion.passed !== true)
      .map((criterion) => criterion.passed === false
        ? `候选仍未通过：${label}${criterion.criterion}`
        : `候选判据无法确认：${label}${criterion.criterion}`)),
  ])
}

/** 新记录按步骤列出，旧记录回退到聚合评审。 */
function reviewEntries(run: CapabilityRun): Array<{ label: string; review: CapabilityRunReview }> {
  const entries = Object.entries(run.stepReviews ?? {})
  if (entries.length > 0) return entries.map(([stepId, review]) => ({ label: `${stepId}：`, review }))
  return run.review ? [{ label: '', review: run.review }] : []
}

/** 保持原始证据顺序去重，使审核文案稳定。 */
function unique(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))]
}

/** 风险超出可见槽位时在最后一条保留余量计数，且先截正文保证计数不会被最终上限裁掉。 */
function summarizeEvidenceRisks(items: string[], capacity: number): string[] {
  if (items.length <= capacity) return items
  const visible = items.slice(0, capacity)
  const lastIndex = visible.length - 1
  visible[lastIndex] = `${truncate(visible[lastIndex] ?? '', 160)}；另有 ${items.length - capacity} 项风险或待确认问题，详见批次`
  return visible
}

/** 后端同样限制审批文本，避免超长模型证据撑爆权限弹窗或权限载荷。 */
function finalizeAdoption(summary: CapabilityFactoryAdoptionSummary): CapabilityFactoryAdoptionSummary {
  return {
    changes: summary.changes.slice(0, 6).map((item) => truncate(item, 240)),
    rationale: truncate(summary.rationale, 240),
    ...(summary.proposal === undefined ? {} : {
      proposal: {
        problem: truncate(summary.proposal.problem, 240),
        expectedBenefit: truncate(summary.proposal.expectedBenefit, 240),
        ...(summary.proposal.risk === undefined ? {} : { risk: truncate(summary.proposal.risk, 240) }),
      },
    }),
    benefits: summary.benefits.slice(0, 3).map((item) => truncate(item, 240)),
    currentProblems: summary.currentProblems.slice(0, 3).map((item) => truncate(item, 240)),
    remainingRisks: summary.remainingRisks.slice(0, 3).map((item) => truncate(item, 240)),
    validation: truncate(summary.validation, 320),
  }
}

/** 审核主体始终来自当前定义与冻结草案，而不是测试或 Agent 自报结论。 */
function adoptionDraftContext(
  scene: CapabilityScene,
  proposal: CapabilityFactoryAdoptionProposal | undefined,
): Pick<CapabilityFactoryAdoptionSummary, 'changes' | 'rationale' | 'proposal'> {
  const draft = scene.draft
  if (!draft) return { changes: [], rationale: '未找到待采纳草案' }
  return {
    changes: describeDefinitionChanges(scene.definition, draft.definition),
    rationale: draft.note.trim().length > 0 ? draft.note : '未填写草案说明',
    ...(proposal === undefined ? {} : { proposal: structuredClone(proposal) }),
  }
}

/** 生成最多六行的具体差异；超出时最后一行仍列出剩余变更，避免静默遗漏。 */
function describeDefinitionChanges(before: CapabilitySceneDefinition, after: CapabilitySceneDefinition): string[] {
  const details = [
    ...describePromptChanges(before, after),
    ...describeAcceptanceChanges(before, after),
    ...describeStructuralChanges(before, after),
  ]
  if (details.length <= 6) return details.map((item) => truncate(item, 240))
  return [
    ...details.slice(0, 5).map((item) => truncate(item, 240)),
    truncate(`另有变更：${summarizeOmittedChanges(details.slice(5))}；详细差异请在工厂草案对比查看`, 240),
  ]
}

/** 固定类目计数保证后置的契约或模型变化不会被前面大量提示词淹没。 */
function summarizeOmittedChanges(details: string[]): string {
  const counts = new Map<string, number>()
  for (const detail of details) {
    const category = changeCategory(detail)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return [...counts.entries()].map(([category, count]) => `${category} ${count} 项`).join('、')
}

function changeCategory(detail: string): string {
  if (detail.startsWith('提示词')) return '提示词'
  if (detail.startsWith('评审')) return '评审口径'
  if (detail.startsWith('输入契约')) return '输入契约'
  if (detail.startsWith('输出契约')) return '输出契约'
  if (detail.startsWith('流程')) return '流程'
  if (detail.startsWith('能力声明')) return '能力声明'
  if (detail.startsWith('模型配置')) return '模型配置'
  if (detail.startsWith('名称') || detail.startsWith('描述')) return '场景信息'
  return '其它'
}

/** 提示词逐步骤展示真实前后值；嵌套 map 使用父子路径避免同名混淆。 */
function describePromptChanges(before: CapabilitySceneDefinition, after: CapabilitySceneDefinition): string[] {
  const previous = promptEntries(before.steps)
  const next = promptEntries(after.steps)
  const ids = [...new Set([...previous.keys(), ...next.keys()])]
  return ids.flatMap((id) => {
    const left = previous.get(id)
    const right = next.get(id)
    if (left?.prompt === right?.prompt) return []
    const title = right?.title ?? left?.title ?? id
    return [`提示词（${title}（${id}））：${describeTextChange(left?.prompt ?? '', right?.prompt ?? '')}`]
  })
}

/** 递归收集可编辑提示词，工具步骤没有 prompt。 */
function promptEntries(
  steps: CapabilitySceneDefinition['steps'],
  prefix = '',
): Map<string, { title: string; prompt: string }> {
  const result = new Map<string, { title: string; prompt: string }>()
  for (const step of steps) {
    const id = prefix ? `${prefix}/${step.id}` : step.id
    if (step.type === 'llm' || step.type === 'extract') result.set(id, { title: step.title, prompt: step.prompt })
    if (step.type === 'map') {
      for (const [childId, entry] of promptEntries(step.body, id)) result.set(childId, entry)
    }
  }
  return result
}

/** 判据删除、评审提示词与指标均影响测试口径，必须逐项展示。 */
function describeAcceptanceChanges(before: CapabilitySceneDefinition, after: CapabilitySceneDefinition): string[] {
  const previous = acceptanceEntries(before)
  const next = acceptanceEntries(after)
  const scopes = [...new Set([...previous.keys(), ...next.keys()])]
  return scopes.flatMap((scope) => {
    const left = previous.get(scope) ?? emptyAcceptance()
    const right = next.get(scope) ?? emptyAcceptance()
    const removed = left.criteria.filter((criterion) => !right.criteria.includes(criterion))
    const added = right.criteria.filter((criterion) => !left.criteria.includes(criterion))
    const details: string[] = []
    if (removed.length > 0 || added.length > 0) {
      const parts = [
        ...(removed.length > 0 ? [`删除${removed.map(quoted).join('、')}`] : []),
        ...(added.length > 0 ? [`新增${added.map(quoted).join('、')}`] : []),
      ]
      details.push(`评审判据（${scope}）：${parts.join('；')}`)
    } else if (stableCapabilityValueKey(left.criteria) !== stableCapabilityValueKey(right.criteria)) {
      details.push(`评审判据顺序（${scope}）：${describeTextChange(left.criteria.join(' → '), right.criteria.join(' → '))}`)
    }
    if (left.judgePrompt !== right.judgePrompt) {
      details.push(`评审提示词（${scope}）：${describeTextChange(left.judgePrompt, right.judgePrompt)}`)
    }
    if (stableCapabilityValueKey(left.metrics) !== stableCapabilityValueKey(right.metrics)) {
      details.push(`评审指标（${scope}）：${describeTextChange(JSON.stringify(left.metrics), JSON.stringify(right.metrics))}`)
    }
    return details
  })
}

/** 顶层标准与每步骤标准使用同一比较结构。 */
function acceptanceEntries(definition: CapabilitySceneDefinition): Map<string, SceneAcceptance> {
  return new Map([
    ['场景', definition.acceptance],
    ...Object.entries(definition.stepAcceptances ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ])
}

function emptyAcceptance(): SceneAcceptance {
  return { criteria: [], judgePrompt: '', metrics: [] }
}

/** 除提示词与评审外，所有会影响生效行为的契约、流程和模型变化都要出现。 */
function describeStructuralChanges(before: CapabilitySceneDefinition, after: CapabilitySceneDefinition): string[] {
  const details: string[] = []
  if (before.name !== after.name) details.push(`名称：${describeTextChange(before.name, after.name)}`)
  if (before.description !== after.description) details.push(`描述：${describeTextChange(before.description, after.description)}`)
  if (stableCapabilityValueKey(before.inputs) !== stableCapabilityValueKey(after.inputs)) {
    details.push(`输入契约：${describeTextChange(JSON.stringify(before.inputs), JSON.stringify(after.inputs))}`)
  }
  if (stableCapabilityValueKey(before.outputs) !== stableCapabilityValueKey(after.outputs)) {
    details.push(`输出契约：${describeTextChange(JSON.stringify(before.outputs), JSON.stringify(after.outputs))}`)
  }
  details.push(...describeStepStructureChanges(before.steps, after.steps))
  if (stableCapabilityValueKey(before.capabilities) !== stableCapabilityValueKey(after.capabilities)) {
    details.push(`能力声明：${describeTextChange(JSON.stringify(before.capabilities), JSON.stringify(after.capabilities))}`)
  }
  if (stableCapabilityValueKey(before.modelSlots) !== stableCapabilityValueKey(after.modelSlots)) {
    details.push(`模型配置：${describeTextChange(JSON.stringify(before.modelSlots), JSON.stringify(after.modelSlots))}`)
  }
  return details
}

/** 隐去提示词后比较流程结构，避免同一修改重复展示两次。 */
function describeStepStructureChanges(
  before: CapabilitySceneDefinition['steps'],
  after: CapabilitySceneDefinition['steps'],
): string[] {
  const details: string[] = []
  const previousOrder = before.map((step) => `${step.title}（${step.id}）`).join(' → ')
  const nextOrder = after.map((step) => `${step.title}（${step.id}）`).join(' → ')
  if (previousOrder !== nextOrder) details.push(`流程顺序：${describeTextChange(previousOrder, nextOrder)}`)
  const previous = stepStructureEntries(before)
  const next = stepStructureEntries(after)
  const ids = [...new Set([...previous.keys(), ...next.keys()])]
  details.push(...ids.flatMap((id) => {
    const left = previous.get(id)
    const right = next.get(id)
    if (stableCapabilityValueKey(left?.value) === stableCapabilityValueKey(right?.value)) return []
    const title = right?.title ?? left?.title ?? id
    return [`流程步骤（${title}（${id}））：${describeStepFields(left?.value, right?.value)}`]
  }))
  return details
}

/** 去掉 prompt 后逐步骤保存真实字段；map 的 body 顺序在容器项中单独保留。 */
function stepStructureEntries(
  steps: CapabilitySceneDefinition['steps'],
  prefix = '',
): Map<string, { title: string; value: Record<string, unknown> }> {
  const result = new Map<string, { title: string; value: Record<string, unknown> }>()
  for (const step of steps) {
    const id = prefix ? `${prefix}/${step.id}` : step.id
    if (step.type === 'llm' || step.type === 'extract') {
      const { prompt: _prompt, ...value } = step
      result.set(id, { title: step.title, value })
    } else if (step.type === 'map') {
      result.set(id, { title: step.title, value: { ...step, body: step.body.map((item) => item.id) } })
      for (const [childId, entry] of stepStructureEntries(step.body, id)) result.set(childId, entry)
    } else {
      result.set(id, { title: step.title, value: Object.fromEntries(Object.entries(step)) })
    }
  }
  return result
}

/** 步骤按字段比较，确保多个离散变化不会被一段 JSON 的中间截断吞掉。 */
function describeStepFields(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string {
  if (!before || !after) return describeTextChange(before ? JSON.stringify(before) : '', after ? JSON.stringify(after) : '')
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  return keys.flatMap((key) => {
    if (stableCapabilityValueKey(before[key]) === stableCapabilityValueKey(after[key])) return []
    const left = before[key] === undefined ? '' : JSON.stringify(before[key])
    const right = after[key] === undefined ? '' : JSON.stringify(after[key])
    return [`${key}：${describeTextChange(left, right)}`]
  }).join('；')
}

function quoted(value: string): string {
  return `「${excerpt(value)}」`
}

/** 压缩换行和连续空白，让前后内容在审批卡内仍可比较。 */
function excerpt(value: string, limit = 88): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return truncate(normalized, limit)
}

/**
 * 短文本直接展示；长文本围绕首个真实差异保留上下文，避免共同前缀掩盖变化。
 * 仅空白变化单独说明，插入或删除的位置明确标记为“无”。
 */
function describeTextChange(before: string, after: string): string {
  if (before !== after && normalizeWhitespace(before) === normalizeWhitespace(after)) return '仅换行/空白调整'
  const left = normalizeWhitespace(before)
  const right = normalizeWhitespace(after)
  if (left.length <= 88 && right.length <= 88) return `「${left || '无'}」→「${right || '无'}」`

  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1
  let suffix = 0
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1
  return `「${localizedDifference(left, prefix, suffix)}」→「${localizedDifference(right, prefix, suffix)}」`
}

/** 在变化位置左右各保留上下文，并把变化本体用方括号突出。 */
function localizedDifference(value: string, prefix: number, suffix: number): string {
  const changeEnd = value.length - suffix
  const contextStart = Math.max(0, prefix - 24)
  const contextEnd = Math.min(value.length, changeEnd + 24)
  const beforeContext = value.slice(contextStart, prefix)
  const changed = compactDifference(value.slice(prefix, changeEnd))
  const afterContext = value.slice(changeEnd, contextEnd)
  return `${contextStart > 0 ? '…' : ''}${beforeContext}【${changed || '无'}】${afterContext}${contextEnd < value.length ? '…' : ''}`
}

/** 变化本体过长时同时保留头尾，防止真正差异再次落在截断区外。 */
function compactDifference(value: string): string {
  if (value.length <= 48) return value
  return `${value.slice(0, 22)}…${value.slice(-22)}`
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** 保留确定性前缀，并用省略号标记审批文本被截断。 */
function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}
