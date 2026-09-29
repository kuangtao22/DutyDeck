/**
 * 能力包 spec v1 的类型定义。
 *
 * 本文件只放类型与常量，不做 IO、不依赖任何外部包 —— 参考 runner 与 DutyDeck 共用同一份定义，
 * 消费方项目也可以直接取用（随包附源码的形式）。
 *
 * 设计要点（对应 docs/superpowers/specs/2026-09-27-ai-capability-factory-data-model.md）：
 * - 能力包不得引用 DutyDeck 内部概念（工具名、工作区路径、Skill、权限模型）。
 * - 步骤类型收敛为三种（llm / extract / tool），并行是**容器**（map）而不是第四种类型。
 * - 约束与指标分属两个轴，永不合成一个分数。
 */

/** 能力包的 kind 标记，用于与其它 JSON 区分。 */
export const CAPABILITY_PACKAGE_KIND = 'proma-ai-capability-package'

/** 当前 spec 主版本；不匹配时拒绝加载，不做静默降级。 */
export const CAPABILITY_PACKAGE_SPEC_VERSION = 1

/** 字段类型的受限子集：刻意不实现完整 JSON Schema —— 够表达"必须返回哪些字段"即可，且避免引入依赖。 */
export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'

/** 一个字段的声明。object 用 fields 递归，array 用 items 描述元素。 */
export interface FieldSchema {
  /** 字段名；仅在描述数组元素时允许省略。 */
  name?: string
  type: FieldType
  description?: string
  /** 缺省视为必填 —— 声明字段的默认意图就是"必须有"。 */
  required?: boolean
  /** 允许为 null（与 required 正交：必填但可为空）。 */
  nullable?: boolean
  /** 枚举取值，仅对 string / number 有意义。 */
  enum?: (string | number)[]
  /** 数组元素类型。 */
  items?: FieldSchema
  /** 对象的字段表。 */
  fields?: FieldSchema[]
}

/** 步骤输入的来源：只有这三类，显式声明，不靠隐式上下文。 */
export type InputSource =
  | { from: 'workflow-input'; field: string }
  | { from: 'step-output'; stepId: string; path?: string }
  | { from: 'literal'; value: unknown }

/** 并行组的失败策略。 */
export type FailurePolicy = 'fail-fast' | 'continue'

/** 三种步骤类型共有的字段。 */
export interface StepCommon {
  id: string
  title: string
  /** 输入绑定：键为提示词里可引用的变量名。 */
  inputs?: Record<string, InputSource>
  /** 最大尝试次数；约束不通过或模型报错时按此重试。 */
  maxAttempts?: number
}

/** 单次模型调用，输出文本。 */
export interface LlmStep extends StepCommon {
  type: 'llm'
  modelSlot: string
  prompt: string
}

/** 结构化抽取步骤。格式要求写在 prompt 里；judgeFields 只用于校验与评分。 */
export interface ExtractStep extends StepCommon {
  type: 'extract'
  modelSlot: string
  prompt: string
  /** 用作判定与评分的字段清单。 */
  judgeFields: FieldSchema[]
  /** strict：不合法即判该次运行无效并按 maxAttempts 重试；lenient：返回但标记 invalid。 */
  strictness?: 'strict' | 'lenient'
}

/** 调用外部能力的步骤，实现由消费方在运行时绑定。 */
export interface ToolStep extends StepCommon {
  type: 'tool'
  capabilityId: string
  /** capability 入参名 → 值来源。 */
  bindings: Record<string, InputSource>
}

/**
 * 并行组容器：对 over 指向的数组逐项展开 body。
 * 它不是一个新步骤类型，而是容器 —— 所以"类型只有三种"的收敛规则不被破坏。
 */
export interface MapGroup extends StepCommon {
  type: 'map'
  /** 要展开的数组来源。 */
  over: InputSource
  /** 组内步骤链。 */
  body: Step[]
  /** 缺省 continue：收集全部成果与失败项。 */
  failurePolicy?: FailurePolicy
  /** 并发上限；缺省 1（串行）。 */
  concurrency?: number
}

/** 步骤联合。 */
export type Step = LlmStep | ExtractStep | ToolStep | MapGroup

/** 扇入契约：引用 map 组输出时**永远是带失败项的数组**，否则下游无法如实报告部分失败。 */
export type ItemResult =
  | { index: number; ok: true; value: unknown }
  | { index: number; ok: false; error: string }

/** 外部能力声明：只写"需要什么"，不写"谁实现"。 */
export interface CapabilityDeclaration {
  id: string
  description: string
  inputSchema: FieldSchema[]
  outputSchema: FieldSchema[]
  /** 只读 / 可写 / 不可逆 —— 给接入方一眼看清这个包会不会改数据。 */
  sideEffect: 'read' | 'write' | 'irreversible'
}

/** 模型槽位：固化模型与参数，允许消费方覆盖。 */
export interface ModelSlot {
  id: string
  model: string
  temperature?: number
  maxTokens?: number
  description?: string
}

/** 输出的形态声明（契约部分；约束不进这里）。 */
export interface OutputDeclaration {
  name: string
  from: { stepId: string; path?: string }
  /** text：自由文本；structured：结构化（字段见 judgeFields）。 */
  shape: 'text' | 'structured'
  /** 输出字段声明，仅用于告知接入方与驱动评审，**不是运行时强制**。 */
  fields?: FieldSchema[]
  description?: string
}

/** 随包导出的验收信息：只导判据文本，不导评审执行器。 */
export interface PackageAcceptance {
  criteria: string[]
}

/** 导出时的评测基线。 */
export interface PackageEvidence {
  metrics: Record<string, number>
  invalidRate: number
  sampleCount: number
  recordedAt: number
}

/** 能力包（唯一的交付物）。 */
export interface CapabilityPackage {
  kind: typeof CAPABILITY_PACKAGE_KIND
  specVersion: number
  packageVersion: string
  name: string
  description?: string
  exportedAt: number
  inputs: FieldSchema[]
  outputs: OutputDeclaration[]
  steps: Step[]
  capabilities: CapabilityDeclaration[]
  modelSlots: ModelSlot[]
  acceptance: PackageAcceptance
  evidence?: PackageEvidence
}
