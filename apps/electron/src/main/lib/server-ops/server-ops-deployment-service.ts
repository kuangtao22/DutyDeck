import {
  parseServerOpsDeploymentCheck,
  parseServerOpsDeploymentCheckInput,
} from '@proma/shared'
import type {
  ServerOpsDeploymentCheck,
  ServerOpsDeploymentCheckInput,
  ServerOpsDeploymentTarget,
} from '@proma/shared'
import type { ServerOpsActiveConnectionIdentity } from './server-ops-connection-service'
import type { ServerOpsRuntimeExecResult } from '../../../utility/server-ops/server-ops-runtime-protocol'

/** Compose 只读探测固定使用 Unix daemon socket，并清除继承环境。 */
const COMPOSE_PREFIX = 'LC_ALL=C env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u DOCKER_CONFIG docker --host unix:///var/run/docker.sock compose'
/** 检查输出与错误摘要的硬上限，避免远端输出进入桌面进程后无界增长。 */
const MAX_OUTPUT_BYTES = 12_288
/** 检查结果的短时有效期；版本、配置或连接变化会额外使其失效。 */
const CHECK_TTL_MS = 5 * 60 * 1000

/** 部署检查所需的持久目标与连接只读能力。 */
export interface ServerOpsDeploymentServiceDependencies {
  store: {
    getTarget: (targetId: string) => ServerOpsDeploymentTarget | undefined
    listTargets: (input: { projectId: string; hostId: string }) => ServerOpsDeploymentTarget[]
  }
  getHost: (hostId: string) => { projectId: string } | undefined
  getActiveIdentity: (hostId: string) => ServerOpsActiveConnectionIdentity
  exec: (hostId: string, connectionId: string, command: string, timeoutMs: number) => Promise<ServerOpsRuntimeExecResult>
  now?: () => number
}

/** Compose 检查期间保留的服务投影，刻意不保存环境变量和挂载源路径。 */
interface ComposeServiceProjection {
  name: string
  image: string
}

/** Compose 现场输出中用于重新绑定入口的项目与文件身份。 */
interface ComposeInspection {
  services: ComposeServiceProjection[]
  projects: Set<string>
  files: Set<string>
  missingImages: number
}

/** 将受校验的参数安全地编码为 POSIX shell 单引号参数。 */
function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** 从 Compose 的 ConfigFiles 字段提取入口文件路径。 */
function parseComposeFiles(value: unknown): string[] {
  if (value === undefined) return []
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('SERVER_OPS_DEPLOYMENT_OUTPUT_INVALID')
  }
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

/** 识别可枚举的远端 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析 Docker Compose ps 的有界 JSON/JSONL 输出。 */
function parseComposeOutput(output: string): ComposeInspection {
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES || /[\u0000]/u.test(output)) {
    throw new Error('SERVER_OPS_DEPLOYMENT_OUTPUT_INVALID')
  }
  const trimmed = output.trim()
  if (trimmed.length === 0) return { services: [], projects: new Set(), files: new Set(), missingImages: 0 }
  let value: unknown
  try {
    /** Compose 的 json formatter 在不同版本分别输出数组或 JSONL，统一收敛成数组。 */
    if (trimmed.startsWith('[')) value = JSON.parse(trimmed)
    else value = trimmed.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
  } catch { throw new Error('SERVER_OPS_DEPLOYMENT_OUTPUT_INVALID') }
  const entries = Array.isArray(value) ? value : [value]
  if (entries.length > 50) throw new Error('SERVER_OPS_DEPLOYMENT_OUTPUT_INVALID')
  const services = entries.map((entry) => {
    if (!isRecord(entry)) throw new Error('SERVER_OPS_DEPLOYMENT_OUTPUT_INVALID')
    /** 仅接受 Compose ps 的公开摘要字段，额外字段（尤其是秘密）直接阻断。 */
    const allowed = new Set([
      'service', 'Service', 'image', 'Image', 'project', 'Project', 'files', 'ConfigFiles', 'configFiles',
      'ID', 'Id', 'Name', 'Command', 'State', 'Health', 'ExitCode', 'Publishers', 'Labels', 'Ports',
      'RunningFor', 'Status', 'CreatedAt', 'Size', 'Networks', 'Mounts',
    ])
    if (Object.keys(entry).some((key) => !allowed.has(key))) throw new Error('SERVER_OPS_DEPLOYMENT_OUTPUT_INVALID')
    /** Compose 版本可能返回 Go 模板字段名或 JSON formatter 的首字母大写字段名。 */
    const service = entry.service ?? entry.Service
    const image = entry.image ?? entry.Image
    const project = entry.project ?? entry.Project
    const files = entry.files ?? entry.ConfigFiles ?? entry.configFiles
    if (typeof service !== 'string' || service.length === 0 || service.length > 128
      || typeof project !== 'string' || project.length === 0 || project.length > 128) {
      throw new Error('SERVER_OPS_DEPLOYMENT_OUTPUT_INVALID')
    }
    const parsedFiles = parseComposeFiles(files)
    if (!/^[-_a-zA-Z0-9.]+$/u.test(service) || (image !== undefined && (typeof image !== 'string' || image.length === 0 || image.length > 512 || /[\u0000-\u001f\u007f]/u.test(image)))
      || /[\u0000-\u001f\u007f]/u.test(project)) {
      throw new Error('SERVER_OPS_DEPLOYMENT_OUTPUT_INVALID')
    }
    return { name: service, image: image ?? '（Compose 未返回镜像）', files: parsedFiles, project, missingImage: image === undefined }
  })
  return {
    services: services.map(({ name, image }) => ({ name, image })),
    projects: new Set(services.map(({ project }) => project)),
    files: new Set(services.flatMap(({ files }) => files)),
    missingImages: services.filter(({ missingImage }) => missingImage).length,
  }
}

