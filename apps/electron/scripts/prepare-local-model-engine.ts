#!/usr/bin/env bun
/** 固定 llama.cpp 资产准备：先校验归档，再在内存解析并发布不可变目录和原子清单。 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod, rename, rm, readdir } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import AdmZip from 'adm-zip'
import { writeJsonFileAtomic } from '../src/main/lib/safe-file'
import metadata from '../resources/local-model-engine/engine-version.json'

/** 固定资产的官方来源和不可变校验值。 */
export interface EngineAsset {
  /** 平台与架构标识。 */
  target: string
  /** 官方文件名。 */
  name: string
  /** 精确归档大小。 */
  size: number
  /** 官方 SHA-256。 */
  digest: string
  /** 官方下载入口。 */
  browser_download_url: string
}
/** 只在内存表示链接，避免归档向文件系统创建链接。 */
interface ArchiveEntry {
  /** 已验证的相对 POSIX 路径。 */
  name: string
  /** 普通文件内容；链接为空。 */
  data?: Buffer
  /** 已验证的链接目标。 */
  target?: string
  /** 原始普通权限，不保留特殊权限位。 */
  mode: number
}
/** 解压内存上限，避免畸形归档耗尽内存。 */
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024
/** 导出固定资产供构建合同回归使用。 */
export const ENGINE_ASSETS: readonly EngineAsset[] = metadata.assets

/** 校验相对归档路径；输入任意归档名称，返回无前导 ./ 的安全路径。 */
export function validateArchivePath(name: string): string {
  if (!name || /[\\:\x00-\x1f]/.test(name) || name.startsWith('/') || name.split('/').includes('..')) {
    throw new Error(`引擎归档路径越界：${name}`)
  }
  return name.replace(/^(\.\/)+/, '').replace(/\/$/, '')
}
/** 校验完整归档大小和摘要；失败抛错，绝不开始解包。 */
export function verifyArchive(data: Buffer, asset: EngineAsset): void {
  if (data.length !== asset.size) throw new Error('引擎归档大小不匹配')
  if (`sha256:${createHash('sha256').update(data).digest('hex')}` !== asset.digest) throw new Error('引擎归档 SHA-256 校验失败')
}
/** 解析固定 USTAR/GNU tar；只接受普通文件、目录和受限软/硬链接。 */
function readTar(archive: Buffer): ArchiveEntry[] {
  /** gzip 解压有明确输出上限。 */
  const tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES })
  /** 已解析条目。 */
  const entries: ArchiveEntry[] = []
  /** 固定宽度的 tar 字符串字段。 */
  const field = (offset: number, size: number): string => tar.subarray(offset, offset + size).toString('utf8').split('\0')[0]!
  for (let offset = 0; offset + 512 <= tar.length;) {
    if (tar.subarray(offset, offset + 512).every((byte) => byte === 0)) break
    /** USTAR 前缀属于路径而不是磁盘目录指令。 */
    const prefix = field(offset + 345, 155)
    /** 每个头均校验 checksum，拒绝截断和格式混淆。 */
    const checksum = tar.subarray(offset, offset + 512).reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (checksum !== parseInt(field(offset + 148, 8).trim(), 8)) throw new Error('引擎 tar 头校验失败')
    /** 基础字段来自固定官方归档，不接受 PAX 覆盖或特殊设备。 */
    const name = validateArchivePath(`${prefix ? `${prefix}/` : ''}${field(offset, 100)}`)
    const size = parseInt(field(offset + 124, 12).trim(), 8) || 0
    const mode = parseInt(field(offset + 100, 8).trim(), 8) & 0o777
    const type = field(offset + 156, 1)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('引擎 tar 内容被截断')
    if (type === '' || type === '0') entries.push({ name, mode, data: tar.subarray(offset + 512, offset + 512 + size) })
    else if (type === '1' || type === '2') {
      /** 软链接相对自身目录，硬链接相对归档根；两者均不得包含越界段。 */
      const target = validateArchivePath(field(offset + 157, 100))
      entries.push({ name, mode, target: type === '2' ? posix.join(posix.dirname(name), target) : target })
    } else if (type !== '5') throw new Error(`引擎 tar 含不支持条目：${type}`)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}
