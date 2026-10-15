import { describe, expect, test } from 'bun:test'
import { Children, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KnowledgeEntry, KnowledgeOutline, KnowledgeOutlineItem } from '@proma/shared'
import { KnowledgeFileTree } from './KnowledgeFileTree'

/** 创建独立于来源路径的知识文件夹具，入参覆盖身份和真实文件位置。 */
function entry(id: string, relativePath?: string, rootRelativePath = 'knowledge'): KnowledgeEntry {
  return { id, revision: 'rev-1', title: '旧知识标题', category: 'test', kind: 'document', state: 'confirmed', freshness: 'current', summary: '不会出现在文件树的摘要', source: { kind: 'managed', id: 'opaque-source-hash', revision: '1' }, byteSize: 1, indexedBytes: 1, truncated: false, metadataOnly: false, updatedAt: 1, document: relativePath ? { relativePath, rootRelativePath, topicKey: id, groupId: 'group', contentRevision: '1' } : undefined }
}

/** 创建指定状态的大纲项，返回完整共享契约。 */
function item(id: string, relativePath: string, status: KnowledgeOutlineItem['status'], entryId?: string): KnowledgeOutlineItem {
  return { id, relativePath, status, entryId, groupId: 'group', title: id, summary: '', sections: [] }
}

/** 将输入目录与大纲渲染为静态 HTML，供用户可见结构断言。 */
function render(entries: KnowledgeEntry[], items: KnowledgeOutlineItem[] = [], query = ''): string {
  /** 固定大纲身份，测试只变化文件与生成状态。 */
  const outline: KnowledgeOutline = { revision: 1, planRevision: 1, relativePath: 'outline.md', items }
  return renderToStaticMarkup(<KnowledgeFileTree entries={entries} outline={outline} query={query} rootRelativePath="knowledge" selectedEntryId="a" onSelectEntry={() => {}} />)
}

/** 遍历真实组件输出，找到并执行文件按钮，验证受控读取回调。 */
function clickFile(node: ReactNode, label: string): void {
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode; 'aria-label'?: string; onClick?: () => void }>(child)) return
    if (child.props['aria-label'] === label) child.props.onClick?.()
    clickFile(child.props.children, label)
  })
}

