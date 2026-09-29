/**
 * 提示词编排工厂的存储层。
 *
 * 沿用仓库既有做法：**工作区级的可移植 JSON/JSONL + 原子写**（不引入本地数据库）。
 * 根目录由调用方注入，本文件不依赖 Electron —— 这样 store 与 service 都能在 bun test 里直接跑。
 *
 * 目录结构：
 *   <root>/scenes.json                 场景索引（含当前生效定义与待采纳草案）
 *   <root>/versions/<sceneId>.jsonl    版本历史，**只追加**，回滚不删历史
 *   <root>/runs/<sceneId>.jsonl        一次运行一行，执行结果固定；评审结束后仅补齐该行评审字段
 *   <root>/tasks/<sceneId>.json        用户提交过的整链任务输入，可直接复用
 *   <root>/stubs.json                  虚拟接入（能力桩）：工厂侧测试装置，不进版本也不进包
 *   <root>/deliveries.json             导出记录（包版本 ↔ 场景版本）
 *   <root>/datasets.json               数据集（用例 + 版本）；评测的前置
 *   <root>/evaluations/<sceneId>.jsonl 评测记录，**只追加**（属于哪个数据集版本一目了然）
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CapabilityDataset, CapabilityDelivery, CapabilityEvaluation, CapabilityPackage, CapabilityRun, CapabilityRunReview,
  CapabilitySavedTask, CapabilityScene, CapabilitySceneVersion, CapabilityStub,
} from '@proma/shared'
import { readJsonFileSafe, readJsonFileStrict, writeJsonFileAtomic, writeJsonLinesFileAtomic } from '../safe-file'

/** 场景索引文件的版本号；结构变更时递增并写迁移。 */
const INDEX_VERSION = 1

/** 落盘形状：带 schemaVersion，便于将来迁移。 */
interface ScenesIndex {
  schemaVersion: number
  scenes: CapabilityScene[]
}

/** 导出记录索引。 */
interface DeliveriesIndex {
  schemaVersion: number
  deliveries: CapabilityDelivery[]
}

/** 虚拟接入索引。 */
interface StubsIndex {
  schemaVersion: number
  stubs: CapabilityStub[]
}

/** 数据集索引。 */
interface DatasetsIndex {
  schemaVersion: number
  datasets: CapabilityDataset[]
}

/** 单个场景的已保存任务；分场景存储，避免读取其它项目输入。 */
interface TasksIndex {
  schemaVersion: number
  tasks: CapabilitySavedTask[]
}

/** 判断未知值是否能无损写回 JSON；任务输入损坏时不允许下一次保存覆盖原文件。 */
function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every(isJsonValue)
}

/** 严格校验单个场景的任务索引，包括版本、精确字段与场景归属。 */
function isTasksIndex(value: unknown, sceneId: string): value is TasksIndex {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const index = value as Record<string, unknown>
  if (Object.keys(index).length !== 2
    || index.schemaVersion !== INDEX_VERSION
    || !Array.isArray(index.tasks)) return false
  const ids = new Set<string>()
  return index.tasks.every((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const task = item as Record<string, unknown>
    if (Object.keys(task).length !== 5
      || typeof task.id !== 'string' || task.id.length === 0 || task.id.length > 128
      || ids.has(task.id)
      || task.sceneId !== sceneId
      || typeof task.input !== 'object' || task.input === null || Array.isArray(task.input)
      || !isJsonValue(task.input)
      || typeof task.createdAt !== 'number' || !Number.isSafeInteger(task.createdAt) || task.createdAt < 0
      || typeof task.updatedAt !== 'number' || !Number.isSafeInteger(task.updatedAt)
      || task.updatedAt < task.createdAt) return false
    ids.add(task.id)
    return true
  })
}

/** 稳定的存储错误码，便于上层区分"没找到"与"读坏了"。 */
export class CapabilityFactoryStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CapabilityFactoryStoreError'
  }
}

/** 场景存储。实例持有根目录，便于测试指向临时目录。 */
export class CapabilityFactoryStore {
  constructor(private readonly rootDir: string) {}

  /** 确保根目录存在；只在首次写入前调用。 */
  private ensureRoot(): void {
    if (!existsSync(this.rootDir)) mkdirSync(this.rootDir, { recursive: true })
  }