/** 读取 ZIP，先累计未压缩大小并拒绝链接，再解压普通条目。 */
function readZip(archive: Buffer): ArchiveEntry[] {
  /** 复用项目已有 ZIP 依赖，不引入构建依赖。 */
  const zipEntries = new AdmZip(archive).getEntries()
  let totalBytes = 0
  for (const entry of zipEntries) {
    validateArchivePath(entry.entryName)
    totalBytes += entry.header.size
    if (totalBytes > MAX_UNPACKED_BYTES || ((entry.attr >>> 16) & 0o170000) === 0o120000) throw new Error('引擎 ZIP 大小超限或包含符号链接')
  }
  return zipEntries.filter((entry) => !entry.isDirectory).map((entry) => ({ name: validateArchivePath(entry.entryName), mode: 0o755, data: entry.getData() }))
}
/** 从已验证归档提取 server、动态库和许可；链接解析成普通文件，绝不写磁盘链接。 */
export function unpackEngine(archive: Buffer, asset: EngineAsset): ArchiveEntry[] {
  verifyArchive(archive, asset)
  /** 唯一映射防止重名条目覆盖。 */
  const entries = asset.name.endsWith('.zip') ? readZip(archive) : readTar(archive)
  const byName = new Map<string, ArchiveEntry>()
  for (const entry of entries) {
    if (byName.has(entry.name)) throw new Error('引擎归档存在重复路径')
    byName.set(entry.name, entry)
  }
  /** 递归解析链接，拒绝循环和缺失目标。 */
  function content(entry: ArchiveEntry, visited = new Set<string>()): Buffer {
    if (visited.has(entry.name)) throw new Error('引擎归档链接循环')
    visited.add(entry.name)
    if (entry.data) return entry.data
    const linked = byName.get(entry.target ?? '')
    if (!linked) throw new Error('引擎归档链接目标不存在')
    return content(linked, visited)
  }
  /** 保留原始相对布局，兼容 @loader_path/../lib 与 Linux RPATH。 */
  const result: ArchiveEntry[] = []
  const names = new Set<string>()
  for (const entry of entries) {
    const name = posix.basename(entry.name)
    if (!/^(llama-server(?:\.exe)?|.*\.(?:dylib|dll)|.*\.so(?:\.[\d.]+)?|.*\.(?:metal|metallib)|(?:LICENSE|COPYING|NOTICE).*)$/i.test(name)) continue
    if (names.has(entry.name.toLowerCase())) throw new Error('引擎归档存在文件名冲突')
    names.add(entry.name.toLowerCase())
    result.push({ name: entry.name, data: content(entry), mode: entry.mode || 0o755 })
  }
  const executable = asset.target.startsWith('win32-') ? 'llama-server.exe' : 'llama-server'
  if (!result.some((entry) => posix.basename(entry.name) === executable)) throw new Error('引擎归档缺少 llama-server')
  return result
}
/** 固定官方 HTTPS 来源，手动验证每次重定向并限制传输大小。 */
async function download(asset: EngineAsset): Promise<Buffer> {
  let url = new URL(asset.browser_download_url)
  for (let redirects = 0; redirects < 6; redirects++) {
    if (url.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new Error('引擎下载地址不受信任')
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000) })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('引擎下载重定向缺少地址')
      url = new URL(location, url)
      continue
    }
    if (!response.ok || !response.body) throw new Error(`引擎下载失败：HTTP ${response.status}`)
    /** 归档仅约 12–20 MB，传输严格受固定大小约束。 */
    const chunks: Buffer[] = []
    let size = 0
    const reader = response.body.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > asset.size) throw new Error('引擎下载超过固定大小')
        chunks.push(Buffer.from(chunk.value))
      }
    } finally { await reader.cancel() }
    const data = Buffer.concat(chunks)
    verifyArchive(data, asset)
    return data
  }
  throw new Error('引擎下载重定向次数过多')
}
/** 准备新一代目录后原子切换清单；失败保留上一代可运行引擎，返回发布清单。 */
export async function installEngine(archive: Buffer, asset: EngineAsset, outputRoot: string) {
  /** 先完整验证，失败时不触碰资源目录。 */
  const entries = unpackEngine(archive, asset)
  const generation = `payload/${randomUUID()}`
  const directory = join(outputRoot, generation)
  await mkdir(directory, { recursive: true })
  try {
    /** 文件表供运行时检查完整性；签名后摘要仅代表准备阶段原始字节。 */
    const files = []
    for (const entry of entries) {
      const data = entry.data!
      await mkdir(dirname(join(directory, entry.name)), { recursive: true })
      await writeFile(join(directory, entry.name), data, { flag: 'wx', mode: entry.mode })
      await chmod(join(directory, entry.name), posix.basename(entry.name).startsWith('llama-server') ? 0o755 : entry.mode)
      files.push({ path: `${generation}/${entry.name}`, sha256: createHash('sha256').update(data).digest('hex'), sizeBytes: data.length })
    }
    /** 平台与架构来自受支持资产表。 */
    const [platform, arch] = asset.target.split('-')
    const executable = entries.find((entry) => posix.basename(entry.name) === `llama-server${platform === 'win32' ? '.exe' : ''}`)!.name
    const manifest = {
      schemaVersion: 1, engine: 'llama.cpp', version: metadata.version, releaseTag: metadata.releaseTag,
      sourceCommit: metadata.sourceCommit, platform, arch,
      executable: `${generation}/${executable}`,
      archiveSha256: asset.digest.slice(7), files,
    }
    writeJsonFileAtomic(join(outputRoot, 'manifest.json'), manifest, true)
    return manifest
  } catch (error) {
    /** 原子写在 rename 后 fsync 失败时清单可能已提交，不能删除它引用的这一代。 */
    let published = false
    try {
      const current = JSON.parse(await readFile(join(outputRoot, 'manifest.json'), 'utf8')) as { executable?: string }
      published = current.executable?.startsWith(`${generation}/`) === true
    } catch { /* 尚未发布清单时安全回收暂存目录。 */ }
    if (!published) await rm(directory, { recursive: true, force: true })
    throw error
  }
}
/** CLI 按构建目标准备资源；缓存固定归档，签名后始终从可信归档重建。 */
async function main(): Promise<void> {
  const platform = process.env.LOCAL_MODEL_ENGINE_PLATFORM || process.env.OFFICECLI_PLATFORM || process.platform
  const arch = process.env.LOCAL_MODEL_ENGINE_ARCH || process.env.OFFICECLI_ARCH || process.arch
  const asset = ENGINE_ASSETS.find((candidate) => candidate.target === `${platform}-${arch}`)
  if (!asset) throw new Error(`本地引擎不支持目标：${platform}-${arch}`)
  /** 缓存在 dist 外，不被安装包携带。 */
  const scriptDirectory = dirname(resolve(process.argv[1] ?? '.'))
  const cacheDirectory = resolve(scriptDirectory, '../.local-model-engine-cache')
  const cachePath = join(cacheDirectory, asset.name)
  let archive: Buffer
  try { archive = await readFile(cachePath); verifyArchive(archive, asset) } catch {
    archive = await download(asset)
    await mkdir(cacheDirectory, { recursive: true })
    const temporaryPath = `${cachePath}.${randomUUID()}.tmp`
    try { await writeFile(temporaryPath, archive); await rename(temporaryPath, cachePath) } finally { await rm(temporaryPath, { force: true }) }
  }
  /** 只在脚本直接执行时解析资源目录；主进程可安全复用归档校验和安装函数。 */
  const resourceRoot = resolve(scriptDirectory, '../resources/local-model-engine')
  const manifest = await installEngine(archive, asset, resourceRoot)
  /** 清理历史构建目录，避免每次准备让安装包线性膨胀；失败保留目录且给出明确错误。 */
  for (const previous of await readdir(join(resourceRoot, 'payload'))) {
    if (previous !== manifest.executable.split('/')[1]) await rm(join(resourceRoot, 'payload', previous), { recursive: true, force: true })
  }
  console.log(`[prepare:local-model-engine] 已准备 ${metadata.releaseTag} ${asset.target}：${manifest.executable}`)
}
/** 签名完所有子二进制、封签外层 app 前刷新摘要；路径来自本次构建的受控清单。 */
export async function refreshSignedManifest(outputRoot: string): Promise<void> {
  const manifestPath = join(outputRoot, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: Array<{ path: string; sha256: string; sizeBytes: number }> }
  for (const file of manifest.files) {
    const relativePath = validateArchivePath(file.path)
    const data = await readFile(join(outputRoot, relativePath))
    file.sha256 = createHash('sha256').update(data).digest('hex')
    file.sizeBytes = data.length
  }
  writeJsonFileAtomic(manifestPath, manifest, true)
}
/** CLI 入口使用显式 Promise 链，避免被主进程 CJS bundle 传播顶层 await。 */
const invokedFile = process.argv[1] ? basename(process.argv[1]) : ''
if (invokedFile === 'prepare-local-model-engine.ts' || invokedFile === 'prepare-local-model-engine.js') {
  const run = process.argv[2] === '--refresh-manifest' && process.argv[3]
    ? refreshSignedManifest(resolve(process.argv[3]))
    : main()
  run.catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
