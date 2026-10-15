import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { resolveBundledLocalModelEngine, LOCAL_MODEL_ENGINE_VERSION } from './local-model-engine'

/** 每个测试使用隔离资源目录，避免触碰应用引擎。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** 模拟准备脚本生成的文件表和固定发行元数据。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-engine-')); roots.push(root)
  const executable = 'payload/rev/llama-server'
  mkdirSync(join(root, 'payload/rev'), { recursive: true })
  writeFileSync(join(root, executable), 'binary', { mode: 0o755 })
  const manifest = { schemaVersion: 1, engine: 'llama.cpp', releaseTag: 'b11429', sourceCommit: 'd81235049384534c167caea52b85a694f6103d14', platform: 'darwin', arch: 'arm64', archiveSha256: '740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459', executable, files: [{ path: executable, sizeBytes: 6, sha256: createHash('sha256').update('binary').digest('hex') }] }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
  return { root, manifest }
}

describe('内置引擎固定资源解析', () => {
  test('Given 固定发行清单和完整文件 When 解析 Then 返回精确引擎版本和受管路径', () => {
    const { root, manifest } = fixture()
    expect(resolveBundledLocalModelEngine(root, 'darwin', 'arm64')).toEqual({ enginePath: join(root, manifest.executable), engineVersion: LOCAL_MODEL_ENGINE_VERSION })
  })
  test('Given 文件被替换或平台不匹配 When 解析 Then 不返回可执行路径', () => {
    const { root, manifest } = fixture()
    expect(resolveBundledLocalModelEngine(root, 'win32', 'x64').enginePath).toBeUndefined()
    writeFileSync(join(root, manifest.executable), 'broken')
    expect(resolveBundledLocalModelEngine(root, 'darwin', 'arm64').enginePath).toBeUndefined()
  })
  test('Given 清单引用越界路径或链接 When 解析 Then 拒绝', () => {
    const { root, manifest } = fixture()
    rmSync(join(root, manifest.executable))
    symlinkSync('/bin/sh', join(root, manifest.executable))
    expect(resolveBundledLocalModelEngine(root, 'darwin', 'arm64').enginePath).toBeUndefined()
    manifest.files[0]!.path = '../outside'
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    expect(resolveBundledLocalModelEngine(root, 'darwin', 'arm64').enginePath).toBeUndefined()
  })
})
