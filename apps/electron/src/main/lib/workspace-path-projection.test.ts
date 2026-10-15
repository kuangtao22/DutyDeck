import { expect, test } from 'bun:test'
import { projectWorkspaceConfigPaths, projectWorkspaceIndexPaths } from './workspace-path-projection'

/** 测试专用编码器，只转换已知受管根，保留外部和普通字符串。 */
const serializePath = (path: string): string => path.startsWith('/managed/') ? `dutydeck-data:/${path.slice(9)}` : path
/** 模拟迁移完成后统一定位至新数据根。 */
const resolvePath = (path: string): string => path.startsWith('dutydeck-data:/') ? `/relocated/${path.slice(15)}` : path

test('Given 混合受管和外部项目 When 投影索引 Then 仅编码已知路径且不修改输入', () => {
  /** 含未知字符串的索引，验证不会全局替换正文。 */
  const input = { version: 2, note: '/managed/notes', workspaces: [
    { id: 'a', projectRootPath: '/managed/projects/a', name: '/managed/title' },
    { id: 'b', projectRootPath: '/external/.proma/project' },
  ] }
  /** 写前快照用于检查无副作用。 */
  const before = structuredClone(input)
  /** 磁盘投影结果。 */
  const stored = projectWorkspaceIndexPaths(input, serializePath)
  expect(stored.workspaces[0]?.projectRootPath).toBe('dutydeck-data:/projects/a')
  expect(stored.workspaces[1]).toEqual(input.workspaces[1])
  expect(stored.note).toBe(input.note)
  expect(stored.workspaces[0]?.name).toBe('/managed/title')
  expect(input).toEqual(before)
  expect(projectWorkspaceIndexPaths(stored, resolvePath).workspaces[0]?.projectRootPath).toBe('/relocated/projects/a')
})

test('Given 配置附加路径及 worktree When 编码再迁移解析 Then 所有已知路径恢复且未知字段保留', () => {
  /** 混合外部目录、普通相对引用和未知元数据。 */
  const input = { attachedDirectories: ['/managed/dir', '/external/.proma'], attachedFiles: ['/managed/file', 'plain-relative'],
    worktreeRepos: [{ name: '/managed/name', repoPath: '/managed/repo', worktreesPath: '/managed/worktrees', note: '/managed/note' }],
    custom: { path: '/managed/untouched' } }
  /** 原输入快照。 */
  const before = structuredClone(input)
  /** 先存储，再以新根读取。 */
  const stored = projectWorkspaceConfigPaths(input, serializePath)
  expect(stored.attachedFiles).toEqual(['dutydeck-data:/file', 'plain-relative'])
  expect(stored.worktreeRepos[0]?.repoPath).toBe('dutydeck-data:/repo')
  expect(stored.worktreeRepos[0]?.worktreesPath).toBe('dutydeck-data:/worktrees')
  expect(stored.worktreeRepos[0]?.note).toBe('/managed/note')
  expect(stored.custom).toEqual(input.custom)
  expect(input).toEqual(before)
  expect(projectWorkspaceConfigPaths(stored, resolvePath).attachedDirectories).toEqual(['/relocated/dir', '/external/.proma'])
})