  /** 版本目录单独确保存在 —— 首次追加版本时根目录可能已在、但 versions/ 还没有。 */
  private ensureVersionsDir(): void {
    const dir = join(this.rootDir, 'versions')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  private scenesPath(): string {
    return join(this.rootDir, 'scenes.json')
  }

  private versionsPath(sceneId: string): string {
    return join(this.rootDir, 'versions', `${this.safeSceneId(sceneId)}.jsonl`)
  }

  private deliveriesPath(): string {
    return join(this.rootDir, 'deliveries.json')
  }

  private stubsPath(): string {
    return join(this.rootDir, 'stubs.json')
  }

  /** 运行记录按场景分文件：一个场景的历史不会把另一个场景的文件撑大。 */
  private runsPath(sceneId: string): string {
    return join(this.rootDir, 'runs', `${this.safeSceneId(sceneId)}.jsonl`)
  }

  /** 已保存任务按场景分文件，列表读取不需要加载运行轨迹。 */
  private tasksPath(sceneId: string): string {
    return join(this.rootDir, 'tasks', `${this.safeSceneId(sceneId)}.json`)
  }

  /** 场景 id 参与文件名，先清洗再使用（与 versions 同一套约束）。 */
  private safeSceneId(sceneId: string): string {
    const safe = sceneId.replace(/[^A-Za-z0-9_-]/g, '')
    if (safe.length === 0 || safe !== sceneId) {
      throw new CapabilityFactoryStoreError('SCENE_ID_INVALID', `场景标识不合法：${sceneId}`)
    }
    return safe
  }

  /** 读取全部场景；文件不存在或结构不认识时返回空列表（不抛错，避免首次使用即失败）。 */
  listScenes(): CapabilityScene[] {
    const index = readJsonFileSafe<ScenesIndex>(this.scenesPath())
    if (!index || index.schemaVersion !== INDEX_VERSION || !Array.isArray(index.scenes)) return []
    return index.scenes
  }

  /** 覆盖写入全部场景。 */
  saveScenes(scenes: CapabilityScene[]): void {
    this.ensureRoot()
    writeJsonFileAtomic(this.scenesPath(), { schemaVersion: INDEX_VERSION, scenes } satisfies ScenesIndex)
  }

  /** 读取某个场景的全部历史版本（按版本号升序）。 */
  listVersions(sceneId: string): CapabilitySceneVersion[] {
    return this.readJsonLines<CapabilitySceneVersion>(this.versionsPath(sceneId))
      .sort((a, b) => a.version - b.version)
  }

  /** 追加一条版本记录 —— 只追加，永不改写历史。 */
  appendVersion(version: CapabilitySceneVersion): void {
    this.ensureRoot()
    this.ensureVersionsDir()
    const current = this.listVersions(version.sceneId)
    writeJsonLinesFileAtomic(this.versionsPath(version.sceneId), [...current, version])
  }

  /** 读取某个场景的全部运行记录（按开始时间升序）。 */
  listRuns(sceneId: string): CapabilityRun[] {
    return this.readJsonLines<CapabilityRun>(this.runsPath(sceneId))
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  /** 追加一条运行记录 —— 运行是既成事实，只追加不改写。 */
  appendRun(run: CapabilityRun): void {
    this.ensureRoot()
    const dir = join(this.rootDir, 'runs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const current = this.listRuns(run.sceneId)
    writeJsonLinesFileAtomic(this.runsPath(run.sceneId), [...current, run])
  }

  /** 读取某个场景显式保存的任务；兼容旧运行记录由服务层只读合并。 */
  listTasks(sceneId: string): CapabilitySavedTask[] {
    const index = readJsonFileStrict<TasksIndex>(this.tasksPath(sceneId), {
      validate: (value): value is TasksIndex => isTasksIndex(value, sceneId),
      description: '编排工厂任务索引',
    })
    if (!index) return []
    return index.tasks
  }

  /** 原子覆盖某个场景的任务列表。 */
  saveTasks(sceneId: string, tasks: CapabilitySavedTask[]): void {
    this.ensureRoot()
    const dir = join(this.rootDir, 'tasks')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeJsonFileAtomic(this.tasksPath(sceneId), { schemaVersion: INDEX_VERSION, tasks } satisfies TasksIndex)
  }

  /** 仅补齐正在评测的记录，不改执行事实，也不覆盖同场景其他并发运行。 */
  finishRunReview(sceneId: string, runId: string, review: CapabilityRunReview, stepReviews?: CapabilityRun['stepReviews']): CapabilityRun {
    const current = this.listRuns(sceneId)
    const index = current.findIndex((run) => run.id === runId)
    const run = current[index]
    if (!run || run.review?.status !== 'running' || review.status === 'running') {
      throw new CapabilityFactoryStoreError('RUN_REVIEW_STATE_INVALID', '运行记录不存在或评审状态已结束')
    }
    const updated = { ...run, review, ...(stepReviews === undefined ? {} : { stepReviews }) }
    current[index] = updated
    writeJsonLinesFileAtomic(this.runsPath(sceneId), current)
    return updated
  }

  /** 读取虚拟接入清单。 */
  listStubs(): CapabilityStub[] {
    const index = readJsonFileSafe<StubsIndex>(this.stubsPath())
    if (!index || index.schemaVersion !== INDEX_VERSION || !Array.isArray(index.stubs)) return []
    return index.stubs
  }

  /** 覆盖写入虚拟接入清单（桩是可改的本地装置，不需要版本历史）。 */
  saveStubs(stubs: CapabilityStub[]): void {
    this.ensureRoot()
    writeJsonFileAtomic(this.stubsPath(), { schemaVersion: INDEX_VERSION, stubs } satisfies StubsIndex)
  }

  /** 逐行读 JSONL；缺文件返回空列表，坏行直接报错（宁可暴露也不要静默丢历史）。 */
  private readJsonLines<T>(path: string): T[] {
    if (!existsSync(path)) return []
    const result: T[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const text = line.trim()
      if (text.length === 0) continue
      try {
        result.push(JSON.parse(text) as T)
      } catch {
        throw new CapabilityFactoryStoreError('RECORD_LINE_INVALID', `记录不是合法 JSON：${path}`)
      }
    }
    return result
  }

  private datasetsPath(): string {
    return join(this.rootDir, 'datasets.json')
  }

  /** 评测记录按场景分文件，和运行记录同一套理由：一个场景的历史不撑大另一个场景的文件。 */
  private evaluationsPath(sceneId: string): string {
    return join(this.rootDir, 'evaluations', `${this.safeSceneId(sceneId)}.jsonl`)
  }

  /** 读取全部数据集。 */
  listDatasets(): CapabilityDataset[] {
    const index = readJsonFileSafe<DatasetsIndex>(this.datasetsPath())
    if (!index || index.schemaVersion !== INDEX_VERSION || !Array.isArray(index.datasets)) return []
    return index.datasets
  }

  /** 覆盖写入数据集索引。 */
  saveDatasets(datasets: CapabilityDataset[]): void {
    this.ensureRoot()
    writeJsonFileAtomic(this.datasetsPath(), { schemaVersion: INDEX_VERSION, datasets } satisfies DatasetsIndex)
  }

  /** 读取某个场景的全部评测记录（按开始时间升序）。 */
  listEvaluations(sceneId: string): CapabilityEvaluation[] {
    return this.readJsonLines<CapabilityEvaluation>(this.evaluationsPath(sceneId))
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  /** 追加一条评测记录。 */
  appendEvaluation(evaluation: CapabilityEvaluation): void {
    this.ensureRoot()
    const dir = join(this.rootDir, 'evaluations')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const current = this.listEvaluations(evaluation.sceneId)
    writeJsonLinesFileAtomic(this.evaluationsPath(evaluation.sceneId), [...current, evaluation])
  }

  /** 导出记录（包版本 ↔ 场景版本）。 */
  listDeliveries(): CapabilityDelivery[] {
    const index = readJsonFileSafe<DeliveriesIndex>(this.deliveriesPath())
    if (!index || index.schemaVersion !== INDEX_VERSION || !Array.isArray(index.deliveries)) return []
    return index.deliveries
  }

  /** 追加一条导出记录。 */
  appendDelivery(delivery: CapabilityDelivery): void {
    this.ensureRoot()
    writeJsonFileAtomic(this.deliveriesPath(), {
      schemaVersion: INDEX_VERSION,
      deliveries: [...this.listDeliveries(), delivery],
    } satisfies DeliveriesIndex)
  }

  /**
   * 把能力包写到 `<root>/deliveries/<fileName>` 并返回绝对路径。
   *
   * 交付物必须真的落盘：用户要把它交给另一个项目，只有一条导出记录是拿不走东西的。
   * 文件名由服务层清洗过（这里再兜一层），所以路径不会越出 deliveries/。
   */
  writeDeliveryFile(fileName: string, pkg: CapabilityPackage): string {
    const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '_')
    if (safe.length === 0 || safe.startsWith('.')) {
      throw new CapabilityFactoryStoreError('DELIVERY_NAME_INVALID', `导出文件名不合法：${fileName}`)
    }
    const dir = join(this.rootDir, 'deliveries')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, safe)
    writeJsonFileAtomic(path, pkg)
    return path
  }
}
