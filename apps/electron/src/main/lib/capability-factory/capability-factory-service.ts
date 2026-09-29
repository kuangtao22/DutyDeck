/**
 * 提示词编排工厂的服务层。
 *
 * 只做四件事，且**都围绕"版本"这个主键**：
 *   ① 场景的增删查；② 草案的保存与采纳（采纳 = 产生新版本）；③ 回滚（把旧快照提升为当前，不删历史）；
 *   ④ 导出能力包（调 `buildCapabilityPackage`，并记一条导出记录）。
 *
 * 设计约束（对应 data-model 文档）：
 * - **改动必须显式生效**：保存草案不改当前定义；只有 `adoptDraft` 才推进版本。
 * - **回滚不删历史**：旧版本永远留在 versions 里，可反复回滚。
 * - **导出是人工动作**：本服务不判断调用者是谁，权限由上层（IPC / Agent facade）把关。
 */
import { randomUUID } from 'node:crypto'
import {
  buildCapabilityPackage,
  createEmptySceneDefinition,
  describePackageReadiness,
  type CapabilityCase,
  type CapabilityCaseSource,
  type CapabilityDelivery,
  type CapabilityDataset,
  type CapabilityDraftExpectedState,
  type CapabilityEvaluation,
  type CapabilityPackage,
  type CapabilityRun,
  type CapabilityRunReview,
  type CapabilitySavedTask,
  type CapabilityScene,
  type CapabilitySceneDefinition,
  type CapabilitySceneVersion,
  type CapabilityStub,
  type CapabilityStubSource,
} from '@proma/shared'
import { CapabilityFactoryStore } from './capability-factory-store'

/**
 * 生成 JSON 内容的稳定比较键：对象键顺序不影响相等性，数组顺序与字符串空白保持原义。
 * 用于任务去重和草案快照复核，不修改或压缩用户内容。
 */
export function stableCapabilityValueKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableCapabilityValueKey(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableCapabilityValueKey(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** 草案来源：Agent 只能产出草案，人既可以产出草案也可以直接采纳。 */
export type CapabilitySceneChangeSource = 'agent' | 'human'

/** 采纳乐观锁：用户只能采纳刚刚评测并确认的那份草案。 */
export interface AdoptCapabilityDraftOptions {
  expectedVersion?: number
  expectedDraftCreatedAt?: number
  expectedDraftDefinition?: CapabilitySceneDefinition
}

/** 服务依赖：时钟与 ID 生成注入，便于测试得到确定结果。 */
export interface CapabilityFactoryServiceOptions {
  store: CapabilityFactoryStore
  now?: () => number
  createId?: () => string
}

/** 稳定的业务错误码。 */
export class CapabilityFactoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CapabilityFactoryError'
  }
}

/** 提示词编排工厂服务。 */
export class CapabilityFactoryService {
  private readonly store: CapabilityFactoryStore
  private readonly now: () => number
  private readonly createId: () => string

  constructor(options: CapabilityFactoryServiceOptions) {
    this.store = options.store
    this.now = options.now ?? (() => Date.now())
    this.createId = options.createId ?? (() => randomUUID())
  }

  /** 复核用户操作基于的完整草案状态，冲突时必须在任何写盘前终止。 */
  private assertDraftExpectedState(scene: CapabilityScene, expectedState?: CapabilityDraftExpectedState): void {
    if (expectedState === undefined) return
    /** 同时比较存在性、时间和内容，覆盖同毫秒内草案被替换的边界。 */
    const draftMatches = expectedState.draft === null
      ? scene.draft === null
      : scene.draft !== null
        && expectedState.draft.createdAt === scene.draft.createdAt
        && stableCapabilityValueKey(expectedState.draft.definition) === stableCapabilityValueKey(scene.draft.definition)
    if (expectedState.currentVersion !== scene.currentVersion || !draftMatches) {
      throw new CapabilityFactoryError(
        'DRAFT_SAVE_CONFLICT',
        '场景版本或草案已变化，本次不覆盖；请重新打开后比较',
      )
    }
  }

  /** 列出全部场景。 */
  listScenes(): CapabilityScene[] {
    return this.store.listScenes()
  }

