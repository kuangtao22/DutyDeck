import { isServerOpsId } from './server-ops'

/** 部署页面使用的独立 IPC 通道；执行通道将在发布服务具备完整证据后再开放。 */
export const SERVER_OPS_DEPLOYMENT_CHANNELS = {
  LIST_TARGETS: 'server-ops:deployment-list-targets',
  SAVE_TARGET: 'server-ops:deployment-save-target',
  CHECK_TARGET: 'server-ops:deployment-check-target',
  LIST_RUNS: 'server-ops:deployment-list-runs',
} as const

/** 已纳管的服务器 Compose 项目。 */
export interface ServerOpsDeploymentTarget {
  id: string
  revision: number
  projectId: string
  hostId: string
  name: string
  environment: string
  composeProject: string
  composeFile: string
  sourceUrl: string
  registry: string
  accessUrl: string
  createdAt: number
  updatedAt: number
}

/** 保存目标时的输入；revision 和时间戳由 Main 生成。 */
export type ServerOpsDeploymentTargetSaveInput = {
  target: Omit<ServerOpsDeploymentTarget, 'revision' | 'createdAt' | 'updatedAt'>
  expectedRevision: number
}

/** 项目与主机的稳定查询范围。 */
export interface ServerOpsDeploymentListInput { projectId: string; hostId: string }
/** 目标检查输入。 */
export interface ServerOpsDeploymentCheckInput { targetId: string; expectedRevision: number }

/** 检查结果的事实状态；未核对不能被 UI 显示为通过。 */
export type ServerOpsDeploymentEvidenceStatus = 'passed' | 'blocked' | 'unverified'
export interface ServerOpsDeploymentEvidence { code: string; status: ServerOpsDeploymentEvidenceStatus; message: string }

/** Compose 现场检查快照；canDeploy 固定为 false，直到完整发布服务接入。 */
export interface ServerOpsDeploymentCheck {
  targetId: string
  targetRevision: number
  checkedAt: number
  expiresAt: number
  canDeploy: false
  evidence: ServerOpsDeploymentEvidence[]
  services: Array<{ name: string; image: string }>
}

/** 持久发布运行记录，独立于 Agent 会话和页面生命周期。 */
export interface ServerOpsDeploymentRun {
  id: string
  targetId: string
  targetRevision: number
  projectId: string
  hostId: string
  writerId: string
  revision: number
  planHash: string
  bundleHash: string
  kind: 'release' | 'rollback'
  status: 'running' | 'verifying' | 'succeeded' | 'failed' | 'unknown'
  startedAt: number
  updatedAt: number
  finishedAt?: number
  parentRunId?: string
  summary: string
}

/** 未知值中的普通对象判断。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** DTO 严格字段检查，防止 renderer 注入未来未支持的字段。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

/** 受控、无终端控制字符的文本。 */
function isText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 非负安全整数。 */
function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 完整 SHA-256 内容地址。 */
function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
}

/** 规范化后的绝对 Compose 文件路径。 */
function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.startsWith('/')
    && !value.includes('//') && !value.split('/').includes('..') && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 仅保存不带凭据、查询和片段的 HTTP(S) 来源或访问地址。 */
function isHttpUrl(value: unknown): value is string {
  return value === '' || (typeof value === 'string' && value.length <= 2048
    && /^https?:\/\/[^/?#:@]+(?:\/[^?#]*)?$/u.test(value))
}

/** 镜像仓库地址不接受 scheme、用户名、密码或查询参数。 */
function isRegistry(value: unknown): value is string {
  return value === '' || (typeof value === 'string' && value.length <= 512
    && /^[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._/-]+)?$/u.test(value))
}

/** Compose 项目名的 Docker 兼容字符集。 */
function isComposeProject(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value)
}

const TARGET_KEYS = ['id', 'revision', 'projectId', 'hostId', 'name', 'environment', 'composeProject', 'composeFile', 'sourceUrl', 'registry', 'accessUrl', 'createdAt', 'updatedAt'] as const
const TARGET_INPUT_KEYS = ['id', 'projectId', 'hostId', 'name', 'environment', 'composeProject', 'composeFile', 'sourceUrl', 'registry', 'accessUrl'] as const

