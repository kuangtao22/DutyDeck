/**
 * 提示词编排工厂的审批卡视图。
 *
 * 与接口工作台同构：**纯函数**，从 `(toolName, toolInput)` 投影出可读行。
 * 关键前提：toolInput 里的 `approval` 是**宿主富化过的**快照（facade 签发 → orchestrator 合并），
 * 不是模型传来的原始入参 —— 所以卡片内容模型无法伪造。
 *
 * 这里刻意复用与 `ApiWorkbenchApprovalView` 相同的字段名（title / lines / files / steps），
 * 让权限横幅可以同一条渲染路径画出两种卡，不必为每个模块写一套 UI。
 */

/** 一条改动，字段由宿主生成，渲染层只负责展示。 */
export interface CapabilityFactoryApprovalChange {
  kind: string
  detail: string
}

/** 审批快照（与主进程 facade 的 `CapabilityFactoryAgentApproval` 对齐）。 */
export interface CapabilityFactoryApprovalSnapshot {
  tool: string
  sceneId: string
  sceneName: string
  currentVersion: number
  changes: CapabilityFactoryApprovalChange[]
  /** 草案保存不会直接推进生效版本。 */
  appliesImmediately: false
  note: string
}

/** 审批卡视图；结构与 ApiWorkbenchApprovalView 保持可互换。 */
export interface CapabilityFactoryApprovalView {
  kind: 'capability-factory-draft'
  title: string
  lines: string[]
  files: never[]
  steps: never[]
  warnings: string[]
  /** 与接口工作台视图保持结构一致：工厂没有用例差异概念，恒为空。 */
  caseDiff: never[]
  /** 采纳在 Agent 原有审批卡中显示具体改动和验证结果。 */
  adoption?: CapabilityFactoryAdoptionView
}

/** 简短决策依据，与主进程采纳摘要保持同形，不引入主进程依赖。 */
export interface CapabilityFactoryAdoptionView {
  /** 宿主对当前版本与草案计算的实际差异。 */
  changes: string[]
  /** 草案作者填写的修改说明，不等同于实测收益。 */
  rationale: string
  /** Agent 的问题判断与预期收益单独标注，不参与验证结论。 */
  proposal?: { problem: string; expectedBenefit: string; risk?: string }
  benefits: string[]
  currentProblems: string[]
  remainingRisks: string[]
  validation: string
}

