/** 有界、可取消的模型下载；保留有效部分文件用于 Range 续传。 */
import { constants } from 'node:fs'
import { open, statfs, unlink } from 'node:fs/promises'
import type { LocalModelCatalogEntry } from '@proma/shared'

/** 下载清单指定文件，返回完成字节数；所有写操作处理 partial write。 */
export async function downloadModelFile(entry: LocalModelCatalogEntry, path: string, signal: AbortSignal, fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, progress: (bytes: number) => void): Promise<void> {
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let discard = false
  try {
    const saved = await file.stat()
    if (!saved.isFile()) throw new Error('模型临时文件类型非法')
    let completed = saved.size
    if (completed > entry.sizeBytes) { await file.truncate(0); completed = 0 }
    const disk = await statfs(path)
    if (disk.bavail * disk.bsize < Math.max(entry.sizeBytes - completed, entry.diskBytes - completed)) throw new Error('磁盘可用空间不足')
    signal.throwIfAborted()
    if (completed === entry.sizeBytes) return
    const response = await fetchImpl(entry.downloadUrl, { signal, redirect: 'follow', headers: completed ? { Range: `bytes=${completed}-` } : {} })
    // HTTP 或续传头非法时也回收响应流，避免代理连接等待未消费的 body。
    reader = response.body?.getReader()
    signal.throwIfAborted()
    if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('模型下载重定向必须使用 HTTPS')
    if (!response.ok || !reader) throw new Error(`模型下载失败（HTTP ${response.status}）`)
    if (response.status === 206) {
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
      if (!range || Number(range[1]) !== completed || Number(range[2]) !== entry.sizeBytes - 1 || Number(range[3]) !== entry.sizeBytes) throw new Error('模型续传 Content-Range 不匹配')
    } else if (response.status === 200) {
      await file.truncate(0); completed = 0
    } else throw new Error('模型下载响应状态非法')
    const length = response.headers.get('content-length')
    if (length !== null && Number(length) !== entry.sizeBytes - completed) throw new Error('模型下载 Content-Length 不匹配')
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      if (completed + chunk.value.byteLength > entry.sizeBytes) { discard = true; throw new Error('模型下载超过清单大小上限') }
      let written = 0
      while (written < chunk.value.byteLength) {
        signal.throwIfAborted()
        const result = await file.write(chunk.value, written, chunk.value.byteLength - written, completed + written)
        if (!result.bytesWritten) throw new Error('模型文件写入无进展')
        written += result.bytesWritten
      }
      completed += written
      progress(completed)
    }
    signal.throwIfAborted()
    if (completed !== entry.sizeBytes) throw new Error('模型下载未完成，可重新下载以续传')
    await file.sync()
  } finally {
    await reader?.cancel().catch(() => undefined)
    await file.close()
    if (discard) await unlink(path).catch(() => undefined)
  }
}
