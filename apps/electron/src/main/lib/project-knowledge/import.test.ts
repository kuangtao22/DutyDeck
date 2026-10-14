import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, truncate, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importKnowledgeSources } from './import'
import { createProjectKnowledgeService } from './service'

/** 各测试独占的临时根，结束后只清理自身资料。 */
const roots: string[] = []
/** 建立独立项目和待导入旧库。 */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-import-')))
  roots.push(root)
  const projectRoot = join(root, 'project')
  const source = join(root, 'old')
  await mkdir(projectRoot); await mkdir(source)
  return { root, projectRoot, source, assertCurrent: () => {} }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('旧知识库保真导入', () => {
  it('Given 旧库已导入且残留未发布暂存 When 扫描 Then 只登记发布正文和附件且可读', async () => {
    /** 保留 Markdown 与图片的真实导入包，并模拟中断后未发布的暂存目录。 */
    const f = await fixture()
    await writeFile(join(f.source, 'guide.md'), '# 原始正文\n![图](a.png)\n')
    await writeFile(join(f.source, 'a.png'), Buffer.from([0, 1, 255]))
    const imported = await importKnowledgeSources({ ...f, paths: [f.source] })
    const staging = join(f.projectRoot, imported.rootRelativePath, 'partial', '.staging-interrupted')
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'unfinished.md'), '尚未发布的内容')
    /** 使用生产扫描与读取链路，防止导入只复制成功但 Agent 无法访问来源。 */
    const service = createProjectKnowledgeService({ resolveProject: () => ({ projectId: 'p1', projectRoot: f.projectRoot,
      memoryRoot: join(f.root, 'memory'), cacheRoot: join(f.root, 'cache') }) })
    await service.startScan('p1')
    await service.waitForScan('p1')
    const sources = await service.search({ workspaceId: 'p1', query: '', scope: 'sources' })
    expect(sources.items).toHaveLength(2)
    expect(sources.items.map(({ entry }) => entry.source.relativePath).sort()).toEqual(imported.files.map(file => file.relativePath).sort())
    const document = sources.items.find(({ entry }) => entry.source.relativePath?.endsWith('guide.md'))!.entry
    expect((await service.read({ workspaceId: 'p1', entryId: document.id })).content).toBe('# 原始正文\n![图](a.png)\n')
  })

  it('Given 正文与附件 When 导入及重复导入 Then 保留字节和相对目录且幂等', async () => {
    const f = await fixture()
    await mkdir(join(f.source, 'images'))
    await writeFile(join(f.source, 'guide.md'), '# 正文\n![图](images/a.png)\n')
    await writeFile(join(f.source, 'images/a.png'), Buffer.from([0, 1, 255]))
    const first = await importKnowledgeSources({ ...f, paths: [f.source] })
    expect(first.imported).toBe(2)
    const doc = first.files.find(file => file.kind === 'document')!
    expect(await readFile(join(f.projectRoot, doc.relativePath), 'utf8')).toBe('# 正文\n![图](images/a.png)\n')
    const second = await importKnowledgeSources({ ...f, paths: [f.source] })
    expect(second.imported).toBe(0); expect(second.unchanged).toBe(2)
    expect(second.files).toEqual(first.files)
  })
  it('Given 原文变化或包被人工修改 Then 新建版本而不覆盖', async () => {
    const f = await fixture(); await writeFile(join(f.source, 'a.md'), '旧正文')
    const first = await importKnowledgeSources({ ...f, paths: [f.source] })
    await writeFile(join(f.projectRoot, first.files[0]!.relativePath), '人工正文')
    const second = await importKnowledgeSources({ ...f, paths: [f.source] })
    expect(second.imported).toBe(1)
    await writeFile(join(f.source, 'a.md'), '新正文')
    const third = await importKnowledgeSources({ ...f, paths: [f.source] })
    expect(third.files[0]!.relativePath).not.toBe(second.files[0]!.relativePath)
    expect(await readFile(join(f.projectRoot, first.files[0]!.relativePath), 'utf8')).toBe('人工正文')
  })
  it('Given 单文件链接 Then 只复制显式授权目录内依赖，不扫其他文件', async () => {
    const f = await fixture(); await mkdir(join(f.source, 'assets'))
    await writeFile(join(f.source, 'a.md'), '![图](assets/a.png)\n[x](../outside.md)')
    await writeFile(join(f.source, 'assets/a.png'), 'image')
    await writeFile(join(f.source, 'unrelated.md'), '无关')
    const result = await importKnowledgeSources({ ...f, paths: [join(f.source, 'a.md')] })
    expect(result.imported).toBe(2)
    expect(result.skipped.some(item => item.reason.includes('越界'))).toBe(true)
  })
  it('Given 隐藏凭据、符号链接、不支持文件、超限文件 Then 跳过并报告', async () => {
    const f = await fixture()
    await writeFile(join(f.source, 'a.md'), '正常')
    await writeFile(join(f.source, '.env'), 'secret')
    await writeFile(join(f.source, 'secret.json'), '{"api_key":"abcdefghijklmnop"}')
    await writeFile(join(f.source, 'app.exe'), 'exe')
    await symlink(join(f.source, 'a.md'), join(f.source, 'link.md'))
    await writeFile(join(f.source, 'huge.pdf'), ''); await truncate(join(f.source, 'huge.pdf'), 33 * 1024 * 1024)
    const result = await importKnowledgeSources({ ...f, paths: [f.source] })
    expect(result.imported).toBe(1); expect(result.skipped.length).toBe(5)
  })
  it('Given 选择项目祖先 Then 不会递归导入自己的输出', async () => {
    const f = await fixture(); await writeFile(join(f.source, 'a.md'), '正文')
    const result = await importKnowledgeSources({ ...f, paths: [f.root] })
    expect(result.imported).toBe(0); expect(result.skipped[0]!.reason).toContain('导入目录')
  })
  it('Given 授权失效 Then 拒绝发布', async () => {
    const f = await fixture(); await writeFile(join(f.source, 'a.md'), '正文')
    await expect(importKnowledgeSources({ ...f, paths: [f.source], assertCurrent: () => { throw new Error('授权失效') } })).rejects.toThrow('授权失效')
  })
})