/** 严格解析已保存目标。 */
export function parseServerOpsDeploymentTarget(value: unknown): ServerOpsDeploymentTarget {
  if (!isRecord(value) || !hasOnlyKeys(value, TARGET_KEYS)
    || !isServerOpsId(value.id) || !isServerOpsId(value.projectId) || !isServerOpsId(value.hostId)
    || !isSafeInteger(value.revision) || value.revision < 1
    || !isText(value.name, 80) || !isText(value.environment, 40) || !isComposeProject(value.composeProject)
    || !isSafeAbsolutePath(value.composeFile) || !isHttpUrl(value.sourceUrl) || !isRegistry(value.registry) || !isHttpUrl(value.accessUrl)
    || !isSafeInteger(value.createdAt) || !isSafeInteger(value.updatedAt)) throw new Error('SERVER_OPS_DEPLOYMENT_TARGET_INVALID')
  return { id: value.id, revision: value.revision, projectId: value.projectId, hostId: value.hostId, name: value.name, environment: value.environment, composeProject: value.composeProject, composeFile: value.composeFile, sourceUrl: value.sourceUrl, registry: value.registry, accessUrl: value.accessUrl, createdAt: value.createdAt, updatedAt: value.updatedAt }
}

/** 严格解析目标保存输入，并返回不含服务端字段的目标。 */
export function parseServerOpsDeploymentTargetSaveInput(value: unknown): ServerOpsDeploymentTargetSaveInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ['target', 'expectedRevision']) || !isSafeInteger(value.expectedRevision)
    || !isRecord(value.target) || !hasOnlyKeys(value.target, TARGET_INPUT_KEYS)
    || !isServerOpsId(value.target.id) || !isServerOpsId(value.target.projectId) || !isServerOpsId(value.target.hostId)
    || !isText(value.target.name, 80) || !isText(value.target.environment, 40) || !isComposeProject(value.target.composeProject)
    || !isSafeAbsolutePath(value.target.composeFile) || !isHttpUrl(value.target.sourceUrl)
    || !isRegistry(value.target.registry) || !isHttpUrl(value.target.accessUrl)) {
    throw new Error('SERVER_OPS_DEPLOYMENT_SAVE_INPUT_INVALID')
  }
  return {
    expectedRevision: value.expectedRevision,
    target: {
      id: value.target.id, projectId: value.target.projectId, hostId: value.target.hostId,
      name: value.target.name, environment: value.target.environment, composeProject: value.target.composeProject,
      composeFile: value.target.composeFile, sourceUrl: value.target.sourceUrl, registry: value.target.registry,
      accessUrl: value.target.accessUrl,
    },
  }
}
export function parseServerOpsDeploymentListInput(value: unknown): ServerOpsDeploymentListInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ['projectId', 'hostId']) || !isServerOpsId(value.projectId) || !isServerOpsId(value.hostId)) throw new Error('SERVER_OPS_DEPLOYMENT_LIST_INPUT_INVALID')
  return { projectId: value.projectId, hostId: value.hostId }
}

/** 严格解析检查查询。 */
export function parseServerOpsDeploymentCheckInput(value: unknown): ServerOpsDeploymentCheckInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ['targetId', 'expectedRevision']) || !isServerOpsId(value.targetId) || !isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) throw new Error('SERVER_OPS_DEPLOYMENT_CHECK_INPUT_INVALID')
  return { targetId: value.targetId, expectedRevision: value.expectedRevision }
}

/** 严格解析检查证据。 */
export function parseServerOpsDeploymentEvidence(value: unknown): ServerOpsDeploymentEvidence {
  if (!isRecord(value) || !hasOnlyKeys(value, ['code', 'status', 'message']) || !isText(value.code, 80) || !/^[A-Za-z0-9_.:-]+$/u.test(value.code) || !['passed', 'blocked', 'unverified'].includes(value.status as string) || !isText(value.message, 512, true)) throw new Error('SERVER_OPS_DEPLOYMENT_EVIDENCE_INVALID')
  return { code: value.code, status: value.status as ServerOpsDeploymentEvidenceStatus, message: value.message }
}

