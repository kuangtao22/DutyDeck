import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 在隔离 HOME 的独立进程使用真实 manager，避免污染其他测试的模块缓存和真实数据。 */
function runManager(homeDir: string, source: string): void {
  /** 测试子进程继承包解析环境，仅替换数据定位根。 */
  const result = Bun.spawnSync([process.execPath, '-e', source], {
    cwd: import.meta.dir,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
  })
  expect(new TextDecoder().decode(result.stderr)).toBe('')
  expect(result.exitCode).toBe(0)
}

test('Given 配置含损坏根引用 When 读取或附加文件 Then 显式拒绝且不覆盖其他配置', () => {
  /** 测试只创建临时数据根，原字节作为误覆盖检测基线。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'dutydeck-workspace-invalid-reference-'))
  try {
    const root = join(homeDir, 'Data')
    const configPath = join(root, 'agent-workspaces', 'default', 'config.json')
    mkdirSync(join(root, 'agent-workspaces', 'default'), { recursive: true })
    writeFileSync(join(homeDir, '.DutyDeck-location.json'), JSON.stringify({ version: 1, activeRoot: root }))
    const original = JSON.stringify({ attachedFiles: ['dutydeck-data:/../secret'], futureField: '必须保留' })
    writeFileSync(configPath, original)
    runManager(homeDir, `
      import { expect } from 'bun:test';
      import * as manager from './agent-workspace-manager';
      expect(() => manager.getWorkspaceAttachedFiles('default')).toThrow('数据根引用');
      expect(() => manager.attachWorkspaceFile('default', '/external/new.png')).toThrow('数据根引用');
    `)
    expect(readFileSync(configPath, 'utf8')).toBe(original)
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Given 旧根工作区元数据 When 读取并写回 Then 磁盘统一根引用且运行时始终返回当前绝对路径', () => {
  /** 完全隔离的定位器 home。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'dutydeck-workspace-paths-'))
  try {
    /** 当前自定义数据根，与历史默认根不同。 */
    const root = join(homeDir, 'Custom Data')
    /** 旧根引用仅作为别名，旧目录本身不创建。 */
    const oldRoot = join(homeDir, '.proma')
    /** 工作区配置与索引真实磁盘路径。 */
    const configPath = join(root, 'agent-workspaces', 'default', 'config.json')
    const indexPath = join(root, 'agent-workspaces.json')
    mkdirSync(join(root, 'agent-workspaces', 'default'), { recursive: true })
    writeFileSync(join(homeDir, '.DutyDeck-location.json'), JSON.stringify({ version: 1, activeRoot: root }))
    writeFileSync(indexPath, JSON.stringify({ version: 2, workspaces: [
      { id: 'a', name: '受管项目', slug: 'default', createdAt: 1, updatedAt: 1, projectRootPath: join(oldRoot, 'projects', 'a') },
      { id: 'b', name: '外部项目', slug: 'external', createdAt: 1, updatedAt: 1, projectRootPath: '/external/project/.proma' },
    ] }))
    writeFileSync(configPath, JSON.stringify({ attachedDirectories: [join(oldRoot, 'dir'), '/external/project'],
      attachedFiles: [join(oldRoot, 'file.png')],
      worktreeRepos: [{ name: 'repo', repoPath: join(oldRoot, 'repo'), worktreesPath: join(oldRoot, 'worktrees') }],
      futureField: join(oldRoot, 'this-is-not-a-path-field'),
    }))
    runManager(homeDir, `
      import { expect } from 'bun:test';
      import * as manager from './agent-workspace-manager';
      import { join } from 'node:path';
      const root = ${JSON.stringify(root)};
      expect(manager.getAgentWorkspace('a').projectRootPath).toBe(join(root, 'projects', 'a'));
      expect(manager.getWorkspaceAttachedDirectories('default')).toEqual([join(root, 'dir'), '/external/project']);
      expect(manager.getWorkspaceAttachedFiles('default')).toEqual([join(root, 'file.png')]);
      expect(manager.attachWorkspaceFile('default', join(root, 'new.png'))).toEqual([join(root, 'file.png'), join(root, 'new.png')]);
      expect(manager.reorderAgentWorkspaces(['b', 'a'])[1].projectRootPath).toBe(join(root, 'projects', 'a'));
    `)
    /** 检查写入结果使用可移植引用且未知字符串不改写。 */
    const storedConfig = JSON.parse(readFileSync(configPath, 'utf8'))
    const storedIndex = JSON.parse(readFileSync(indexPath, 'utf8'))
    expect(storedIndex.workspaces[1].projectRootPath).toBe('dutydeck-data:/projects/a')
    expect(storedIndex.workspaces[0].projectRootPath).toBe('/external/project/.proma')
    expect(storedConfig.attachedDirectories).toEqual(['dutydeck-data:/dir', '/external/project'])
    expect(storedConfig.attachedFiles).toEqual(['dutydeck-data:/file.png', 'dutydeck-data:/new.png'])
    expect(storedConfig.worktreeRepos[0].repoPath).toBe('dutydeck-data:/repo')
    expect(storedConfig.worktreeRepos[0].worktreesPath).toBe('dutydeck-data:/worktrees')
    expect(storedConfig.futureField).toBe(join(oldRoot, 'this-is-not-a-path-field'))
    /** 再次更换定位根，读取同一元数据不需要再次重写引用。 */
    const movedRoot = join(homeDir, 'Moved Data')
    mkdirSync(join(movedRoot, 'agent-workspaces', 'default'), { recursive: true })
    writeFileSync(join(movedRoot, 'agent-workspaces.json'), JSON.stringify(storedIndex))
    writeFileSync(join(movedRoot, 'agent-workspaces', 'default', 'config.json'), JSON.stringify(storedConfig))
    writeFileSync(join(homeDir, '.DutyDeck-location.json'), JSON.stringify({ version: 1, activeRoot: movedRoot }))
    runManager(homeDir, `
      import { expect } from 'bun:test';
      import * as manager from './agent-workspace-manager';
      import { join } from 'node:path';
      const root = ${JSON.stringify(movedRoot)};
      expect(manager.getAgentWorkspace('a').projectRootPath).toBe(join(root, 'projects', 'a'));
      expect(manager.getWorkspaceAttachedFiles('default')).toEqual([join(root, 'file.png'), join(root, 'new.png')]);
      manager.rebaseWorkspaceConfigPaths('default', join(root, 'dir'), '/external/moved-dir');
      expect(manager.getWorkspaceAttachedDirectories('default')).toEqual(['/external/moved-dir', '/external/project']);
    `)
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})
