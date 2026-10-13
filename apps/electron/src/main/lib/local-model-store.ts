/**
 * DutyDeck 内置模型资产清单。
 *
 * 该 store 只负责清单和文件状态，不启动引擎也不发起下载；运行时服务通过
 * 它把“文件已经校验”与“模型当前正在运行”保持成两个独立状态。
 */

import { existsSync, mkdirSync, readFileSync, lstatSync, constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { LocalModelAsset, LocalModelCapabilityEvidence, LocalModelLifecycleState } from '@proma/shared'
import { getLocalModelsDir, getLocalModelsManifestPath } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

interface LocalModelManifest {
  schemaVersion: 1
  assets: LocalModelAsset[]
  [key: string]: unknown
}

export interface LocalModelStoreOptions {
  /** 测试时注入独立业务数据根。 */
  configDir?: string
  /** 可注入时钟，保证状态更新时间可测试。 */
  now?: () => number
}

/** 管理 ~/.DutyDeck/models 下的模型资产和 JSON 清单。 */
export class LocalModelStore {
  private readonly modelsDir: string
  private readonly manifestPath: string
  private readonly now: () => number

  constructor(options: LocalModelStoreOptions = {}) {
    const configDir = options.configDir
    this.modelsDir = getLocalModelsDir(configDir)
    this.manifestPath = getLocalModelsManifestPath(configDir)
    this.now = options.now ?? Date.now
  }

  /** 确保模型目录存在，避免写清单时把业务根误当成模型文件。 */
  ensureModelsDir(): string {
    this.assertNotSymlink(this.modelsDir)
    mkdirSync(this.modelsDir, { recursive: true })
    return this.modelsDir
  }

  /** 返回模型文件的受管路径；assetId 和文件名必须是单段安全值。 */
  resolveAssetFilePath(assetId: string, fileName: string): string {
    this.assertSafeSegment(assetId, '模型资产 ID')
    this.assertSafeSegment(fileName, '模型文件名')
    this.assertNotSymlink(this.modelsDir)
    this.assertNotSymlink(join(this.modelsDir, assetId))
    const path = join(this.modelsDir, assetId, fileName)
    this.assertNotSymlink(path)
    return path
  }

  /** 读取清单；缺失时返回空资产，不会写入默认模型。 */
  listAssets(): LocalModelAsset[] {
    const manifest = this.readManifest()
    return manifest.assets.map((asset) => ({ ...asset, capability: { ...asset.capability } }))
  }

  /** 查询单个模型资产。 */
  getAsset(assetId: string): LocalModelAsset | undefined {
    return this.listAssets().find((asset) => asset.assetId === assetId)
  }

  /** 以原子方式登记已经完成哈希校验的模型文件。 */
  async markInstalled(input: Omit<LocalModelAsset, 'status' | 'updatedAt'>, signal?: AbortSignal): Promise<LocalModelAsset> {
    await this.verifyFile(input, signal)
    signal?.throwIfAborted()
    const manifest = this.readManifest()
    const now = this.now()
    const installed: LocalModelAsset = {
      ...input,
      status: 'installed',
      installedAt: now,
      updatedAt: now,
    }
    const existingIndex = manifest.assets.findIndex((asset) => asset.assetId === input.assetId)
    if (existingIndex >= 0) manifest.assets[existingIndex] = installed
    else manifest.assets.push(installed)
    this.writeManifest(manifest)
    return { ...installed, capability: { ...installed.capability } }
  }

  /** 更新单个资产的生命周期状态并持久化最近错误。 */
  updateStatus(assetId: string, status: LocalModelLifecycleState, lastError?: string): LocalModelAsset {
    const manifest = this.readManifest()
    const asset = this.requireAsset(manifest, assetId)
    const updated: LocalModelAsset = {
      ...asset,
      status,
      updatedAt: this.now(),
      ...(lastError ? { lastError } : {}),
    }
    if (!lastError && asset.lastError !== undefined) delete updated.lastError
    const index = manifest.assets.findIndex((candidate) => candidate.assetId === assetId)
    manifest.assets[index] = updated
    this.writeManifest(manifest)
    return { ...updated, capability: { ...updated.capability } }
  }

  /** 更新模型启用状态；启用不等于已加载，也不修改能力证据。 */
  setEnabled(assetId: string, enabled: boolean): LocalModelAsset {
    const manifest = this.readManifest()
    const asset = this.requireAsset(manifest, assetId)
    const updated: LocalModelAsset = { ...asset, enabled, updatedAt: this.now() }
    const index = manifest.assets.findIndex((candidate) => candidate.assetId === assetId)
    manifest.assets[index] = updated
    this.writeManifest(manifest)
    return { ...updated, capability: { ...updated.capability } }
  }

  /** 写入绑定当前模型哈希和引擎版本的能力探测结果。 */
  updateCapability(assetId: string, capability: LocalModelCapabilityEvidence): LocalModelAsset {
    const manifest = this.readManifest()
    const asset = this.requireAsset(manifest, assetId)
    const updated: LocalModelAsset = { ...asset, capability: { ...capability }, updatedAt: this.now() }
    const index = manifest.assets.findIndex((candidate) => candidate.assetId === assetId)
    manifest.assets[index] = updated
    this.writeManifest(manifest)
    return { ...updated, capability: { ...updated.capability } }
  }

  /** 流式验证受管文件；禁止符号链接，限制内存且核对大小和 SHA-256。 */
  async verifyFile(asset: Pick<LocalModelAsset, 'assetId' | 'fileName' | 'sha256' | 'sizeBytes'>, signal?: AbortSignal): Promise<void> {
    const path = this.resolveAssetFilePath(asset.assetId, asset.fileName)
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.size !== asset.sizeBytes) throw new Error('模型文件大小与清单不一致')
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(1024 * 1024)
      let position = 0
      while (position < before.size) {
        signal?.throwIfAborted()
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - position), position)
        if (!bytesRead) throw new Error('模型文件读取意外结束')
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
      }
      signal?.throwIfAborted()
      const after = await file.stat()
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || hash.digest('hex') !== asset.sha256.toLowerCase()) throw new Error('模型文件 SHA-256 校验失败')
      this.resolveAssetFilePath(asset.assetId, asset.fileName)
    } finally { await file.close() }
  }

  /** 显式拒绝文件与目录链接，不跟随攻击者置换的受管路径。 */
  assertNotSymlink(path: string): void {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('模型路径禁止符号链接') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }

  private readManifest(): LocalModelManifest {
    this.assertNotSymlink(this.modelsDir)
    this.assertNotSymlink(this.manifestPath)
    if (!existsSync(this.manifestPath)) return { schemaVersion: 1, assets: [] }
    const parsed = readJsonFileSafe<LocalModelManifest>(this.manifestPath, { validate: isLocalModelManifest })
    if (!parsed) throw new Error('本地模型清单损坏，请备份后修复 ~/.DutyDeck/models/manifest.json')
    return {
      ...parsed,
      assets: parsed.assets.map((asset) => ({ ...asset, capability: { ...asset.capability } })),
    }
  }

  private writeManifest(manifest: LocalModelManifest): void {
    this.ensureModelsDir()
    this.assertNotSymlink(this.manifestPath)
    writeJsonFileAtomic(this.manifestPath, manifest)
  }

  private requireAsset(manifest: LocalModelManifest, assetId: string): LocalModelAsset {
    const asset = manifest.assets.find((candidate) => candidate.assetId === assetId)
    if (!asset) throw new Error(`本地模型资产不存在: ${assetId}`)
    return asset
  }

  private assertSafeSegment(value: string, label: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) || value === '.' || value === '..') {
      throw new Error(`${label}包含非法路径片段`)
    }
  }
}

/** 严格校验清单的最小结构，未知字段由 store 原样保留。 */
function isLocalModelManifest(value: unknown): value is LocalModelManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || !Array.isArray(record.assets)) return false
  return record.assets.every((asset) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false
    const item = asset as Record<string, unknown>
    return typeof item.assetId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(item.assetId)
      && typeof item.modelId === 'string'
      && typeof item.name === 'string'
      && typeof item.family === 'string'
      && typeof item.revision === 'string'
      && typeof item.fileName === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(item.fileName)
      && typeof item.sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(item.sha256)
      && typeof item.sizeBytes === 'number' && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes > 0
      && typeof item.status === 'string' && ['installed', 'starting', 'running', 'stopping', 'error'].includes(item.status)
      && typeof item.enabled === 'boolean'
      && isCapabilityEvidence(item.capability)
      && typeof item.updatedAt === 'number'
  })
}

/** 验证能力快照，防止损坏字段进入模型选择链路。 */
function isCapabilityEvidence(value: unknown): value is LocalModelCapabilityEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.state === 'unknown' || record.state === 'available' || record.state === 'unavailable'
}

/** 仅供单元测试复读写后文件，不进入 renderer。 */
export function readLocalModelManifestForTest(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}