  /** 读取单个场景；不存在返回 null。 */
  getScene(sceneId: string): CapabilityScene | null {
    return this.store.listScenes().find((scene) => scene.id === sceneId) ?? null
  }

  /** 新建场景：建立 v1，定义是空白模板。 */
  createScene(name: string): CapabilityScene {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      throw new CapabilityFactoryError('SCENE_NAME_REQUIRED', '场景名称不能为空')
    }
    const timestamp = this.now()
    const scene: CapabilityScene = {
      id: this.createId(),
      definition: createEmptySceneDefinition(trimmed),
      currentVersion: 1,
      draft: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.store.saveScenes([...this.store.listScenes(), scene])
    // 首个版本也要进历史，否则"回滚到 v1"没有目标
    this.store.appendVersion({
      sceneId: scene.id, version: 1, definition: scene.definition,
      source: 'human', note: '新建场景', createdAt: timestamp,
    })
    return scene
  }

  /**
   * 保存草案 —— **不改变当前生效的定义**。
   * 同一时刻只保留一份草案；再次保存即覆盖上一份（草案不是版本，不需要留历史）。
   * 传入 expectedState 时，只有场景版本和完整草案快照都未变化才允许覆盖。
   */
  saveDraft(
    sceneId: string,
    definition: CapabilitySceneDefinition,
    source: CapabilitySceneChangeSource,
    note: string,
    expectedState?: CapabilityDraftExpectedState,
  ): CapabilityScene {
    const scenes = this.store.listScenes()
    const index = scenes.findIndex((scene) => scene.id === sceneId)
    if (index < 0) throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
    const scene = scenes[index] as CapabilityScene
    this.assertDraftExpectedState(scene, expectedState)
    const updated: CapabilityScene = {
      ...scene,
      draft: { definition, source, note, createdAt: this.now() },
      updatedAt: this.now(),
    }
    scenes[index] = updated
    this.store.saveScenes(scenes)
    return updated
  }

  /** 放弃草案；传入 expectedState 时拒绝删除并发产生的新草案。 */
  discardDraft(sceneId: string, expectedState?: CapabilityDraftExpectedState): CapabilityScene {
    const scenes = this.store.listScenes()
    const index = scenes.findIndex((scene) => scene.id === sceneId)
    if (index < 0) throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
    const scene = scenes[index] as CapabilityScene
    this.assertDraftExpectedState(scene, expectedState)
    const updated: CapabilityScene = { ...scene, draft: null, updatedAt: this.now() }
    scenes[index] = updated
    this.store.saveScenes(scenes)
    return updated
  }

  /**
   * 采纳草案：推进版本号、把当前定义换成草案内容、清空草案。
   * 这是**唯一会改变当前生效定义的入口**（回滚除外）。
   */
  adoptDraft(
    sceneId: string,
    options: AdoptCapabilityDraftOptions = {},
  ): { scene: CapabilityScene; version: CapabilitySceneVersion } {
    const scenes = this.store.listScenes()
    const index = scenes.findIndex((scene) => scene.id === sceneId)
    if (index < 0) throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
    const scene = scenes[index] as CapabilityScene
    if (!scene.draft) throw new CapabilityFactoryError('DRAFT_NOT_FOUND', '当前没有待采纳的草案')
    if (options.expectedVersion !== undefined && options.expectedVersion !== scene.currentVersion) {
      throw new CapabilityFactoryError('SCENE_VERSION_CHANGED', '场景版本已变化，请重新运行优化对比后再采纳')
    }
    if (options.expectedDraftCreatedAt !== undefined
      && options.expectedDraftCreatedAt !== scene.draft.createdAt) {
      throw new CapabilityFactoryError('DRAFT_CHANGED', '候选草案已变化，请重新运行优化对比后再采纳')
    }
    if (options.expectedDraftDefinition !== undefined
      && stableCapabilityValueKey(options.expectedDraftDefinition) !== stableCapabilityValueKey(scene.draft.definition)) {
      throw new CapabilityFactoryError('DRAFT_CHANGED', '候选草案已变化，请重新运行优化对比后再采纳')
    }

    const timestamp = this.now()
    const version: CapabilitySceneVersion = {
      sceneId, version: scene.currentVersion + 1, definition: scene.draft.definition,
      source: scene.draft.source, note: scene.draft.note, createdAt: timestamp,
    }
    const updated: CapabilityScene = {
      ...scene,
      definition: version.definition,
      currentVersion: version.version,
      draft: null,
      updatedAt: timestamp,
    }
    scenes[index] = updated
    this.store.saveScenes(scenes)
    this.store.appendVersion(version)
    return { scene: updated, version }
  }

