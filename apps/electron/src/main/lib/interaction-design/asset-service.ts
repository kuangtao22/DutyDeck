import { randomUUID } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PrototypeAsset } from '@proma/shared'
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../safe-file'
import { assertInteractionId, interactionDirectory, readInteractionFile } from './paths'
import { interactionHash } from './source-service'

/** 图片最大字节数。 */
export const MAX_INTERACTION_IMAGE_BYTES = 20 * 1024 * 1024
/** 按魔数识别允许的被动图片格式，SVG 不准入。 */
export function interactionImageMime(bytes: Buffer): string {
  if (bytes.length < 12) throw new Error('图片内容无效')
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  throw new Error('只支持 PNG、JPEG、GIF 或 WebP 图片')
}
/** 图片记录与 blob 独立于 Canvas 生命周期，历史引用不回收。 */
export class InteractionAssetService {
  constructor(private readonly projectRoot: string) {}
  /** 返回并校验独立素材目录。 */
  private directory(create = false): string { return interactionDirectory(this.projectRoot, ['.proma', 'interaction-design', 'assets'], create) }
  /** 导入内容；同一 hash 重用已有逻辑资产。调用方持有模块锁。 */
  import(bytes: Buffer, name: string, expectedHash?: string): PrototypeAsset {
    if (bytes.length > MAX_INTERACTION_IMAGE_BYTES) throw new Error('图片超过大小限制')
    /** 经过魔数检查的 MIME。 */
    const mime = interactionImageMime(bytes)
    /** 内容身份。 */
    const hash = interactionHash(bytes)
    if (expectedHash && expectedHash !== hash) throw new Error('媒体内容 hash 不匹配')
    /** 资产目录。 */
    const root = this.directory(true)
    /** 已存在的同内容记录。 */
    const existing = this.list().find(asset => asset.hash === hash)
    if (existing) { this.content(existing.id); return existing }
    /** 不可变 blob 的持久文件。 */
    const blobs = interactionDirectory(this.projectRoot, ['.proma', 'interaction-design', 'assets', 'blobs', 'sha256', hash.slice(0, 2)], true)
    /** MIME 决定文件后缀，用户名称不参与路径。 */
    const extension = mime.split('/')[1]!
    /** 内容寻址二进制文件。 */
    const blob = join(blobs, `${hash}.${extension}`)
    if (!existsSync(blob)) {
      /** 独占临时文件，不跟随预置链接。 */
      const temporary = join(blobs, `stage-${randomUUID()}`)
      /** 创建前固定父目录身份。 */
      const parent = lstatSync(blobs)
      /** 受控临时文件句柄。 */
      const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      /** 临时文件的对象身份。 */
      const identity = fstatSync(descriptor)
      try { writeFileSync(descriptor, bytes); fsyncSync(descriptor) } finally { closeSync(descriptor) }
      try {
        /** 提交前复核目录和临时文件未置换。 */
        const current = lstatSync(blobs)
        /** 临时文件当前身份。 */
        const staged = lstatSync(temporary)
        if (current.dev !== parent.dev || current.ino !== parent.ino || staged.dev !== identity.dev || staged.ino !== identity.ino || !staged.isFile()) throw new Error('素材目录在写入期间变化')
        if (interactionHash(readInteractionFile(temporary, MAX_INTERACTION_IMAGE_BYTES)) !== hash) throw new Error('素材写入校验失败')
        renameSync(temporary, blob)
      } finally {
        if (existsSync(temporary)) {
          /** 只清理本次拥有的对象。 */
          const current = lstatSync(temporary)
          if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(temporary)
        }
      }
    }
    /** 复用未登记的 blob 前必须复核字节，崩溃残留不能直接成为资产。 */
    const storedBytes = readInteractionFile(blob, MAX_INTERACTION_IMAGE_BYTES)
    if (storedBytes.length !== bytes.length || interactionHash(storedBytes) !== hash) throw new Error('已有图片内容对象损坏')
    /** 与 blob 同目录的提交标记通过 safe-file 同步目录项，确保 metadata 不先于 blob 持久化。 */
    const commitPath = join(blobs, `${hash}.commit.json`)
    /** 已有残留标记的 CAS 身份。 */
    const commitState = readAtomicFileState(commitPath)
    writeJsonFileAtomicSecure(commitPath, { hash, byteSize: bytes.length, mime }, { expectedDestination: commitState ? { kind: 'state', state: commitState } : { kind: 'missing' } })
    /** 对外资产身份。 */
    const asset: PrototypeAsset = { id: randomUUID(), name: name.slice(0, 200), hash, mime, byteSize: bytes.length, createdAt: Date.now() }
    writeJsonFileAtomicSecure(join(root, `${asset.id}.json`), asset, { expectedDestination: { kind: 'missing' } })
    return asset
  }
  /** 列出轻量图片元数据，不载入 blob。 */
  list(): PrototypeAsset[] {
    /** 首次项目没有资产目录时返回空。 */
    const rawRoot = join(this.projectRoot, '.proma', 'interaction-design', 'assets')
    if (!existsSync(rawRoot)) return []
    /** 安全资产目录。 */
    const root = this.directory()
    /** 不静默丢弃资产，否则去重和引用准入会得到错误结论。 */
    const names = readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
    if (names.length > 2000) throw new Error('图片数量超过读取预算')
    return names.map(name => JSON.parse(readInteractionFile(join(root, name), 4096).toString()) as PrototypeAsset)
  }
  /** 读取并复核资产字节，防止落盘内容被修改。 */
  content(id: string): { assetId: string; dataUrl: string } {
    assertInteractionId(id)
    /** 安全资产目录。 */
    const root = this.directory()
    /** 资产记录。 */
    const asset = JSON.parse(readInteractionFile(join(root, `${id}.json`), 4096).toString()) as PrototypeAsset
    if (!/^[a-f0-9]{64}$/.test(asset.hash) || asset.id !== id) throw new Error('资产记录损坏')
    /** 内容寻址的原始二进制目录。 */
    const blobs = interactionDirectory(this.projectRoot, ['.proma', 'interaction-design', 'assets', 'blobs', 'sha256', asset.hash.slice(0, 2)])
    if (!/^image\/(png|jpeg|gif|webp)$/.test(asset.mime)) throw new Error('资产 MIME 无效')
    /** 校验后的原始图片。 */
    const bytes = readInteractionFile(join(blobs, `${asset.hash}.${asset.mime.split('/')[1]}`), MAX_INTERACTION_IMAGE_BYTES)
    if (bytes.length !== asset.byteSize || interactionHash(bytes) !== asset.hash || interactionImageMime(bytes) !== asset.mime) throw new Error('图片内容身份不匹配')
    return { assetId: id, dataUrl: `data:${asset.mime};base64,${bytes.toString('base64')}` }
  }
}
