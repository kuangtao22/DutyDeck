import { describe, expect, test } from 'bun:test'
import type { KnowledgeEntry } from '@proma/shared'
import {
  buildSourceDistillationPrompt,
  createSourceDistillationBatches,
  isSourceDistillationCandidate,
  parseSourceDistillationCandidates,
} from './project-knowledge-source-distillation'

/** 构造扫描来源条目，测试只改变与筛选有关的字段。 */
function sourceEntry(relativePath: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: relativePath.padEnd(32, '0').slice(0, 32).replace(/[^a-f0-9]/g, 'a'),
    revision: `entry-${relativePath}`,
    title: relativePath,
    category: 'engineering',
    kind: 'document',
    state: 'confirmed',
    freshness: 'current',
    summary: relativePath,
    source: { kind: 'project-file', id: `project-file:${relativePath}`, relativePath, revision: `source-${relativePath}` },
    byteSize: 100,
    indexedBytes: 100,
    truncated: false,
    metadataOnly: false,
    updatedAt: 1,
    ...overrides,
  }
}

describe('项目文件知识提炼', () => {
  test('Given 项目文档与代码测试混合 When 选择提炼来源 Then 只保留高价值文档和受控文本', () => {
    expect(isSourceDistillationCandidate(sourceEntry('README.md'))).toBe(true)
    expect(isSourceDistillationCandidate(sourceEntry('AGENTS.md', { state: 'indexed' }))).toBe(true)
    expect(isSourceDistillationCandidate(sourceEntry('README', { source: { kind: 'project-file', id: 'readme', relativePath: 'README', revision: 'r' } }))).toBe(true)
    expect(isSourceDistillationCandidate(sourceEntry('docs/product-plan.mdx'))).toBe(true)
    expect(isSourceDistillationCandidate(sourceEntry('docs/product-spec.md'))).toBe(true)
    expect(isSourceDistillationCandidate(sourceEntry('docs/api-spec.md'))).toBe(true)
    expect(isSourceDistillationCandidate(sourceEntry('src/core.ts'))).toBe(false)
    expect(isSourceDistillationCandidate(sourceEntry('web/.test/project-integrity.mjs'))).toBe(false)
    expect(isSourceDistillationCandidate(sourceEntry('dist/README.md'))).toBe(false)
    expect(isSourceDistillationCandidate(sourceEntry('canvas', {
      source: { kind: 'canvas', id: 'canvas:1', revision: 'canvas-revision' },
      category: 'design',
    }))).toBe(true)
  })

  test('Given 同分类多份文档 When 规划提炼 Then 小批组合且来源版本身份稳定', () => {
    const batches = createSourceDistillationBatches([
      sourceEntry('docs/a.md'),
      sourceEntry('docs/b.md'),
      sourceEntry('docs/c.md'),
      sourceEntry('guide.txt', { category: 'guides' }),
    ], { maxSources: 2 })
    expect(batches).toHaveLength(3)
    expect(batches[0]?.refs).toHaveLength(2)
    expect(batches[0]?.refs.every((ref) => ref.category === 'engineering')).toBe(true)
    expect(new Set(batches.flatMap((batch) => batch.sourceIdentities)).size).toBe(4)
    const byteLimited = createSourceDistillationBatches([
      sourceEntry('docs/large-a.md', { indexedBytes: 100 }),
      sourceEntry('docs/large-b.md', { indexedBytes: 100 }),
    ], { maxSources: 4, maxInputBytes: 150 })
    expect(byteLimited).toHaveLength(2)
  })

  test('Given 多来源正文 When 模型返回逐字引用 Then 生成跨来源候选', () => {
    const refs = [sourceEntry('README.md'), sourceEntry('docs/rules.md')].map((entry) => ({
      entryId: entry.id,
      revision: entry.revision,
      category: entry.category,
      title: entry.title,
    }))
    const materials = [
      { ref: refs[0]!, content: '产品面向本地优先的团队。', truncated: false },
      { ref: refs[1]!, content: '所有配置必须使用原子写。', truncated: false },
    ]
    const response = JSON.stringify({ candidates: [{
      title: '本地数据规则',
      content: '产品本地优先，配置写入必须保持原子性。',
      category: 'engineering',
      kind: 'rule',
      evidence: [
        { entryId: refs[0]!.entryId, revision: refs[0]!.revision, quote: '产品面向本地优先的团队。' },
        { entryId: refs[1]!.entryId, revision: refs[1]!.revision, quote: '所有配置必须使用原子写。' },
      ],
    }] })
    const candidates = parseSourceDistillationCandidates(response, materials)
    expect(candidates[0]?.evidence).toHaveLength(2)
    expect(buildSourceDistillationPrompt(materials, [])).toContain('允许综合多个来源')
  })

  test('Given 模型伪造引文或来源版本 When 校验输出 Then 整批拒绝', () => {
    const entry = sourceEntry('README.md')
    const ref = { entryId: entry.id, revision: entry.revision, category: entry.category, title: entry.title }
    const materials = [{ ref, content: '真实内容', truncated: false }]
    const forged = JSON.stringify({ candidates: [{
      title: '伪造', content: '错误', category: 'overview', kind: 'fact',
      evidence: [{ entryId: ref.entryId, revision: ref.revision, quote: '不存在' }],
    }] })
    expect(() => parseSourceDistillationCandidates(forged, materials)).toThrow('引用')
  })
})