  /** 版本历史（升序）。 */
  listVersions(sceneId: string): CapabilitySceneVersion[] {
    return this.store.listVersions(sceneId)
  }

  // ---------------------------------------------------------------------------
  // 虚拟接入与运行记录
  //
  // 这两块都不是"场景"的一部分：桩是本地测试装置（不进版本、不进能力包），
  // 运行是既成事实（只追加）。服务层只保证存取与不变量，执行由 runner 适配器负责。
  // ---------------------------------------------------------------------------

  /** 读取本工作区的虚拟接入清单。 */
  listStubs(): CapabilityStub[] {
    return this.store.listStubs()
  }

  /**
   * 写入 / 覆盖一个能力的桩。
   *
   * @param capabilityId 能力 id（与能力包 spec 同形）
   * @param payload 桩的返回体；必须按该能力 outputSchema 的真实形状填写
   * @param note 可选说明（例如"取自 2026-08-27 线上真实响应"）
   * @param source 来源；缺省按人工填写记。**占位值必须显式记成 placeholder** ——
   *   运行记录据此标出"这次含占位桩"，否则空值跑出来的结果会被误当成质量结论。
   * @returns 写入后的桩记录
   */
  setStub(
    capabilityId: string,
    payload: unknown,
    note?: string,
    source: CapabilityStubSource = 'human',
  ): CapabilityStub {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(capabilityId)) {
      throw new CapabilityFactoryError('STUB_ID_INVALID', `能力标识不合法：${capabilityId}`)
    }
    const stub: CapabilityStub = {
      capabilityId, payload, source, updatedAt: this.now(),
      ...(note === undefined || note.trim().length === 0 ? {} : { note: note.trim() }),
    }
    const others = this.store.listStubs().filter((item) => item.capabilityId !== capabilityId)
    this.store.saveStubs([...others, stub].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId)))
    return stub
  }

  /** 清空一个能力的桩：清掉之后这个能力会回到"未绑定"，依赖它的步骤会明确失败。 */
  deleteStub(capabilityId: string): { deleted: boolean } {
    const stubs = this.store.listStubs()
    const remaining = stubs.filter((item) => item.capabilityId !== capabilityId)
    if (remaining.length === stubs.length) return { deleted: false }
    this.store.saveStubs(remaining)
    return { deleted: true }
  }

  /**
   * 落盘一次运行记录。
   *
   * 记录由 runner 适配器算好后交进来：服务层不执行流程，只保证记录被完整保存。
   * @param run 完整运行记录（含轨迹与模型绑定）
   * @returns 保存后的同一条记录
   */
  recordRun(run: CapabilityRun): CapabilityRun {
    if (this.getScene(run.sceneId) === null) {
      throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${run.sceneId}`)
    }
    this.store.appendRun(run)
    return run
  }

  /** 完成本轮自动评审，仅更新目标运行的质量轴。 */
  finishRunReview(sceneId: string, runId: string, review: CapabilityRunReview, stepReviews?: CapabilityRun['stepReviews']): CapabilityRun {
    if (this.getScene(sceneId) === null) throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
    return this.store.finishRunReview(sceneId, runId, review, stepReviews)
  }

  /** 仅在主进程首次建立工作区服务时调用，恢复上次退出遗留的评测中状态。 */
  recoverInterruptedReviews(): void {
    for (const scene of this.store.listScenes()) {
      for (const run of this.store.listRuns(scene.id)) {
        if (run.review?.status !== 'running') continue
        this.store.finishRunReview(scene.id, run.id, {
          ...run.review, status: 'failed', passed: null, finishedAt: this.now(),
          summary: '上次评测已中断，运行输出已保留。', error: '应用退出导致内容评测中断，请重新提交评测。',
        })
      }
    }
  }

  /**
   * 读取某个场景的运行记录（**最新的在前**）。
   *
   * @param sceneId 场景 id
   * @param limit 最多返回多少条；缺省 20
   * @param kind 只取某一类：`full` 整链运行 / `step` 单步试跑。缺省两类都取。
   */
  listRuns(sceneId: string, limit = 20, kind?: 'full' | 'step'): CapabilityRun[] {
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20
    const all = this.store.listRuns(sceneId)
    /** 老记录没有 kind 字段：按整链运行处理。 */
    const filtered = kind === undefined ? all : all.filter((run) => (run.kind ?? 'full') === kind)
    return filtered.slice(-safeLimit).reverse()
  }

  /**
   * 保存一次整链提交输入；相同内容只保留一条，并把最近提交时间向前更新。
   * 单步试跑与批量评测不调用这里，因为它们的输入不是用户下次要直接执行的整链任务。
   */
  saveTask(sceneId: string, input: Record<string, unknown>): CapabilitySavedTask {
    if (this.getScene(sceneId) === null) {
      throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
    }
    const tasks = this.store.listTasks(sceneId)
    const key = stableCapabilityValueKey(input)
    const index = tasks.findIndex((task) => stableCapabilityValueKey(task.input) === key)
    const timestamp = this.now()
    const task: CapabilitySavedTask = index < 0
      ? { id: this.createId(), sceneId, input: structuredClone(input), createdAt: timestamp, updatedAt: timestamp }
      : { ...tasks[index] as CapabilitySavedTask, input: structuredClone(input), updatedAt: timestamp }
    if (index < 0) tasks.push(task)
    else tasks[index] = task
    this.store.saveTasks(sceneId, tasks)
    return task
  }

  /**
   * 列出可复用任务（最近在前）。旧版本没有 tasks 文件时，只读合并整链运行输入；
   * 不回写迁移文件，避免首次打开列表产生隐式写操作。
   */
  listTasks(sceneId: string): CapabilitySavedTask[] {
    if (this.getScene(sceneId) === null) {
      throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
    }
    const explicit = this.store.listTasks(sceneId)
    const explicitKeys = new Set(explicit.map((task) => stableCapabilityValueKey(task.input)))
    const legacy = new Map<string, CapabilitySavedTask>()
    for (const run of this.store.listRuns(sceneId)) {
      if ((run.kind ?? 'full') !== 'full' || run.taskSaved === false) continue
      const key = stableCapabilityValueKey(run.input)
      if (explicitKeys.has(key)) continue
      const previous = legacy.get(key)
      legacy.set(key, {
        id: `legacy-run-${run.id}`,
        sceneId,
        input: structuredClone(run.input),
        createdAt: previous?.createdAt ?? run.startedAt,
        updatedAt: run.startedAt,
      })
    }
    return [...explicit, ...legacy.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * 重命名场景。
   *
   * **刻意产生一个新版本**：版本快照里包含 `name`，而能力包也会带出这个名字。
   * 如果只改当前定义不发版本，就会出现"同一个 v4 对应两个不同的名称"——版本号不再唯一指向一份定义。
   * 代价是重命名会占用一个版本号（历史里会看到一条「重命名」记录），这个代价我选择接受。
   */
  renameScene(sceneId: string, name: string): { scene: CapabilityScene; version: CapabilitySceneVersion | null } {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      throw new CapabilityFactoryError('SCENE_NAME_REQUIRED', '场景名称不能为空')
    }
    const scenes = this.store.listScenes()
    const index = scenes.findIndex((scene) => scene.id === sceneId)
    if (index < 0) throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
    const scene = scenes[index] as CapabilityScene
    // 名字没变就不发新版本 —— 空操作不该污染版本历史
    if (scene.definition.name === trimmed) return { scene, version: null }

    const timestamp = this.now()
    const definition: CapabilitySceneDefinition = { ...scene.definition, name: trimmed }
    const version: CapabilitySceneVersion = {
      sceneId, version: scene.currentVersion + 1, definition,
      source: 'human', note: `重命名：${scene.definition.name} → ${trimmed}`, createdAt: timestamp,
    }
    const updated: CapabilityScene = {
      ...scene, definition, currentVersion: version.version, updatedAt: timestamp,
    }
    scenes[index] = updated
    this.store.saveScenes(scenes)
    this.store.appendVersion(version)
    return { scene: updated, version }
  }

  /**
   * 删除场景：只从场景索引里移除，**不删版本历史**。
   *
   * 刻意保留 `versions/<sceneId>.jsonl` —— 那是审计痕迹，也是唯一的恢复依据。
   * 上层（IPC / 界面）必须先让用户确认，本方法不判断调用者是谁。
   */
  deleteScene(sceneId: string): { deleted: boolean } {
    const scenes = this.store.listScenes()
    const remaining = scenes.filter((scene) => scene.id !== sceneId)
    if (remaining.length === scenes.length) {
      throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
    }
    this.store.saveScenes(remaining)
    return { deleted: true }
  }

  /**
   * 回滚到指定版本：把该版本的快照重新提升为当前，并**追加**一个新版本号。
   * 刻意不把 currentVersion 改回旧号 —— 版本号只增不减，否则"v3"会指向两份不同的定义。
   */
  rollback(sceneId: string, targetVersion: number): { scene: CapabilityScene; version: CapabilitySceneVersion } {
    const scenes = this.store.listScenes()
    const index = scenes.findIndex((scene) => scene.id === sceneId)
    if (index < 0) throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
    const scene = scenes[index] as CapabilityScene
    const target = this.store.listVersions(sceneId).find((item) => item.version === targetVersion)
    if (!target) throw new CapabilityFactoryError('VERSION_NOT_FOUND', `版本不存在：v${targetVersion}`)

    const timestamp = this.now()
    const version: CapabilitySceneVersion = {
      sceneId, version: scene.currentVersion + 1, definition: target.definition,
      source: 'human', note: `回滚到 v${targetVersion}`, createdAt: timestamp,
    }
    const updated: CapabilityScene = {
      ...scene, definition: target.definition, currentVersion: version.version,
      draft: null, updatedAt: timestamp,
    }
    scenes[index] = updated
    this.store.saveScenes(scenes)
    this.store.appendVersion(version)
    return { scene: updated, version }
  }

  /**
   * 导出能力包。
   * 交付边界全部由 `buildCapabilityPackage` 承担（只导判据文本，不导评审提示词与数据集）；
   * 本方法只负责记一条导出记录，让"包版本 ↔ 场景版本"可双向查。
   */
  exportPackage(
    sceneId: string,
    options: { packageVersion: string; fileName: string; projectId?: string },
  ): { package: CapabilityPackage; delivery: CapabilityDelivery } {
    const scene = this.getScene(sceneId)
    if (!scene) throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${sceneId}`)
    /**
     * 文件名会变成磁盘路径：只接受"一个普通文件名"，不接受任何目录成分。
     * 这里不靠清洗兜底（清洗会把 `../../x` 变成合法名字，用户看不到自己写错了）。
     */
    const fileName = options.fileName.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(fileName)) {
      throw new CapabilityFactoryError('DELIVERY_NAME_INVALID', `导出文件名不合法：${options.fileName}`)
    }
    const exportedAt = this.now()
    const pkg = buildCapabilityPackage(scene.definition, { packageVersion: options.packageVersion, exportedAt })
    /** 交付物必须真的落盘：只有一条导出记录是拿不走东西的。 */
    const filePath = this.store.writeDeliveryFile(fileName, pkg)
    /** 验证状态按当前版本的运行记录判断 —— 未验证不拦导出，但必须记下来。 */
    const readiness = describePackageReadiness({
      sceneVersion: scene.currentVersion,
      runs: this.store.listRuns(sceneId),
    })
    const delivery: CapabilityDelivery = {
      id: this.createId(),
      sceneId,
      sceneVersion: scene.currentVersion,
      packageVersion: options.packageVersion,
      fileName,
      exportedAt,
      adoption: 'unknown',
      verified: readiness.verified,
      ...(readiness.reason === null ? {} : { unverifiedReason: readiness.reason }),
      filePath,
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    }
    this.store.appendDelivery(delivery)
    return { package: pkg, delivery }
  }

  /** 导出记录（按时间升序）。 */
  listDeliveries(): CapabilityDelivery[] {
    return this.store.listDeliveries()
  }

  // ---------------------------------------------------------------------------
  // 评测：数据集 + 评测记录
  //
  // 数据集是评测的前置：没有一组固定输入，"评测"就只是把上次那段正文再跑一遍。
  // 用例来源由服务盖章（human / regression），不接受调用方自报。
  // ---------------------------------------------------------------------------

  /** 读取本工作区的全部数据集。 */
  listDatasets(): CapabilityDataset[] {
    return this.store.listDatasets()
  }

  /** 新建数据集：版本从 1 起，空用例集。 */
  createDataset(name: string): CapabilityDataset {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      throw new CapabilityFactoryError('DATASET_NAME_REQUIRED', '数据集名称不能为空')
    }
    const dataset: CapabilityDataset = {
      id: this.createId(), name: trimmed, version: 1, cases: [], updatedAt: this.now(),
    }
    this.store.saveDatasets([...this.store.listDatasets(), dataset])
    return dataset
  }

  /**
   * 往数据集里加一条用例。
   *
   * **改动用例集就递增数据集版本**：评测结果挂在 (场景版本, 数据集版本) 上，
   * 用例悄悄变了会让"上次那条 80% 和这次 80%"变得不可比。
   *
   * @param datasetId 数据集 id
   * @param input 用例输入（通常直接来自一次运行记录的输入）
   * @param options 名称、期望值、来源与来源运行
   */
  addCase(
    datasetId: string,
    input: Record<string, unknown>,
    options: { name?: string; expected?: unknown; source?: CapabilityCaseSource; fromRunId?: string } = {},
  ): CapabilityDataset {
    const datasets = this.store.listDatasets()
    const index = datasets.findIndex((dataset) => dataset.id === datasetId)
    if (index < 0) throw new CapabilityFactoryError('DATASET_NOT_FOUND', `数据集不存在：${datasetId}`)
    const dataset = datasets[index] as CapabilityDataset
    const nextCase: CapabilityCase = {
      id: this.createId(),
      name: options.name?.trim() || `用例 ${dataset.cases.length + 1}`,
      input,
      /** 来源由服务盖章：界面加的是人工用例，失败回灌记 regression。 */
      source: options.source ?? 'human',
      tags: [],
      ...(options.expected === undefined ? {} : { expected: options.expected }),
      ...(options.fromRunId === undefined ? {} : { fromRunId: options.fromRunId }),
    }
    const updated: CapabilityDataset = {
      ...dataset, cases: [...dataset.cases, nextCase], version: dataset.version + 1, updatedAt: this.now(),
    }
    datasets[index] = updated
    this.store.saveDatasets(datasets)
    return updated
  }

  /** 删除一条用例；同样递增数据集版本（用例集变了）。 */
  deleteCase(datasetId: string, caseId: string): CapabilityDataset {
    const datasets = this.store.listDatasets()
    const index = datasets.findIndex((dataset) => dataset.id === datasetId)
    if (index < 0) throw new CapabilityFactoryError('DATASET_NOT_FOUND', `数据集不存在：${datasetId}`)
    const dataset = datasets[index] as CapabilityDataset
    const cases = dataset.cases.filter((item) => item.id !== caseId)
    if (cases.length === dataset.cases.length) {
      throw new CapabilityFactoryError('CASE_NOT_FOUND', `用例不存在：${caseId}`)
    }
    const updated: CapabilityDataset = {
      ...dataset, cases, version: dataset.version + 1, updatedAt: this.now(),
    }
    datasets[index] = updated
    this.store.saveDatasets(datasets)
    return updated
  }

  /**
   * 落盘一次评测记录。
   *
   * 记录由评测适配器算好后交进来（服务层不跑模型）：这里只保证挂得上
   * (场景版本, 数据集版本) 这对主键 —— 缺一个，"这个分数属于哪一版"就答不上来。
   */
  recordEvaluation(evaluation: CapabilityEvaluation): CapabilityEvaluation {
    if (this.getScene(evaluation.sceneId) === null) {
      throw new CapabilityFactoryError('SCENE_NOT_FOUND', `场景不存在：${evaluation.sceneId}`)
    }
    this.store.appendEvaluation(evaluation)
    return evaluation
  }

  /** 读取某个场景的评测记录（**最新的在前**，缺省 20 条）。 */
  listEvaluations(sceneId: string, limit = 20): CapabilityEvaluation[] {
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20
    return this.store.listEvaluations(sceneId).slice(-safeLimit).reverse()
  }
}
