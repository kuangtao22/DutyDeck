import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProjectKnowledgeService } from './project-knowledge/service'
import { previewKnowledgeMemory } from './project-knowledge-memory-preview'

/** 每个预览测试使用实际文件与扫描索引。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test('Given 混合主题旧记忆 When 预览整理 Then 展示章节与版本且不修改原文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-preview-')); roots.push(root)
  const memoryRoot = join(root, 'memory'); mkdirSync(memoryRoot)
  const path = join(memoryRoot, 'notes.md')
  const content = '# 记忆\n## 产品定位\n个人项目\n## 技术决定\nBun\n## 使用习惯\n中文\n'
  writeFileSync(path, content)
  const service = createProjectKnowledgeService({ resolveProject: () => ({ projectId: 'w1', projectRoot: root, memoryRoot, cacheRoot: join(root, 'cache') }) })
  await service.startScan('w1'); await service.waitForScan('w1')
  const preview = await previewKnowledgeMemory('w1', service)
  expect(preview.proposals[0]?.sections).toEqual(['产品定位', '技术决定', '使用习惯'])
  expect(preview.proposals[0]?.revision).toBeTruthy()
  expect(readFileSync(path, 'utf8')).toBe(content)
})
