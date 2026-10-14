import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ensureDirectoryDurable } from '../safe-file'

/** 校验单级持久身份，禁止路径片段。 */
export function assertInteractionId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('交互设计身份非法')
}
/** 在明确项目根下逐级校验实际目录，可选创建缺失目录。 */
export function interactionDirectory(root: string, parts: string[], create = false): string {
  if (!isAbsolute(root)) throw new Error('项目根必须为绝对路径')
  /** 当前已校验的目录。 */
  let current = root
  for (const part of ['', ...parts]) {
    if (part) { assertInteractionId(part === '.proma' ? 'proma' : part); current = join(current, part) }
    try {
      /** 当前目录实际身份。 */
      const state = lstatSync(current)
      if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('交互设计目录不安全')
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      ensureDirectoryDurable(current)
    }
  }
  return current
}
/** 来源路径必须在项目内，且每级目录和最终文件均非链接。 */
export function interactionSourcePath(root: string, value: string): string {
  /** 标准化后的相对路径。 */
  const parts = value.replaceAll('\\', '/').split('/')
  if (!value || isAbsolute(value) || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0') || part.includes(':'))) throw new Error('来源路径越界')
  /** 用于逐级校验的目录。 */
  let current = root
  for (const part of ['', ...parts.slice(0, -1)]) {
    if (part) current = join(current, part)
    if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw new Error('来源目录不安全')
  }
  /** 项目内的最终位置。 */
  const result = resolve(root, ...parts)
  if (relative(root, result).startsWith('..')) throw new Error('来源路径越界')
  return result
}
/** 有界 no-follow 读取普通文件，读取前后核对同一文件身份。 */
export function readInteractionFile(path: string, maxBytes: number): Buffer {
  /** 打开前元数据。 */
  const before = lstatSync(path)
  if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error('文件类型或读取预算不允许')
  /** 固定文件句柄。 */
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    /** 打开后实际元数据。 */
    const opened = fstatSync(descriptor)
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('文件身份变化')
    /** 读取的完整有界正文。 */
    const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1))
    /** 读取到 EOF 或预算上限，文件增长不能触发无界分配。 */
    let length = 0
    while (length < buffer.length) {
      /** 当前读取的字节数。 */
      const count = readSync(descriptor, buffer, length, buffer.length - length, length)
      if (count === 0) break
      length += count
    }
    /** 实际取得的文件内容。 */
    const bytes = buffer.subarray(0, length)
    /** 读取结束后的元数据。 */
    const after = fstatSync(descriptor)
    if (bytes.length > maxBytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('文件在读取期间变化')
    return bytes
  } finally { closeSync(descriptor) }
}