/** 严格解析检查结果。 */
export function parseServerOpsDeploymentCheck(value: unknown): ServerOpsDeploymentCheck {
  if (!isRecord(value) || !hasOnlyKeys(value, ['targetId', 'targetRevision', 'checkedAt', 'expiresAt', 'canDeploy', 'evidence', 'services']) || !isServerOpsId(value.targetId) || !isSafeInteger(value.targetRevision) || !isSafeInteger(value.checkedAt) || !isSafeInteger(value.expiresAt) || value.expiresAt < value.checkedAt || value.canDeploy !== false || !Array.isArray(value.evidence) || value.evidence.length > 100 || !Array.isArray(value.services) || value.services.length > 50) throw new Error('SERVER_OPS_DEPLOYMENT_CHECK_INVALID')
  const evidence = value.evidence.map(parseServerOpsDeploymentEvidence)
  const services = value.services.map((service) => { if (!isRecord(service) || !hasOnlyKeys(service, ['name', 'image']) || !isText(service.name, 128) || !isText(service.image, 512)) throw new Error('SERVER_OPS_DEPLOYMENT_CHECK_INVALID'); return { name: service.name, image: service.image } })
  return { targetId: value.targetId, targetRevision: value.targetRevision, checkedAt: value.checkedAt, expiresAt: value.expiresAt, canDeploy: false, evidence, services }
}

/** 严格解析发布运行记录。 */
export function parseServerOpsDeploymentRun(value: unknown): ServerOpsDeploymentRun {
  const keys = ['id', 'targetId', 'targetRevision', 'projectId', 'hostId', 'writerId', 'revision', 'planHash', 'bundleHash', 'kind', 'status', 'startedAt', 'updatedAt', 'finishedAt', 'parentRunId', 'summary']
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isServerOpsId(value.id) || !isServerOpsId(value.targetId) || !isServerOpsId(value.projectId) || !isServerOpsId(value.hostId) || !isServerOpsId(value.writerId) || !isSafeInteger(value.targetRevision) || !isSafeInteger(value.revision) || value.revision < 1 || !isSha256(value.planHash) || !isSha256(value.bundleHash) || !['release', 'rollback'].includes(value.kind as string) || !['running', 'verifying', 'succeeded', 'failed', 'unknown'].includes(value.status as string) || !isSafeInteger(value.startedAt) || !isSafeInteger(value.updatedAt) || !isText(value.summary, 512, true) || (value.finishedAt !== undefined && !isSafeInteger(value.finishedAt)) || (value.parentRunId !== undefined && !isServerOpsId(value.parentRunId))) throw new Error('SERVER_OPS_DEPLOYMENT_RUN_INVALID')
  return { id: value.id, targetId: value.targetId, targetRevision: value.targetRevision, projectId: value.projectId, hostId: value.hostId, writerId: value.writerId, revision: value.revision, planHash: value.planHash, bundleHash: value.bundleHash, kind: value.kind as ServerOpsDeploymentRun['kind'], status: value.status as ServerOpsDeploymentRun['status'], startedAt: value.startedAt, updatedAt: value.updatedAt, ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }), ...(value.parentRunId === undefined ? {} : { parentRunId: value.parentRunId }), summary: value.summary }
}

/** 对 preload 返回的目标列表做严格边界校验。 */
export function parseServerOpsDeploymentTargets(value: unknown): ServerOpsDeploymentTarget[] { if (!Array.isArray(value) || value.length > 100) throw new Error('SERVER_OPS_DEPLOYMENT_TARGETS_INVALID'); return value.map(parseServerOpsDeploymentTarget) }
/** 对 preload 返回的运行历史做严格边界校验。 */
export function parseServerOpsDeploymentRuns(value: unknown): ServerOpsDeploymentRun[] { if (!Array.isArray(value) || value.length > 500) throw new Error('SERVER_OPS_DEPLOYMENT_RUNS_INVALID'); return value.map(parseServerOpsDeploymentRun) }