/** 只读检查已有 Compose 项目，不触发 pull、build、up、down 或 restart。 */
export class ServerOpsDeploymentService {
  /** 防止同一目标的检查结果相互覆盖。 */
  private readonly flights = new Set<string>()
  /** 生命周期收口后拒绝迟到结果。 */
  private disposed = false
  /** 可替换时钟，测试不依赖系统时间。 */
  private readonly now: () => number

  constructor(private readonly dependencies: ServerOpsDeploymentServiceDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  /**
   * 对目标执行无副作用的现场身份检查。
   *
   * @param input 目标 ID 与调用方持有的目标 revision
   * @returns 有效期有限、不可直接授权发布的检查快照
   */
  async checkTarget(input: ServerOpsDeploymentCheckInput): Promise<ServerOpsDeploymentCheck> {
    if (this.disposed) throw new Error('SERVER_OPS_DEPLOYMENT_DISPOSED')
    const parsed = parseServerOpsDeploymentCheckInput(input)
    const target = this.dependencies.store.getTarget(parsed.targetId)
    if (!target || target.revision !== parsed.expectedRevision) throw new Error('SERVER_OPS_DEPLOYMENT_REVISION_CONFLICT')
    const host = this.dependencies.getHost(target.hostId)
    if (!host || host.projectId !== target.projectId) throw new Error('SERVER_OPS_DEPLOYMENT_SCOPE_CONFLICT')
    const flightKey = `${target.hostId}:${target.id}`
    if (this.flights.has(flightKey)) throw new Error('SERVER_OPS_DEPLOYMENT_BUSY')
    this.flights.add(flightKey)
    const identity = this.dependencies.getActiveIdentity(target.hostId)
    try {
      const version = await this.runRead(identity, `${COMPOSE_PREFIX} version --short`)
      /** 先让 Compose 自己解析指定文件，验证路径和变量展开不会依赖 ps 的展示字段。 */
      await this.runRead(identity, `${COMPOSE_PREFIX} -p ${quoteShellArg(target.composeProject)} -f ${quoteShellArg(target.composeFile)} config --quiet`)
      const output = await this.runRead(identity,
        `${COMPOSE_PREFIX} -p ${quoteShellArg(target.composeProject)} -f ${quoteShellArg(target.composeFile)} ps --all --format '{{json .}}'`)
      const inspection = parseComposeOutput(output)
      /** Compose ps 的公开摘要通常不携带 ConfigFiles；config --quiet 已证明当前入口。 */
      const files = inspection.files.size === 0 ? new Set([target.composeFile]) : inspection.files
      const projectMatches = inspection.services.length > 0
        && inspection.projects.size === 1 && inspection.projects.has(target.composeProject)
        && files.size === 1 && files.has(target.composeFile)
      const evidence = [
        {
          code: 'compose-cli',
          status: version.length > 0 ? 'passed' as const : 'blocked' as const,
          message: version.length > 0 ? '已读取远端 Compose 版本。' : '未读取到 Compose 版本。',
        },
        {
          code: 'compose-identity',
          status: projectMatches ? 'passed' as const : 'blocked' as const,
          message: projectMatches ? '已读取现有项目服务身份。' : '未能证明入口文件对应现有项目。',
        },
        {
          code: 'compose-images',
          status: inspection.missingImages === 0 ? 'passed' as const : 'unverified' as const,
          message: inspection.missingImages === 0 ? '已读取服务镜像字段。' : 'Compose 未返回部分服务镜像字段。',
        },
        {
          code: 'database-effects',
          status: 'unverified' as const,
          message: '数据库迁移、启动脚本和恢复资产尚未完成项目级核对。',
        },
      ]
      this.assertIdentity(identity)
      const currentHost = this.dependencies.getHost(target.hostId)
      if (!currentHost || currentHost.projectId !== target.projectId) throw new Error('SERVER_OPS_DEPLOYMENT_SCOPE_CONFLICT')
      return parseServerOpsDeploymentCheck({
        targetId: target.id,
        targetRevision: target.revision,
        checkedAt: this.now(),
        expiresAt: this.now() + CHECK_TTL_MS,
        canDeploy: false,
        evidence,
        services: inspection.services,
      })
    } finally {
      this.flights.delete(flightKey)
    }
  }

  /** 释放检查服务并让所有等待中的远端结果失效。 */
  dispose(): void {
    this.disposed = true
    this.flights.clear()
  }

  /** 执行一个固定超时的只读命令并检查连接代次。 */
  private async runRead(identity: ServerOpsActiveConnectionIdentity, command: string): Promise<string> {
    const result = await this.dependencies.exec(identity.hostId, identity.connectionId, command, 10_000)
    this.assertIdentity(identity)
    if (result.truncated || Buffer.byteLength(result.stdout, 'utf8') > MAX_OUTPUT_BYTES
      || (result.exitCode !== undefined && result.exitCode !== 0)) throw new Error('SERVER_OPS_DEPLOYMENT_OUTPUT_INVALID')
    return result.stdout
  }

  /** 远端 await 后重新读取活跃连接身份，阻止迟到结果污染新连接。 */
  private assertIdentity(identity: ServerOpsActiveConnectionIdentity): void {
    if (this.disposed) throw new Error('SERVER_OPS_DEPLOYMENT_DISPOSED')
    const current = this.dependencies.getActiveIdentity(identity.hostId)
    if (current.connectionId !== identity.connectionId || current.generation !== identity.generation) {
      throw new Error('SERVER_OPS_DEPLOYMENT_STALE_CONNECTION')
    }
  }
}
