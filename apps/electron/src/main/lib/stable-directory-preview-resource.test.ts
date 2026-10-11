import { beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runStableDirectoryNative } from './stable-directory-native-host'

/** 实测使用当前源码编译的 helper。 */
const appDir = resolve(import.meta.dir, '../../..')
/** 当前平台原生可执行文件。 */
const helperPath = resolve(appDir, `resources/stable-directory/stable-directory-helper${process.platform === 'win32' ? '.exe' : ''}`)
beforeAll(() => {
  execFileSync(process.execPath, [resolve(appDir, 'scripts/build-stable-directory-native.ts')], { stdio: 'inherit' })
}, 150_000)

/** 输入根目录及相对路径，返回受授权的二进制读取结果。 */
const read = (root: string, resourcePath: string, maxFileBytes = 1024) => runStableDirectoryNative(
  { mode: 'preview-resource-read', roots: [root], resourcePath, maxFileBytes },
  () => true, { helperPath: () => helperPath },
)

describe('原生 HTML 资源读取', () => {
  test('Given 中文空格子目录和二进制 When 按需读取 Then 字节无损且缺失明确返回', async () => {
    const root = mkdtempSync(join(tmpdir(), 'preview-resource-'))
    try {
      mkdirSync(join(root, '中文 空格'))
      const bytes = Buffer.from([0, 255, 128, 34, 10])
      writeFileSync(join(root, '中文 空格', '图片.bin'), bytes)
      expect((await read(root, '中文 空格/图片.bin')).resourceReadOutcome).toEqual({ status: 'ok', contentBase64: bytes.toString('base64'), size: bytes.length })
      writeFileSync(join(root, 'empty'), '')
      expect((await read(root, 'empty')).resourceReadOutcome).toEqual({ status: 'ok', contentBase64: '', size: 0 })
      expect((await read(root, 'missing')).resourceReadOutcome).toEqual({ status: 'missing' })
      expect((await read(root, '中文 空格/图片.bin', 4)).resourceReadOutcome?.status).toBe('rejected')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('Given 链接、越界及特殊文件 When 读取 Then 拒绝并且不会阻塞', async () => {
    const root = mkdtempSync(join(tmpdir(), 'preview-unsafe-'))
    try {
      mkdirSync(join(root, 'real'))
      writeFileSync(join(root, 'real', 'file'), 'secret')
      symlinkSync(join(root, 'real'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
      expect((await read(root, 'link/file')).resourceReadOutcome?.status).toBe('rejected')
      if (process.platform !== 'win32') {
        symlinkSync(join(root, 'real/file'), join(root, 'leaf'))
        expect((await read(root, 'leaf')).resourceReadOutcome?.status).toBe('rejected')
        execFileSync('mkfifo', [join(root, 'fifo')])
        expect((await read(root, 'fifo')).resourceReadOutcome?.status).toBe('rejected')
        await expect(read(join(root, 'fifo'), 'file')).rejects.toThrow()
      }
      for (const path of ['../file', '/file', 'x\\file', 'x//file', 'x/./file', 'x/../file', 'x:stream']) {
        await expect(read(root, path)).rejects.toThrow()
      }
      expect((await read(root, 'real')).resourceReadOutcome?.status).toBe('rejected')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('Given 20 MiB 边界资源 When 读取 Then Base64 输出预算足够且更大预算被拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'preview-limit-'))
    try {
      const bytes = Buffer.alloc(20 * 1024 * 1024, 255)
      writeFileSync(join(root, 'large'), bytes)
      const outcome = (await read(root, 'large', bytes.length)).resourceReadOutcome
      expect(outcome?.status).toBe('ok')
      if (outcome?.status === 'ok') expect(Buffer.from(outcome.contentBase64, 'base64').equals(bytes)).toBe(true)
      await expect(read(root, 'large', bytes.length + 1)).rejects.toThrow()
      await expect(read(root, 'large', 0)).rejects.toThrow()
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 20_000)
  test('Given 根在授权后被替换 When 读取 Then 保持原根句柄且后续身份授权可拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'preview-race-'))
    const active = join(root, 'active')
    try {
      mkdirSync(active)
      writeFileSync(join(active, 'file'), 'original')
      const result = await runStableDirectoryNative({ mode: 'preview-resource-read', roots: [active], resourcePath: 'file', maxFileBytes: 1024 }, () => {
        renameSync(active, join(root, 'old'))
        mkdirSync(active)
        writeFileSync(join(active, 'file'), 'replacement')
        return true
      }, { helperPath: () => helperPath })
      expect(result.resourceReadOutcome).toEqual({ status: 'ok', contentBase64: Buffer.from('original').toString('base64'), size: 8 })
      await expect(runStableDirectoryNative({ mode: 'preview-resource-read', roots: [active], resourcePath: 'file', maxFileBytes: 1024 }, (roots) => roots[0]?.fileId === result.roots[0]?.fileId, { helperPath: () => helperPath })).rejects.toThrow('授权被拒绝')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
