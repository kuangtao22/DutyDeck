import { describe, expect, test } from 'bun:test'
import type { SkillFileNode } from '@proma/shared'
import { listMemoryFiles } from './WorkspaceMemoryTab'

/** 真实目录形状的夹具：同名文件通过相对路径保持独立身份。 */
const files: SkillFileNode[] = [
  { name: 'MEMORY.md', relativePath: 'MEMORY.md', type: 'file', size: 80 },
  { name: 'experience', relativePath: 'experience', type: 'directory', children: [
    { name: 'notes.md', relativePath: 'experience/notes.md', type: 'file', size: 120 },
  ] },
  { name: 'decisions', relativePath: 'decisions', type: 'directory', children: [
    { name: 'notes.md', relativePath: 'decisions/notes.md', type: 'file', size: 200 },
  ] },
]

describe('独立记忆文件列表', () => {
  test('Given 记忆包含多层目录和同名文件 When 展示列表 Then 每个原文件可独立选择且不改变磁盘结构', () => {
    const before = structuredClone(files)
    expect(listMemoryFiles(files, '').map((file) => file.relativePath)).toEqual([
      'MEMORY.md', 'experience/notes.md', 'decisions/notes.md',
    ])
    expect(files).toEqual(before)
  })

  test('Given 文件归档在目录中 When 按路径或正文命中搜索 Then 列表直接展示对应文件', () => {
    expect(listMemoryFiles(files, 'EXPERIENCE').map((file) => file.relativePath)).toEqual(['experience/notes.md'])
    expect(listMemoryFiles(files, '用户纠正', new Set(['decisions/notes.md'])).map((file) => file.relativePath)).toEqual(['decisions/notes.md'])
    expect(listMemoryFiles(files, '不存在')).toEqual([])
  })
})
