/** 内置引擎定位：只读取发行包资源，不接受 renderer 路径或环境可执行文件覆盖。 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

/** 固定引擎源码与发行版；能力证据绑定这一精确版本。 */
export const LOCAL_MODEL_ENGINE_VERSION = 'b11429@d81235049384534c167caea52b85a694f6103d14'
/** 从官方 GitHub Release digest 锁定四个平台归档。 */
const ARCHIVE_HASHES: Record<string, string> = {
  'darwin-arm64': '740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459',
  'darwin-x64': '29ac3ea02be6bd143e824973f2cc5fa74bc4094393a9eaab0ff6814f19dd8522',
  'linux-x64': 'f6d25dde8f51133143d1453da4fd5f73b145127177612a283bf7995957af3392',
  'win32-x64': '1283323272b04cd07905816a597a0da810918102de958f4ff6f7bbaa70ed2efe',
}
/** 返回已验证的路径或可展示的安装问题，不泄漏内部路径。 */
export interface BundledLocalModelEngine { enginePath?: string; engineVersion?: string; message?: string }

/** 读取构建准备脚本的原子 manifest 并验证整个动态库闭包；每次应用启动只执行一次。 */
export function resolveBundledLocalModelEngine(root: string, platform: string = process.platform, arch: string = process.arch): BundledLocalModelEngine {
  try {
    const expected = ARCHIVE_HASHES[`${platform}-${arch}`]
    if (!expected) return { message: '当前平台暂不支持 DutyDeck 内置本地引擎' }
    const manifestPath = join(root, 'manifest.json')
    if (lstatSync(manifestPath).isSymbolicLink()) throw new Error('manifest link')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    if (manifest.schemaVersion !== 1 || manifest.engine !== 'llama.cpp' || manifest.releaseTag !== 'b11429'
      || manifest.sourceCommit !== 'd81235049384534c167caea52b85a694f6103d14'
      || manifest.platform !== platform || manifest.arch !== arch || manifest.archiveSha256 !== expected
      || typeof manifest.executable !== 'string' || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 200) throw new Error('manifest mismatch')
    const realRoot = realpathSync(root)
    const paths = new Set<string>()
    for (const raw of manifest.files) {
      if (!raw || typeof raw !== 'object') throw new Error('file invalid')
      const file = raw as Record<string, unknown>
      if (typeof file.path !== 'string' || isAbsolute(file.path) || file.path.split(/[\\/]/).some((part) => part === '..' || part === '.')
        || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256) || typeof file.sizeBytes !== 'number' || file.sizeBytes < 1 || file.sizeBytes > 250 * 1024 * 1024) throw new Error('file invalid')
      const path = join(root, file.path)
      const info = lstatSync(path)
      const inside = relative(realRoot, realpathSync(path))
      if (!info.isFile() || info.isSymbolicLink() || inside.startsWith('..') || isAbsolute(inside) || info.size !== file.sizeBytes) throw new Error('file outside')
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256) throw new Error('file checksum')
      paths.add(file.path)
    }
    if (!paths.has(manifest.executable)) throw new Error('executable missing')
    return { enginePath: join(root, manifest.executable), engineVersion: LOCAL_MODEL_ENGINE_VERSION }
  } catch {
    return { message: '本地运行环境尚未安装或资源校验失败，请到设置页安装 llama.cpp' }
  }
}
