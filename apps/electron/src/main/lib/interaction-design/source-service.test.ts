import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { InteractionSourceService } from './source-service'

/** 测试独立目录，不读取或修改真实用户源码。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('交互设计移动端页面来源', () => {
  it('Given iOS Android Flutter 页面 When 扫描并读取 Then 返回源码线索且仍排除敏感和构建产物', async () => {
    /** 隔离的混合端项目根。 */
    const root = mkdtempSync(join(tmpdir(), 'interaction-source-'))
    roots.push(root)
    /** 合法页面源码及应跳过的同扩展名文件。 */
    const paths = ['ios/HomeView.swift', 'android/HomeScreen.kt', 'android/routes.kts', 'flutter/home_page.dart']
    const excluded = ['build/Generated.swift', 'ios/secret.swift', '.private/Screen.kt', 'dist/home_page.dart']
    for (const path of [...paths, ...excluded]) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), '// 页面源码示例')
    }
    /** 受控扫描与按需读取使用同一来源规则。 */
    const service = new InteractionSourceService(root)
    const inspection = service.inspect()
    expect(inspection.files.map(file => file.path).sort()).toEqual([...paths].sort())
    expect(inspection.files.every(file => file.kind === 'code')).toBe(true)
    expect(inspection.truncated).toBe(false)
    expect(inspection.frameworks).not.toContain('SwiftUI')
    expect((await service.read(paths)).map(file => file.path)).toEqual(paths)
    for (const path of excluded) await expect(service.read([path])).rejects.toThrow('敏感或排除目录')
  })
  it('Given 超过扫描深度的原生页面 When 扫描 Then 标记截断且不无界遍历', () => {
    /** 深目录验证既有预算仍适用于新扩展名。 */
    const root = mkdtempSync(join(tmpdir(), 'interaction-source-'))
    roots.push(root)
    const directory = join(root, 'a/b/c/d/e/f/g/h')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'DeepScreen.swift'), '// 页面源码')
    const inspection = new InteractionSourceService(root).inspect()
    expect(inspection.files).toHaveLength(0)
    expect(inspection.truncated).toBe(true)
  })
})