/** 兼容旧快照；证据缺失只说明一次，不能拿空泛警告替代实际改动。 */
function adoptionSummary(value: unknown): CapabilityFactoryAdoptionView {
  const fallback: CapabilityFactoryAdoptionView = {
    changes: [], rationale: '', benefits: [], currentProblems: [], remainingRisks: [],
    validation: '未验证：此请求未附对比结果',
  }
  if (!isRecord(value) || typeof value.validation !== 'string' || !value.validation.trim()) return fallback
  for (const field of ['benefits', 'currentProblems', 'remainingRisks'] as const) {
    if (!Array.isArray(value[field]) || !value[field].every((line) => typeof line === 'string')) return fallback
  }
  /** 限制卡片长度，长证据保留在工厂运行详情中。 */
  const lines = (field: 'benefits' | 'currentProblems' | 'remainingRisks'): string[] =>
    (value[field] as string[]).map((line) => line.trim()).filter(Boolean).slice(0, 3).map((line) => line.slice(0, 240))
  /** 新字段仅取宿主签发的快照，原始工具入参不能覆盖说明或实测结论。 */
  const changes = Array.isArray(value.changes)
    ? value.changes.filter((line): line is string => typeof line === 'string').slice(0, 6).map((line) => line.slice(0, 240)) : []
  const proposal = isRecord(value.proposal) && typeof value.proposal.problem === 'string'
    && typeof value.proposal.expectedBenefit === 'string'
    ? { problem: value.proposal.problem.slice(0, 240), expectedBenefit: value.proposal.expectedBenefit.slice(0, 240),
      ...(typeof value.proposal.risk === 'string' ? { risk: value.proposal.risk.slice(0, 240) } : {}) } : undefined
  return { changes, rationale: typeof value.rationale === 'string' ? value.rationale.slice(0, 240) : '',
    ...(proposal ? { proposal } : {}),
    benefits: lines('benefits'), currentProblems: lines('currentProblems'), remainingRisks: lines('remainingRisks'), validation: value.validation.slice(0, 320) }
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取审批快照；缺字段时返回 null，让调用方降级到原始的 JSON 展示。 */
function snapshot(value: unknown): CapabilityFactoryApprovalSnapshot | null {
  if (!isRecord(value)) return null
  const changes = value.changes
  if (!Array.isArray(changes)) return null
  if (typeof value.sceneName !== 'string' || typeof value.currentVersion !== 'number') return null
  return {
    tool: typeof value.tool === 'string' ? value.tool : 'factory_apply_draft',
    sceneId: typeof value.sceneId === 'string' ? value.sceneId : '',
    sceneName: value.sceneName,
    currentVersion: value.currentVersion,
    changes: changes
      .filter(isRecord)
      .map((item) => ({
        kind: typeof item.kind === 'string' ? item.kind : 'unknown',
        detail: typeof item.detail === 'string' ? item.detail : '',
      }))
      .filter((item) => item.detail.length > 0),
    appliesImmediately: false,
    note: typeof value.note === 'string' ? value.note : '',
  }
}

/**
 * 从工具名与入参投影出审批卡；不是本模块的工具或没有快照时返回 null。
 */
export function describeCapabilityFactoryApproval(
  toolName: string,
  toolInput: Record<string, unknown>,
): CapabilityFactoryApprovalView | null {
  if (toolName === 'factory_apply_operation') {
    /** 仅展示宿主签发的操作摘要，不从模型原始入参推测影响。 */
    const value = toolInput.approval
    if (!isRecord(value) || value.kind !== 'operation' || typeof value.title !== 'string'
      || !Array.isArray(value.lines) || !value.lines.every((line) => typeof line === 'string')
      || typeof value.destructive !== 'boolean' || typeof value.appliesImmediately !== 'boolean') return null
    return { kind: 'capability-factory-draft', title: value.title, lines: value.lines,
      files: [], steps: [], caseDiff: [],
      ...(value.operation === 'adoptDraft' ? { adoption: adoptionSummary(value.adoption) } : {}),
      warnings: value.destructive ? ['此操作会删除或替换当前内容，请核对上方目标与影响。'] : [],
    }
  }
  if (toolName === 'factory_apply_stub') return describeStubApproval(toolInput)
  if (toolName !== 'factory_apply_draft') return null
  const snap = snapshot(toolInput.approval)
  if (!snap) return null

  const lines = [
    `场景：${snap.sceneName}（当前 v${snap.currentVersion}）`,
    `草案说明：${snap.note || '（未填写）'}`,
    `改动 ${snap.changes.length} 处：`,
    ...snap.changes.map((item) => `· ${item.detail}`),
  ]
  // 这句必须常驻：审批卡是"批准写草案"，不是"批准生效"
  lines.push('本次只写入草案，不会改变当前生效的定义；采纳是独立操作，可在工作台执行或委托 Agent 处理。')

  return {
    kind: 'capability-factory-draft',
    title: '写入场景草案（不立即生效）',
    lines,
    files: [],
    steps: [],
    warnings: [],
    caseDiff: [],
  }
}

/**
 * 虚拟接入快照：形状与草案卡不同，单独投影。
 * 缺字段时返回 null，让横幅降级到原始 JSON 展示 —— 卡片宁可不出，也不能画错。
 */
function describeStubApproval(toolInput: Record<string, unknown>): CapabilityFactoryApprovalView | null {
  const value = toolInput.approval
  if (!isRecord(value) || value.kind !== 'stub') return null
  const capabilityId = value.capabilityId
  const payloadPreview = value.payloadPreview
  if (typeof capabilityId !== 'string' || typeof payloadPreview !== 'string') return null
  const usedByScenes = Array.isArray(value.usedByScenes)
    ? value.usedByScenes.filter((item): item is string => typeof item === 'string')
    : []
  const note = typeof value.note === 'string' && value.note.length > 0 ? value.note : '（未填写）'

  return {
    kind: 'capability-factory-draft',
    title: '写入虚拟接入（本机测试装置）',
    lines: [
      `能力：${capabilityId}`,
      `返回体形状：${payloadPreview}`,
      `被 ${usedByScenes.length} 个场景用到：${usedByScenes.join('、') || '（无）'}`,
      `说明：${note}`,
      '字段名与类型必须与真实返回一致：桩只要"跑通"而形状不对，工厂里会全绿、真实接入时提示词全部返工。',
      '桩不进场景版本、不进能力包；用到占位值的运行会被标成「含占位桩」。',
    ],
    files: [],
    steps: [],
    warnings: [],
    caseDiff: [],
  }
}
