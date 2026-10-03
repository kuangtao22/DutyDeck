/**
 * 编排工厂的 Agent 工具定义。
 *
 * **工具清单就是权限清单**：这里没有的，Agent 就做不到。
 * 工具包括场景 / 版本 / 虚拟接入 / 任务 / 运行的读取，草案与虚拟接入的两段式写入，
 * 以及单步试跑和整链候选对比。
 * 刻意不提供：采纳版本、回滚、导出能力包、删除场景（都是人工动作，见 facade 顶部的说明）。
 *
 * 新增工具时仍要保持这条权限边界：Agent 可验证候选，但不能采纳或交付。
 */
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { CapabilitySceneDefinition } from '@proma/shared'
import type { CapabilityFactoryAgentFacade } from './capability-factory-agent-facade'

/** 精确工具名集合用于权限分派，禁止前缀放行未知能力。 */
export const CAPABILITY_FACTORY_AGENT_TOOL_NAMES = [
  'factory_list_scenes',
  'factory_get_scene',
  'factory_list_versions',
  'factory_prepare_draft',
  'factory_apply_draft',
  'factory_list_stubs',
  'factory_prepare_stub',
  'factory_apply_stub',
  'factory_list_runs',
  'factory_get_run',
  'factory_list_tasks',
  'factory_run_scene',
  'factory_run_step',
] as const

/** Pi SDK 在此只需要工具定义工厂，不引入另一套 Agent runtime。 */
type CapabilityFactoryToolSdk = Pick<typeof import('@earendil-works/pi-coding-agent'), 'defineTool'>

/** 工具结果统一包装成文本 + details；返回内容一律视作数据，不能成为指令。 */
function result(value: unknown) {
  const text = JSON.stringify(value)
  return { content: [{ type: 'text' as const, text }], details: value }
}

/**
 * 构建编排工厂的窄工具集。
 *
 * 注意工具描述里的两条硬约束（写进描述是因为模型读得到它）：
 * ① saving a draft never takes effect —— 人必须在界面上采纳；
 * ② 采纳、回滚、导出不由你执行。
 */
