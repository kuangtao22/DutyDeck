import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('DefaultRootMigrationPrompt', () => {
  test('使用项目 Dialog 样式展示路径和两个迁移选择', () => {
    /** Radix Portal 在无 DOM 的 SSR 测试环境不会输出内容，读取源码锁定交互合同。 */
    const source = readFileSync(join(import.meta.dir, 'DefaultRootMigrationPrompt.tsx'), 'utf8')

    expect(source).toContain('<DialogContent')
    expect(source).toContain('继续使用旧目录')
    expect(source).toContain('移动到新目录')
    expect(source).toContain('<PathRow label="当前目录" path={display.legacyRoot} />')
    expect(source).toContain('<PathRow label="新目录" path={display.targetRoot} />')
  })
})
