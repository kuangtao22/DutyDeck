import { createHash } from 'node:crypto'
import { opendirSync, lstatSync } from 'node:fs'
import { basename, extname, join, posix } from 'node:path'
import type { PrototypeProjectInspection } from '@proma/shared'
import { containsKnowledgeSecret } from '../project-knowledge/sensitive-text'
import { interactionSourcePath, readInteractionFile } from './paths'

/** 来源读取依赖由生产 facade 提供稳定目录实现。 */
export type InteractionSourceReader = (relativePath: string, maxBytes: number) => Promise<Uint8Array>
/** 禁止扫描凭据、构建产物和模块自身。 */
const EXCLUDED = /^(?:\.|node_modules$|dist$|out$|build$|vendor$)|(?:secret|credential|password|private[-_]?key)|\.(?:pem|key|p12|pfx)$/i
/** 单批来源总预算。 */
const MAX_BYTES = 4 * 1024 * 1024
/** 内容身份。 */
export function interactionHash(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
/** 检查相对路径是否属于允许的来源。 */
export function assertSourceAllowed(path: string): void {
  if (path.replaceAll('\\', '/').split('/').some(part => EXCLUDED.test(part))) throw new Error('来源属于敏感或排除目录')
}
/** 项目来源服务，所有读取保留预算与秘密检测。 */
export class InteractionSourceService {
  constructor(private readonly root: string, private readonly reader?: InteractionSourceReader) {}
  /** 读取单个受授权来源的有界字节。 */
  async bytes(path: string, maxBytes = MAX_BYTES): Promise<Buffer> {
    assertSourceAllowed(path)
    /** 先拒绝静态越界及链接，再由稳定目录 reader 读取。 */
    const absolute = interactionSourcePath(this.root, path)
    /** 来源的独立字节副本。 */
    const bytes = this.reader ? Buffer.from(await this.reader(path, maxBytes)) : readInteractionFile(absolute, maxBytes)
    if (bytes.length > maxBytes) throw new Error('来源超过读取预算')
    return bytes
  }
  /** 读取源码文本；不返回密钥内容。 */
  async text(path: string, maxBytes = 512 * 1024): Promise<string> {
    /** 严格 UTF-8 正文。 */
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await this.bytes(path, maxBytes))
    if (text.includes('\0') || containsKnowledgeSecret(text)) throw new Error('来源包含二进制或敏感内容')
    return text
  }
  /** 有界批量源码读取，先限制路径数量，再逐项消耗字节预算。 */
  async read(paths: string[]): Promise<Array<{ path: string; hash: string; content: string }>> {
    if (paths.length > 24) throw new Error('来源数量超过预算')
    /** 本批剩余预算。 */
    let remaining = MAX_BYTES
    /** 已读取的来源。 */
    const result: Array<{ path: string; hash: string; content: string }> = []
    for (const path of paths) {
      /** 当前来源正文。 */
      const content = await this.text(path, Math.min(remaining, 512 * 1024))
      remaining -= Buffer.byteLength(content)
      result.push({ path, hash: interactionHash(content), content })
    }
    return result
  }
  /** 只枚举有限文件元数据，不运行项目或读取配置秘密。 */
  inspect(): PrototypeProjectInspection {
    /** 有界扫描结果。 */
    const result: PrototypeProjectInspection = { projectName: basename(this.root), frameworks: [], files: [], warnings: [], truncated: false }
    /** 待枚举的目录及深度。 */
    const queue = [{ path: '', depth: 0 }]
    /** 扫描时间预算起点。 */
    const started = Date.now()
    /** 已枚举的条目总量。 */
    let count = 0
    while (queue.length) {
      /** 当前目录。 */
      const directory = queue.shift()!
      if (Date.now() - started > 1000 || count >= 3000) { result.truncated = true; break }
      try {
        /** 枚举前逐级复核父链，拒绝已被替换的目录。 */
        interactionSourcePath(this.root, posix.join(directory.path, 'scan-sentinel'))
        /** 按条目读取目录，不为大型依赖树一次性分配完整列表。 */
        const handle = opendirSync(join(this.root, directory.path))
        try {
          for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
            count += 1
            if (count > 3000 || Date.now() - started > 1000) { result.truncated = true; break }
            if (EXCLUDED.test(entry.name) || entry.isSymbolicLink()) continue
            /** 当前条目的项目相对路径。 */
            const path = posix.join(directory.path, entry.name)
            if (entry.isDirectory()) { if (directory.depth < 6) queue.push({ path, depth: directory.depth + 1 }); else result.truncated = true; continue }
            /** 扩展名分类。 */
            const extension = extname(entry.name).toLowerCase()
            /** 同时索引 Web 与原生移动端源码，供 Agent 按业务页面读取，不推断具体 UI 框架。 */
            const kind = /\.html?$/.test(extension) ? 'html' : /\.(tsx?|jsx?|vue|svelte|json|swift|kt|kts|dart)$/.test(extension) ? 'code' : /\.(css|scss)$/.test(extension) ? 'style' : /\.(png|jpe?g|webp|gif)$/.test(extension) ? 'image' : null
            if (kind && entry.isFile()) result.files.push({ path, kind, byteSize: lstatSync(interactionSourcePath(this.root, path)).size })
            if (entry.name === 'next.config.js' || entry.name === 'next.config.ts') result.frameworks.push('Next.js')
            if (entry.name === 'vite.config.ts') result.frameworks.push('Vite')
          }
        } finally { handle.closeSync() }
      } catch { result.warnings.push(`目录无法安全读取：${directory.path || '.'}`) }
    }
    if (result.truncated) result.warnings.push('扫描达到条目、深度或时间预算，仅展示部分项目')
    result.frameworks = [...new Set(result.frameworks)]
    return result
  }
}