describe('知识库文件树', () => {
  test('Given 分页加载更多真实条目 When 点击文件 Then 仅对已加载文件调用受控入口', () => {
    /** 捕获调用目标，确保文件路径不被当作任意读取地址。 */
    const selected: string[] = []
    /** 固定外页大纲，模拟目录尚未分页加载到目标文件。 */
    const outline: KnowledgeOutline = { revision: 1, planRevision: 1, relativePath: 'outline.md', items: [item('r', '外页.md', 'partial', 'outside')] }
    /** 直接检查函数组件输出的事件处理器，不增加测试 DOM 依赖。 */
    const view = KnowledgeFileTree({ entries: [entry('a', '当前.md')], outline, rootRelativePath: 'knowledge', selectedEntryId: null, onSelectEntry: (value) => selected.push(value.id) })
    clickFile(view, '打开当前.md')
    clickFile(view, '打开外页.md')
    expect(selected).toEqual(['a'])
    /** 加载更多后由宿主正式提供条目，方可进入正文读取。 */
    const loadedView = KnowledgeFileTree({ entries: [entry('a', '当前.md'), entry('outside', '外页.md')], outline, rootRelativePath: 'knowledge', selectedEntryId: null, onSelectEntry: (value) => selected.push(value.id) })
    clickFile(loadedView, '打开外页.md')
    expect(selected).toEqual(['a', 'outside'])
  })
  test('Given 深层真实文件 When 展示目录 Then 文件夹逐级可折叠且只显示文件名', () => {
    /** 三层真实路径用于验证层级结构。 */
    const html = render([entry('a', '产品/设计/交互.md')])
    expect(html.match(/<details/g)?.length).toBe(2)
    expect(html).toContain('open=""')
    expect(html).toContain('交互.md')
    expect(html).toContain('aria-current="page"')
    expect(html).not.toContain('不会出现在文件树的摘要')
    expect(html).not.toContain('opaque-source-hash')
  })
  test('Given 已有正文仍部分完成或文件已删除 When 展示 Then 保留状态点且不占用文件名宽度', () => {
    /** 真实路径覆盖旧大纲路径，但状态仍按稳定条目身份关联。 */
    const html = render([entry('a', '新路径.md'), entry('b', '缺依据.md')], [item('partial', '旧路径.md', 'partial', 'a'), item('missing', '旧缺口.md', 'missing', 'b')])
    expect(html).toContain('title="部分完成" aria-label="部分完成"')
    expect(html).toContain('title="文件已删除" aria-label="文件已删除"')
    expect(html).not.toContain('>部分完成</span>')
    expect(html).not.toContain('>文件已删除</span>')
    expect(html).not.toContain('旧路径.md')
    expect(html).toContain('aria-label="知识库文件目录"')
  })
  test('Given 文件已改名且大纲保留旧路径 When 合并 Then 同一身份仅保留真实路径', () => {
    /** 重复目录项和过期大纲共同覆盖身份去重。 */
    const html = render([entry('a', '新目录/新名.md'), entry('a', '新目录/新名.md')], [item('old', '旧目录/旧名.md', 'ready', 'a')])
    expect(html.match(/<button/g)?.length).toBe(1)
    expect(html).not.toContain('旧目录')
    expect(html).toContain('新名.md')
  })
  test('Given 等待生成或文件已删除 When 展示 Then 不提供打开按钮', () => {
    /** 两种不可读状态均保留可见文件占位。 */
    const html = render([], [item('p', '等待.md', 'pending'), item('m', '缺口.md', 'missing')])
    expect(html).not.toContain('<button')
    expect(html).toContain('title="等待生成" aria-label="等待生成"')
    expect(html).not.toContain('>等待生成</span>')
    expect(html).toContain('文件已删除')
  })
  test('Given 分页外已生成文件 When 展示 Then 不绕过加载更多补回文件', () => {
    /** 大纲仅是计划，不能替代宿主分页目录。 */
    const html = render([], [item('r', '外页.md', 'ready', 'outside')])
    expect(html).not.toContain('<button')
    expect(html).not.toContain('外页.md')
  })
  test('Given 宿主已过滤归档和排除文件 When 大纲仍保留身份 Then 不回流幽灵文件', () => {
    /** 模拟已归档、排除以及缺失条目的过期大纲记录。 */
    const html = render([entry('a', '有效.md')], [item('archived', '归档.md', 'ready', 'archived'), item('excluded', '排除.md', 'partial', 'excluded'), item('missing', '失效.md', 'missing', 'missing'), item('pending', '旧等待.md', 'pending', 'pending')])
    expect(html).toContain('有效.md')
    expect(html).not.toContain('归档.md')
    expect(html).not.toContain('排除.md')
    expect(html).not.toContain('失效.md')
    expect(html).not.toContain('旧等待.md')
    expect(html.match(/<button/g)?.length).toBe(1)
  })
  test('Given 正文检索命中 When 展示 Then 保留传入结果且不混入其他大纲', () => {
    /** 标题不含查询词，模拟全文命中。 */
    const html = render([entry('a', '命中文件.md')], [item('p', '不相关.md', 'pending')], '正文关键词')
    expect(html).toContain('命中文件.md')
    expect(html).not.toContain('不相关.md')
  })
  test('Given 多库同名文件与旧版条目 When 展示 Then 根目录区分且旧版用标题', () => {
    /** 两个库的同名文件不可合并。 */
    const html = render([entry('a', '同名.md'), entry('b', '同名.md', 'archive'), entry('c')])
    expect(html).toContain('archive')
    expect(html.match(/<button/g)?.length).toBe(3)
    expect(html).toContain('旧知识标题')
    expect(html).not.toContain('opaque-source-hash')
  })
})
