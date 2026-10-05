import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'

const MAX_FILES = 10_000
const MAX_DIRECTORIES = 10_000
const STAT_CONCURRENCY = 16

/** 会话工作目录的一次扫描结果；可清理大小始终是总大小的子集。 */
export interface StorageWorkspaceSize {
  bytes: number
  count: number
  removableBytes: number
  removableCount: number
  truncated: boolean
}

/** 会话工作台中必须保留的用户资料。 */
const PRESERVED_ENTRIES = new Set(['.context', 'plan', 'todo.md', 'note.md', 'handoff.md'])

/**
 * 有界计算会话目录总量及可清理量。
 * @param root 会话工作目录；符号链接及其它非普通文件不计入结果。
 * @returns 同一批文件的总量、可清理量和是否触及扫描上限。
 */
export async function measureStorageWorkspace(root: string): Promise<StorageWorkspaceSize> {
  /** 待遍历目录及其内容能否清理；仅根目录的保留项改变该标记。 */
  const directories: Array<{ path: string; removable: boolean; depth: number }> = [
    { path: root, removable: true, depth: 0 },
  ]
  /** 累计结果由单个异步调用持有，不跨扫描轮次缓存。 */
  const result: StorageWorkspaceSize = { bytes: 0, count: 0, removableBytes: 0, removableCount: 0, truncated: false }
  let directoryIndex = 0

  while (directoryIndex < directories.length) {
    if (directoryIndex >= MAX_DIRECTORIES || result.count >= MAX_FILES) {
      result.truncated = true
      break
    }
    const current = directories[directoryIndex++]!
    let entries
    try {
      entries = await fsPromises.readdir(current.path, { withFileTypes: true })
    } catch {
      result.truncated = true
      continue
    }

    /** 文件元数据最多并发读取 16 个，避免大量会话同时扫描时耗尽文件描述符。 */
    const files: Array<{ path: string; removable: boolean }> = []
    for (const entry of entries) {
      const removable = current.removable && (current.depth !== 0 || !PRESERVED_ENTRIES.has(entry.name))
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (directories.length >= MAX_DIRECTORIES) {
          result.truncated = true
          continue
        }
        directories.push({ path: join(current.path, entry.name), removable, depth: current.depth + 1 })
      } else if (entry.isFile()) {
        files.push({ path: join(current.path, entry.name), removable })
      }
    }

    const remaining = MAX_FILES - result.count
    if (files.length > remaining) result.truncated = true
    const selected = files.slice(0, remaining)
    for (let index = 0; index < selected.length; index += STAT_CONCURRENCY) {
      const batch = selected.slice(index, index + STAT_CONCURRENCY)
      const sizes = await Promise.all(batch.map(async (file) => {
        try {
          const stat = await fsPromises.lstat(file.path)
          return stat.isFile() && !stat.isSymbolicLink() ? stat.size : null
        } catch {
          result.truncated = true
          return null
        }
      }))
      sizes.forEach((size, offset) => {
        if (size === null) return
        result.bytes += size
        result.count += 1
        if (batch[offset]!.removable) {
          result.removableBytes += size
          result.removableCount += 1
        }
      })
    }
  }

  return result
}
