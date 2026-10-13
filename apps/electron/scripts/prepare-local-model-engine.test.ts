import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { ENGINE_ASSETS, installEngine, unpackEngine, validateArchivePath, verifyArchive, refreshSignedManifest } from './prepare-local-model-engine'
import type { EngineAsset } from './prepare-local-model-engine'

/** 创建包含 server 与 DLL 的小型 ZIP 和精确资产校验值，避免测试网络依赖。 */
function fixture() {
  const zip = new AdmZip()
  zip.addFile('build/bin/llama-server.exe', Buffer.from('server'))
  zip.addFile('build/bin/ggml.dll', Buffer.from('library'))
  zip.addFile('build/bin/llama-cli.exe', Buffer.from('unneeded'))
  const data = zip.toBuffer()
  const asset: EngineAsset = { name: 'engine.zip', target: 'win32-x64', size: data.length, digest: `sha256:${createHash('sha256').update(data).digest('hex')}`, browser_download_url: 'https://github.com/test' }
  return { data, asset }
}

describe('Given 固定引擎资产准备', () => {
  test('When 归档合法 Then 仅发布 server 与动态库并原子写清单', async () => {
    const { data, asset } = fixture()
    const root = await mkdtemp(join(tmpdir(), 'engine-test-'))
    try {
      const manifest = await installEngine(data, asset, root)
      expect(manifest.platform).toBe('win32')
      expect(manifest.files).toHaveLength(2)
      expect(await readFile(join(root, manifest.executable), 'utf8')).toBe('server')
      expect(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))).toEqual(manifest)
      expect((await stat(join(root, manifest.executable))).mode & 0o111).toBe(0o111)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('When 下载损坏 Then 拒绝大小或摘要错误', () => {
    const { data, asset } = fixture()
    expect(() => verifyArchive(data.subarray(1), asset)).toThrow('大小不匹配')
    expect(() => verifyArchive(Buffer.alloc(data.length), asset)).toThrow('SHA-256')
  })
  test('When 更新校验失败 Then 已发布清单和引擎保持不变', async () => {
    const { data, asset } = fixture()
    const root = await mkdtemp(join(tmpdir(), 'engine-test-'))
    try {
      const manifest = await installEngine(data, asset, root)
      await expect(installEngine(Buffer.alloc(data.length), asset, root)).rejects.toThrow('SHA-256')
      expect(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))).toEqual(manifest)
      expect(await readFile(join(root, manifest.executable), 'utf8')).toBe('server')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('When 条目尝试跨目录或使用 Windows 特殊路径 Then 拒绝', () => {
    for (const path of ['../outside', '/tmp/escape', 'folder/../escape', 'C:/escape', 'a\\b', 'x\nfile']) expect(() => validateArchivePath(path)).toThrow()
    expect(validateArchivePath('./build/bin/server')).toBe('build/bin/server')
  })
  test('When 归档缺少 server Then 不发布其他二进制', () => {
    const { data, asset } = fixture()
    expect(() => unpackEngine(data, { ...asset, target: 'linux-x64' })).toThrow('缺少 llama-server')
  })
  test('Then 只声明四个已固定 SHA-256 的受支持目标', () => {
    expect(ENGINE_ASSETS.map((asset) => asset.target)).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'])
    for (const asset of ENGINE_ASSETS) expect(asset.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })
})

/** 构造标准 USTAR 测试条目，覆盖真实 Unix 包格式与链接安全。 */
function tarFixture(names: Array<{ name: string; data?: string; target?: string }>) {
  const blocks: Buffer[] = []
  for (const entry of names) {
    const header = Buffer.alloc(512)
    const data = Buffer.from(entry.data ?? '')
    header.write(entry.name, 0)
    header.write('0000755\0', 100)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('        ', 148)
    header.write(entry.target ? '2' : '0', 156)
    if (entry.target) header.write(entry.target, 157)
    header.write('ustar\0', 257)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  const data = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
  const asset: EngineAsset = { name: 'engine.tar.gz', target: 'darwin-arm64', size: data.length, digest: `sha256:${createHash('sha256').update(data).digest('hex')}`, browser_download_url: 'https://github.com/test' }
  return { data, asset }
}
import { gzipSync } from 'node:zlib'

test('Given Unix tar When 普通库与同目录链接 Then 解析成普通文件并保留执行权限', () => {
  const { data, asset } = tarFixture([{ name: 'build/bin/llama-server', data: 'server' }, { name: 'build/bin/libggml.1.dylib', data: 'lib' }, { name: 'build/bin/libggml.dylib', target: 'libggml.1.dylib' }])
  const entries = unpackEngine(data, asset)
  expect(entries.map((entry) => entry.name)).toEqual(['build/bin/llama-server', 'build/bin/libggml.1.dylib', 'build/bin/libggml.dylib'])
  expect(entries[2]!.data!.toString()).toBe('lib')
  expect(entries[0]!.mode).toBe(0o755)
})
test('Given Unix tar When 路径或链接越界 Then 解包前拒绝', () => {
  for (const entry of [{ name: '../llama-server', data: 'evil' }, { name: 'llama-server', target: '../evil' }]) {
    const { data, asset } = tarFixture([entry])
    expect(() => unpackEngine(data, asset)).toThrow('越界')
  }
})
test('Given Unix tar When 链接循环或重复条目 Then 拒绝', () => {
  for (const entries of [[{ name: 'llama-server', target: 'llama-server' }], [{ name: 'llama-server', data: 'a' }, { name: 'llama-server', data: 'b' }]]) {
    const { data, asset } = tarFixture(entries)
    expect(() => unpackEngine(data, asset)).toThrow()
  }
})


test('Given 子二进制已签名 When 刷新清单 Then 摘要和大小匹配签名后的实际字节', async () => {
  const { data, asset } = fixture()
  const root = await mkdtemp(join(tmpdir(), 'engine-sign-test-'))
  try {
    const manifest = await installEngine(data, asset, root)
    await writeFile(join(root, manifest.executable), 'signed-server')
    await refreshSignedManifest(root)
    const signed = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
    const executable = signed.files.find((file: { path: string }) => file.path === manifest.executable)
    expect(executable.sizeBytes).toBe(13)
    expect(executable.sha256).toBe(createHash('sha256').update('signed-server').digest('hex'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('Given macOS 签名顺序 When 处理子文件和外层 app Then 仅封签 app 前刷新且保留签名选项', () => {
  const { wrapSignOptions } = require('./sign-local-model-engine.cjs')
  const events: string[] = []
  const options = wrapSignOptions({ app: '/tmp/DutyDeck.app', identity: 'certificate', optionsForFile: (path: string) => { events.push(path); return { hardenedRuntime: true } } }, () => events.push('refresh'))
  expect(options.optionsForFile('/tmp/DutyDeck.app/Contents/Resources/local-model-engine/llama-server')).toEqual({ hardenedRuntime: true })
  expect(events).toHaveLength(1)
  options.optionsForFile('/tmp/DutyDeck.app')
  expect(events.slice(-2)).toEqual(['refresh', '/tmp/DutyDeck.app'])
  expect(options.identity).toBe('certificate')
})