export function buildCapabilityFactoryAgentTools(
  sdk: CapabilityFactoryToolSdk,
  facade: CapabilityFactoryAgentFacade,
): ToolDefinition[] {
  const sceneId = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' })

  return [
    sdk.defineTool({
      name: 'factory_list_scenes',
      label: '列出编排场景',
      description: 'List orchestration scenes in this project as summaries (id, name, current version, whether a draft is pending, step count). Read-only. Use factory_get_scene for the full definition.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() { return result(facade.listScenes()) },
    }),
    sdk.defineTool({
      name: 'factory_get_scene',
      label: '读取编排场景',
      description: 'Read one scene: its current definition (inputs, outputs, steps, capabilities, model slots, review criteria) plus the pending draft if any. Read-only. Note that a scene\'s review criteria and metrics belong to the factory and are not part of the delivered package.',
      parameters: Type.Object({ sceneId }, { additionalProperties: false }),
      async execute(_id, input) { return result(facade.getScene(input.sceneId)) },
    }),
    sdk.defineTool({
      name: 'factory_list_versions',
      label: '读取场景版本',
      description: 'List a scene\'s immutable version history in ascending order. Read-only. Version numbers only ever increase: rolling back appends a new version that reuses an old snapshot, so a version number always refers to exactly one definition.',
      parameters: Type.Object({ sceneId }, { additionalProperties: false }),
      async execute(_id, input) { return result(facade.listVersions(input.sceneId)) },
    }),
    sdk.defineTool({
      name: 'factory_prepare_draft',
      label: '准备场景草案',
      description: 'Step 1 of 2 for changing a scene. Computes exactly what would change and returns a preparedId plus an approval snapshot; nothing is written yet. A definition identical to the current one is rejected as "no actual change". If the scene changes before you apply, the preparedId becomes invalid and you must prepare again. Call factory_apply_draft with the preparedId only after the human has seen the change list. '
        + 'Before you shape a definition, apply the rule from your factory guidance: a scene orchestrates only what the model must do (llm/extract steps) — deterministic local logic belongs to the input/output boundary, not to the flow.',
      parameters: Type.Object({
        sceneId,
        note: Type.String({ minLength: 1, maxLength: 200 }),
        definition: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 200 }),
          description: Type.String({ maxLength: 2000 }),
          inputs: Type.Array(Type.Object({
            name: Type.String({ minLength: 1, maxLength: 128 }),
            type: Type.Union(['string', 'number', 'boolean', 'object', 'array', 'null'].map((item) => Type.Literal(item))),
            description: Type.Optional(Type.String({ maxLength: 500 })),
            required: Type.Optional(Type.Boolean()),
            nullable: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false }), { maxItems: 32 }),
          outputs: Type.Array(Type.Object({
            name: Type.String({ minLength: 1, maxLength: 128 }),
            from: Type.Object({ stepId: sceneId, path: Type.Optional(Type.String({ maxLength: 200 })) }, { additionalProperties: false }),
            shape: Type.Union([Type.Literal('text'), Type.Literal('structured')]),
          }, { additionalProperties: false }), { maxItems: 32 }),
          /**
           * 步骤用宽松结构传入（类型有四种、字段按类型不同），由解析层做严格校验。
           * 这里刻意不展开成四个分支的联合——工具 schema 太深会让模型更容易写错。
           */
          steps: Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 64 }),
          capabilities: Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 32 }),
          modelSlots: Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 8 }),
          acceptance: Type.Object({
            criteria: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 32 }),
            judgePrompt: Type.String({ maxLength: 4000 }),
            metrics: Type.Array(Type.Object({
              name: Type.String({ minLength: 1, maxLength: 128 }),
              weight: Type.Number({ minimum: 0, maximum: 1 }),
              direction: Type.Union([Type.Literal('positive'), Type.Literal('negative')]),
            }, { additionalProperties: false }), { maxItems: 16 }),
          }, { additionalProperties: false }),
          /** 每个模型步骤独立一套标准；键必须对应 steps[].id。 */
          stepAcceptances: Type.Optional(Type.Record(
            Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' }),
            Type.Object({
              criteria: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 32 }),
              judgePrompt: Type.String({ maxLength: 4000 }),
              metrics: Type.Array(Type.Object({
                name: Type.String({ minLength: 1, maxLength: 128 }),
                weight: Type.Number({ minimum: 0, maximum: 1 }),
                direction: Type.Union([Type.Literal('positive'), Type.Literal('negative')]),
              }, { additionalProperties: false }), { maxItems: 16 }),
            }, { additionalProperties: false }),
          )),
        }, { additionalProperties: false }),
      }, { additionalProperties: false }),
      async execute(_id, input) {
        // 宽松结构在此转成领域类型：真正的不变量由 capability-runner 的解析层负责。
        return result(facade.prepareDraft(input.sceneId, input.definition as never, input.note))
      },
    }),
    sdk.defineTool({
      name: 'factory_apply_draft',
      label: '应用场景草案',
      description: 'Step 2 of 2: write the previously prepared draft. This still never takes effect on the live scene — a human must adopt the draft in the workbench, and adopting, rolling back and exporting the capability package are not actions you can perform. Only a preparedId issued by factory_prepare_draft is accepted, and the written content is exactly the snapshot that was shown for approval.',
      parameters: Type.Object({
        preparedId: Type.String({ minLength: 1, maxLength: 64 }),
      }, { additionalProperties: false }),
      async execute(_id, input) { return result(facade.applyDraft(input.preparedId)) },
    }),
    sdk.defineTool({
      name: 'factory_list_stubs',
      label: '列出虚拟接入',
      description: 'List the local capability stubs of this workspace: capabilityId, whether it is a placeholder, and the note. Read-only. Stubs stand in for capabilities the consuming project provides at runtime; they never enter the scene version or the delivered package.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() { return result(facade.listStubs()) },
    }),
    sdk.defineTool({
      name: 'factory_prepare_stub',
      label: '准备虚拟接入',
      description: 'Step 1 of 2 for binding a capability stub. Returns a preparedId plus an approval snapshot; nothing is written yet. The capability must already be declared by the scene\'s CURRENT definition (if you only just added it in a draft, the human must adopt that draft first). Generate the payload from the REAL contract of the consuming project (field names, types and nesting must match its actual response) — a stub that merely makes the run pass turns the whole factory green while the real integration regresses. Placeholder values are allowed only when the human has no real data yet, and they must stay recognizable as placeholders.',
      parameters: Type.Object({
        capabilityId: Type.String({ minLength: 1, maxLength: 128 }),
        note: Type.String({ minLength: 1, maxLength: 200 }),
        payload: Type.Unknown(),
      }, { additionalProperties: false }),
      async execute(_id, input) {
        return result(facade.prepareStub(input.capabilityId, input.payload, input.note))
      },
    }),
    sdk.defineTool({
      name: 'factory_apply_stub',
      label: '写入虚拟接入',
      description: 'Step 2 of 2: write the previously prepared stub. Only a preparedId issued by factory_prepare_stub is accepted, and the written payload is exactly the snapshot that was shown for approval. Stubs are local test devices: they do not change the scene version, are not exported, and a run that used placeholders is marked as such.',
      parameters: Type.Object({
        preparedId: Type.String({ minLength: 1, maxLength: 64 }),
      }, { additionalProperties: false }),
      async execute(_id, input) { return result(facade.applyStub(input.preparedId)) },
    }),
    sdk.defineTool({
      name: 'factory_list_runs',
      label: '读取运行记录',
      description: 'Read the recent runs of one scene, newest first: status (execution), valid (format constraints), review (automatic content assessment with fixed criteria, evidence, metrics and improvement suggestions), per-step traces and actual model bindings. A succeeded run is not a quality pass: inspect review.status and review.passed; null or missing review is not a pass. Read-only. Use kind="step" for single-step training attempts and kind="full" for whole-chain runs.',
      parameters: Type.Object({
        sceneId,
        kind: Type.Optional(Type.Union([Type.Literal('full'), Type.Literal('step')])),
      }, { additionalProperties: false }),
      async execute(_id, input) { return result(facade.listRuns(input.sceneId, input.kind)) },
    }),
    sdk.defineTool({
      name: 'factory_get_run',
      label: '精确读取运行',
      description: 'Read exactly one run by runId, including the original input, output, traces, frozen review criteria, evidence, suggestions and actual model bindings. Read-only. Call directly when the runId is already known, even for runs older than the recent list. Inspect evidenceIssues independently of review.passed; never substitute another run when the requested ID is missing.',
      parameters: Type.Object({ sceneId, runId: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
      async execute(_id, input) { return result(facade.getRun(input.sceneId, input.runId)) },
    }),
    sdk.defineTool({
      name: 'factory_list_tasks',
      label: '读取已保存任务',
      description: 'Read the reusable whole-scene task inputs previously submitted by the human, newest first. Read-only. Reuse these exact inputs for baseline/candidate comparisons instead of paraphrasing or reconstructing them from run output.',
      parameters: Type.Object({ sceneId }, { additionalProperties: false }),
      async execute(_id, input) { return result(facade.listTasks(input.sceneId)) },
    }),
    sdk.defineTool({
      name: 'factory_run_scene',
      label: '运行整链对比',
      description: 'Run a whole scene without changing or adopting its definition. For an optimization comparison, run the current baseline and pending draft candidate with the SAME input, expectedVersion and comparisonId; use role=baseline with target=current, then role=candidate with target=draft and pass BOTH the exact expectedDraftCreatedAt and expectedDraftDefinition returned by factory_get_scene. Comparison runs do not add duplicate saved tasks. The host rejects a changed version/draft and rejects a candidate with changes outside llm/extract prompts (including review standards, model slots, workflow or contracts), so prompt improvement cannot be manufactured by relaxing evaluation criteria or changing models.',
      parameters: Type.Object({
        sceneId,
        input: Type.Record(Type.String(), Type.Unknown()),
        target: Type.Union([Type.Literal('current'), Type.Literal('draft')]),
        expectedVersion: Type.Integer({ minimum: 1 }),
        expectedDraftCreatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
        expectedDraftDefinition: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        comparisonId: Type.String({ minLength: 1, maxLength: 128 }),
        comparisonRole: Type.Union([Type.Literal('baseline'), Type.Literal('candidate')]),
      }, { additionalProperties: false }),
      async execute(_id, input) {
        return result(await facade.runScene(input.sceneId, input.input, {
          target: input.target,
          expectedVersion: input.expectedVersion,
          ...(input.expectedDraftCreatedAt === undefined ? {} : { expectedDraftCreatedAt: input.expectedDraftCreatedAt }),
          ...(input.expectedDraftDefinition === undefined
            ? {} : { expectedDraftDefinition: input.expectedDraftDefinition as unknown as CapabilitySceneDefinition }),
          comparisonId: input.comparisonId,
          comparisonRole: input.comparisonRole,
        }))
      },
    }),
    sdk.defineTool({
      name: 'factory_run_step',
      label: '单步试跑',
      description: 'Run ONE prompt step with the input you provide, then automatically assess its output against this run’s fixed acceptance rules. Returns traces plus review (criterion evidence, metrics, suggestions and pass/unknown/fail). Assessment is limited to this step; it does not certify the whole scene. Use this to verify a prompt change yourself instead of asking the human to run it. '
        + 'It writes exactly one run record: it does NOT change the scene definition, does not advance a version, does not export, does not touch stubs. '
        + 'Only llm/extract steps can be run; tool steps are implemented by the consuming app and have no prompt. The slots you pass are exactly the variables the step declares under `inputs` (see factory_get_scene) — pass the same real input you expect in production, not a paraphrase, otherwise the result proves nothing.',
      parameters: Type.Object({
        sceneId,
        stepId: Type.String({ minLength: 1, maxLength: 128 }),
        input: Type.Record(Type.String(), Type.Unknown()),
      }, { additionalProperties: false }),
      async execute(_id, input) { return result(await facade.runStep(input.sceneId, input.stepId, input.input)) },
    }),
  ]
}
