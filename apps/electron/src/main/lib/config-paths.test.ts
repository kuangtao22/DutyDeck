import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAgentCanvasBindingsPath,
  getAgentSessionMessagesPath,
  getAgentWorkspacePath,
  getConfigDir,
  getConfigDirName,
  getConversationMessagesPath,
  isRetiredDefaultSkill,
  removeRetiredDefaultSkills,
  RETIRED_DEFAULT_SKILL_SLUGS,
  resolveAgentSessionWorkspacePath,
  createDataRootPathResolver,
  createDataRootPathSerializer,
  resolveAttachmentPath,
} from './config-paths'
import { DataRootLocator } from './data-root-locator'

/** 当前测试创建的临时 home 目录，测试结束后统一清理。 */
const temporaryHomeDirs: string[] = []

afterEach(() => {
  for (const homeDir of temporaryHomeDirs.splice(0)) {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

/** 创建未读取磁盘状态的独立测试 resolver。 */
function createLocator(): { homeDir: string; locator: DataRootLocator } {
  /** 为当前用例隔离的临时 home 目录。 */
  const homeDir = mkdtempSync(join(tmpdir(), 'proma-config-paths-'))
  temporaryHomeDirs.push(homeDir)
  return { homeDir, locator: new DataRootLocator({ homeDir }) }
}

test('Given a development environment When resolving business storage Then it shares the production config directory', () => {
  // 保存调用方环境，避免测试修改影响同进程中的其他用例。
  const originalPromaDev = process.env.PROMA_DEV
  process.env.PROMA_DEV = '1'

  try {
    expect(getConfigDirName()).toBe('.DutyDeck')
  } finally {
    if (originalPromaDev === undefined) {
      delete process.env.PROMA_DEV
    } else {
      process.env.PROMA_DEV = originalPromaDev
    }
  }
})

test('Given traversal 消息 ID When 解析 JSONL 路径 Then Agent 与 Conversation 均拒绝越界', () => {
  expect(() => getAgentSessionMessagesPath('../outside')).toThrow('无效的会话 ID')
  expect(() => getConversationMessagesPath('../outside')).toThrow('无效的会话 ID')
})

test('Given the default environment When resolving business storage Then it uses the shared config directory', () => {
  expect(getConfigDirName()).toBe('.DutyDeck')
})

test('Given 配置根 When 解析 Agent-画布关联索引 Then 使用根目录下固定 JSON 文件', () => {
  /** 独立配置根用于证明路径不依赖 Electron userData。 */
  const configRoot = join(tmpdir(), 'proma-agent-canvas-bindings')

  expect(getAgentCanvasBindingsPath(configRoot)).toBe(
    join(configRoot, 'agent-canvas-bindings.json'),
  )
})

test('Given traversal 或绝对 sessionId When 解析会话目录 Then 在文件系统访问前拒绝越界', () => {
  for (const sessionId of ['../outside', 'nested/session', 'nested\\session', '/tmp/outside']) {
    expect(() => resolveAgentSessionWorkspacePath('workspace', sessionId)).toThrow('无效的会话 ID')
  }
})

test('Given 自定义数据根 When 解析 Agent 工作区 Then 使用该根且保留空格', () => {
  /** 独立 locator 避免修改进程默认 locator 的缓存。 */
  const { homeDir, locator } = createLocator()
  /** 模拟用户选择的带空格外部数据根。 */
  const customRoot = join(homeDir, 'Volumes', 'Work', 'Proma Data')
  mkdirSync(customRoot, { recursive: true })
  writeFileSync(
    join(homeDir, '.proma-location.json'),
    JSON.stringify({ version: 1, activeRoot: customRoot }),
    'utf-8',
  )

  expect(getAgentWorkspacePath('proma', locator)).toBe(join(customRoot, 'agent-workspaces', 'proma'))
})

test('Given 缺失的默认数据根 When 首次读取配置目录 Then 按需创建并保持进程内结果稳定', () => {
  /** 没有定位文件和默认根的独立 locator。 */
  const { homeDir, locator } = createLocator()
  /** 默认业务数据根在读取前不应存在。 */
  const defaultRoot = join(homeDir, '.DutyDeck')

  expect(existsSync(defaultRoot)).toBe(false)
  expect(getConfigDir(locator)).toBe(defaultRoot)
  expect(existsSync(defaultRoot)).toBe(true)

  /** 后写入的定位文件不应让已缓存进程根热切换。 */
  const laterRoot = join(homeDir, 'later-root')
  mkdirSync(laterRoot, { recursive: true })
  writeFileSync(
    join(homeDir, '.proma-location.json'),
    JSON.stringify({ version: 1, activeRoot: laterRoot }),
    'utf-8',
  )

  expect(getConfigDir(locator)).toBe(defaultRoot)
})

test('Given 已删除的旧生图 Skill 缓存 When 清理退役默认 Skill Then 只删除明确退役目录', () => {
  /** 使用独立临时目录验证启动清理不会碰用户自行安装的 Skill。 */
  const defaultSkillsDir = mkdtempSync(join(tmpdir(), 'proma-retired-skills-'))
  temporaryHomeDirs.push(defaultSkillsDir)
  mkdirSync(join(defaultSkillsDir, 'proma-generate-image'))
  mkdirSync(join(defaultSkillsDir, 'user-installed-skill'))

  removeRetiredDefaultSkills(defaultSkillsDir)

  expect(RETIRED_DEFAULT_SKILL_SLUGS).toContain('proma-generate-image')
  expect(isRetiredDefaultSkill('proma-generate-image')).toBe(true)
  expect(existsSync(join(defaultSkillsDir, 'proma-generate-image'))).toBe(false)
  expect(existsSync(join(defaultSkillsDir, 'user-installed-skill'))).toBe(true)
})

test('Given 历史路径位于已知旧根 When 创建读取投影 Then 只重定向旧根后代且不触碰外部项目', () => {
  /** 当前根与旧根都由宿主提供，未读取任何旧文件。 */
  const parent = join(tmpdir(), 'path-projection')
  const oldRoot = join(parent, 'old')
  const currentRoot = join(parent, 'current')
  const resolvePath = createDataRootPathResolver({
    requireActiveRoot: () => currentRoot,
    getHistoricalRoots: () => [oldRoot],
  })
  expect(resolvePath(join(oldRoot, 'agent-workspaces/a/attachments/image.png'))).toBe(join(currentRoot, 'agent-workspaces/a/attachments/image.png'))
  for (const path of [join(currentRoot, 'image.png'), join(`${oldRoot}-copy`, 'image.png'), join(oldRoot, '..', 'project/image.png'), join(parent, 'project/.proma/file.png'), 'session/image.png', oldRoot]) {
    expect(resolvePath(path)).toBe(path)
  }
})

test('Given 数据根采用不同目录分隔语义 When 读取当前平台路径 Then 使用平台路径边界', () => {
  const { homeDir, locator } = createLocator()
  /** 临时路径由当前操作系统生成，兼容 Windows 与 POSIX 测试环境。 */
  const root = join(homeDir, '.DutyDeck')
  mkdirSync(root)
  locator.write({ version: 1, activeRoot: root })
  expect(createDataRootPathResolver(locator)(join(homeDir, '.proma', 'attachments', 'image.png')))
    .toBe(join(root, 'attachments', 'image.png'))
})

test('Given 新旧附件引用 When 使用统一入口 Then 根据根类型解析而非猜测目录名称', () => {
  /** 无 I/O 定位器模拟已完成的自定义迁移。 */
  const root = join(tmpdir(), 'custom-data')
  const previous = join(tmpdir(), 'previous-data')
  const resolver = { requireActiveRoot: () => root, getHistoricalRoots: () => [previous] }
  const serialize = createDataRootPathSerializer(resolver)
  const file = join(root, 'agent-workspaces/default/s1/attachments/a b.png')
  expect(serialize(file)).toBe('dutydeck-data:/agent-workspaces/default/s1/attachments/a%20b.png')
  expect(resolveAttachmentPath(serialize(file), resolver)).toBe(file)
  expect(resolveAttachmentPath(join(previous, 'agent-workspaces/default/s1/attachments/a b.png'), resolver)).toBe(file)
  expect(resolveAttachmentPath('c1/a.png', resolver)).toBe(join(root, 'attachments/c1/a.png'))
  expect(resolveAttachmentPath('', resolver)).toBe(join(root, 'attachments'))
  expect(resolveAttachmentPath(join(tmpdir(), 'external/a.png'), resolver)).toBe(join(tmpdir(), 'external/a.png'))
})
