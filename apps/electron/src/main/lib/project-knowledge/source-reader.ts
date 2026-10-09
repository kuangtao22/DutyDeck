import { createHash } from 'node:crypto'
import { constants, lstatSync } from 'node:fs'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'

/** 单文件扫描最多提取的字节数。 */
export const MAX_INDEXED_FILE_BYTES = 256 * 1024
/** 单次正文读取最多返回的 UTF-8 字节数。 */
export const MAX_READ_PAGE_BYTES = 24 * 1024

/** 安全读取后的有界文本快照。 */
export interface SafeTextSnapshot {
  text: string
  byteSize: number
  indexedBytes: number
  truncated: boolean
  revision: string
}

/** 文件 stat 中用于防止读取期间置换的身份。 */
function sameFileState(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink
}

/** 拒绝软链接、非普通文件和多硬链接。 */
function assertSafeFileStat(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('来源不是安全的普通文件')
  if (stat.nlink !== 1) throw new Error('来源存在多个硬链接')
}

/** 从 stat 与有界正文构造可复核来源版本。 */
function createTextRevision(stat: Stats, bytes: Buffer): string {
  /** 可由检索快速复核的文件身份摘要。 */
  const metadataRevision = createMetadataRevision(stat)
  /** 扫描提取正文的内容摘要。 */
  const contentRevision = createHash('sha256').update(bytes).digest('hex')
  return `${metadataRevision}:${contentRevision}`
}

/** 从 stat 构造不读取二进制正文的元数据版本。 */
export function createMetadataRevision(stat: Stats): string {
  return createHash('sha256')
    .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`)
    .digest('hex')
}

/** 以 no-follow 打开来源并绑定读取前身份。 */
async function openSafeFile(filePath: string): Promise<{ handle: FileHandle; before: Stats }> {
  /** 打开前的路径对象身份。 */
  const before = lstatSync(filePath)
  assertSafeFileStat(before)
  /** 在支持的平台拒绝最终路径软链接。 */
  const noFollow = constants.O_NOFOLLOW ?? 0
  /** 只读文件句柄。 */
  const handle = await open(filePath, constants.O_RDONLY | noFollow)
  try {
    /** 打开后的文件描述符身份。 */
    const opened = await handle.stat()
    assertSafeFileStat(opened)
    if (!sameFileState(before, opened)) throw new Error('来源在打开前已变化')
    return { handle, before: opened }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** 确认读取后文件身份未变化。 */
async function assertUnchanged(handle: FileHandle, before: Stats): Promise<void> {
  /** 读取结束时的文件描述符状态。 */
  const after = await handle.stat()
  if (!sameFileState(before, after)) throw new Error('来源在读取期间已变化')
}

/** 在 UTF-8 字符边界裁剪页尾。 */
function trimToUtf8Boundary(bytes: Buffer): Buffer {
  /** 最多回退一个 UTF-8 字符的候选长度。 */
  for (let length = bytes.length; length >= Math.max(0, bytes.length - 4); length -= 1) {
    /** 当前候选字节。 */
    const candidate = bytes.subarray(0, length)
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(candidate)
      return candidate
    } catch {
      // 继续回退到完整字符边界。
    }
  }
  throw new Error('来源不是有效 UTF-8 文本')
}

/** 有界读取文本来源，并在打开前后复核身份。 */
export async function readSafeTextSnapshot(filePath: string): Promise<SafeTextSnapshot> {
  /** 已绑定身份的文件句柄。 */
  const { handle, before } = await openSafeFile(filePath)
  try {
    /** 只按预算分配的读取缓冲。 */
    const buffer = Buffer.allocUnsafe(Math.min(before.size, MAX_INDEXED_FILE_BYTES))
    /** 实际读取结果。 */
    const result = await handle.read(buffer, 0, buffer.length, 0)
    /** 本轮实际取得的字节。 */
    const bytes = buffer.subarray(0, result.bytesRead)
    if (bytes.includes(0)) throw new Error('来源疑似二进制文件')
    /** 严格 UTF-8 解码后的有界正文。 */
    const text = new TextDecoder('utf-8', { fatal: true }).decode(trimToUtf8Boundary(bytes))
    await assertUnchanged(handle, before)
    return {
      text,
      byteSize: before.size,
      indexedBytes: Buffer.byteLength(text, 'utf8'),
      truncated: before.size > Buffer.byteLength(text, 'utf8'),
      revision: createTextRevision(before, bytes),
    }
  } finally {
    await handle.close()
  }
}

/** 只读取文件元数据，不打开二进制正文。 */
export function readSafeMetadataRevision(filePath: string): { byteSize: number; revision: string } {
  /** no-follow 读取的路径对象状态。 */
  const stat = lstatSync(filePath)
  assertSafeFileStat(stat)
  return { byteSize: stat.size, revision: createMetadataRevision(stat) }
}

/** 复核文本来源当前版本，不返回正文。 */
export async function verifySafeTextRevision(filePath: string): Promise<string> {
  return (await readSafeTextSnapshot(filePath)).revision
}

/** 只用 no-follow stat 快速复核缓存对应的来源身份，不读取正文。 */
export function verifySafeSourceIdentity(filePath: string, expectedRevision: string): boolean {
  /** 文本 revision 的首段是扫描时 stat 身份摘要。 */
  const expectedMetadataRevision = expectedRevision.split(':', 1)[0]
  return readSafeMetadataRevision(filePath).revision === expectedMetadataRevision
}

/** 从来源按 UTF-8 字节偏移读取一页，并同时复核扫描版本。 */
export async function readSafeTextPage(
  filePath: string,
  offset: number,
): Promise<{ content: string; nextOffset?: number; revision: string; byteSize: number }> {
  /** 已绑定身份的文件句柄。 */
  const { handle, before } = await openSafeFile(filePath)
  try {
    if (offset > before.size) throw new Error('正文偏移超出范围')
    if (offset > 0 && offset < before.size) {
      /** 用于验证起始位置不是 UTF-8 continuation byte 的单字节缓冲。 */
      const boundaryByte = Buffer.allocUnsafe(1)
      await handle.read(boundaryByte, 0, 1, offset)
      const firstByte = boundaryByte[0]
      if (firstByte === undefined || (firstByte & 0xc0) === 0x80) throw new Error('正文偏移不在 UTF-8 字符边界')
    }
    /** 复核 revision 使用的扫描预算缓冲。 */
    const revisionBuffer = Buffer.allocUnsafe(Math.min(before.size, MAX_INDEXED_FILE_BYTES))
    /** 来源开头的实际读取结果。 */
    const revisionRead = await handle.read(revisionBuffer, 0, revisionBuffer.length, 0)
    /** 当前页最多多读 4 字节，便于回退到字符边界。 */
    const pageBuffer = Buffer.allocUnsafe(Math.min(MAX_READ_PAGE_BYTES + 4, Math.max(0, before.size - offset)))
    /** 当前页的实际读取结果。 */
    const pageRead = await handle.read(pageBuffer, 0, pageBuffer.length, offset)
    /** 严格 UTF-8 页字节。 */
    const pageBytes = trimToUtf8Boundary(pageBuffer.subarray(0, Math.min(pageRead.bytesRead, MAX_READ_PAGE_BYTES)))
    /** 当前页正文。 */
    const content = new TextDecoder('utf-8', { fatal: true }).decode(pageBytes)
    await assertUnchanged(handle, before)
    /** 下一页的安全字节偏移。 */
    const nextOffset = offset + pageBytes.length < before.size ? offset + pageBytes.length : undefined
    return {
      content,
      nextOffset,
      revision: createTextRevision(before, revisionBuffer.subarray(0, revisionRead.bytesRead)),
      byteSize: before.size,
    }
  } finally {
    await handle.close()
  }
}
