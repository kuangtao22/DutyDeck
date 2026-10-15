import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataRootLocator } from './data-root-locator'

/** 仅隔离原生选择器；附件读取、定位器和文件安全校验使用生产实现。 */
mock.module('electron', () => ({ dialog: {}, BrowserWindow: class {} }))
/** 延迟导入依赖 Electron 的附件服务，避免初始化真实应用。 */
const { readAttachmentAsBase64, saveAttachment, deleteAttachment } = await import('./attachment-service')
/** 测试只操作独立临时 home，结束时统一回收。 */
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

/** 创建迁移后的目录和定位器，返回旧引用与新文件路径供行为测试使用。 */
function fixture(custom = false): { home: string; root: string; oldRoot: string; file: string; oldFile: string; locator: DataRootLocator } {
  /** 模拟独立用户目录，绝不使用真实 HOME。 */
  const home = mkdtempSync(join(tmpdir(), 'dutydeck-attachment-migration-'))
  homes.push(home)
  /** 新旧数据根分别覆盖默认移动和自定义复制迁移。 */
  const root = join(home, custom ? 'custom-data' : '.DutyDeck')
  const oldRoot = join(home, custom ? 'previous-custom-data' : '.proma')
  /** 会话附件保持原有相对位置。 */
  const suffix = join('agent-workspaces', 'workspace-test', 'session-test', 'attachments', '图片.png')
  const file = join(root, suffix)
  const oldFile = join(oldRoot, suffix)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, 'migrated-image')
  /** 使用生产 locator 持久化可用活动根。 */
  const locator = new DataRootLocator({ homeDir: home })
  locator.write({ version: 1, activeRoot: root, ...(custom ? { previousRoot: oldRoot } : {}) })
  return { home, root, oldRoot, file, oldFile, locator }
}

describe('迁移后的历史附件读取', () => {
  test('Given 旧默认根已移动 When 读取历史绝对引用 Then 返回新目录原文件内容', () => {
    /** 移动后不存在旧目录，真实文件只保留在新根。 */
    const sample = fixture()
    expect(Buffer.from(readAttachmentAsBase64(sample.oldFile, sample.locator), 'base64').toString()).toBe('migrated-image')
    expect(readFileSync(sample.file, 'utf8')).toBe('migrated-image')
  })

  test('Given 自定义迁移保留旧副本 When 读取旧引用 Then 使用当前根而非旧副本', () => {
    /** 旧文件内容故意不同，用来证明不会退回旧根读取。 */
    const sample = fixture(true)
    mkdirSync(join(sample.oldFile, '..'), { recursive: true })
    writeFileSync(sample.oldFile, 'obsolete-image')
    expect(Buffer.from(readAttachmentAsBase64(sample.oldFile, sample.locator), 'base64').toString()).toBe('migrated-image')
  })

  test('Given 当前绝对路径或 Chat 相对路径 When 读取 Then 保留既有兼容语义', () => {
    const sample = fixture()
    mkdirSync(join(sample.root, 'attachments', 'conversation'), { recursive: true })
    writeFileSync(join(sample.root, 'attachments', 'conversation', 'image.png'), 'chat-image')
    expect(Buffer.from(readAttachmentAsBase64(sample.file, sample.locator), 'base64').toString()).toBe('migrated-image')
    expect(Buffer.from(readAttachmentAsBase64('conversation/image.png', sample.locator), 'base64').toString()).toBe('chat-image')
  })

  test('Given 同名前缀目录或相对路径穿越 When 读取 Then 拒绝越过授权根', () => {
    const sample = fixture()
    for (const path of [join(`${sample.root}-other`, 'image.png'), join(`${sample.oldRoot}-other`, 'image.png'), '../settings.json', join(sample.oldRoot, '..', 'outside.png')]) {
      expect(() => readAttachmentAsBase64(path, sample.locator)).toThrow('安全目录')
    }
  })

  test('Given 新目录文件缺失且旧副本仍存在 When 读取 Then 明确报缺失并拒绝退回旧根', () => {
    const sample = fixture(true)
    mkdirSync(join(sample.oldFile, '..'), { recursive: true })
    writeFileSync(sample.oldFile, 'obsolete-image')
    rmSync(sample.file)
    expect(() => readAttachmentAsBase64(sample.oldFile, sample.locator)).toThrow('附件文件不存在')
  })

  test('Given 迁移目标叶子是符号链接 When 读取旧引用 Then 拒绝链接', () => {
    const sample = fixture()
    rmSync(sample.file)
    writeFileSync(join(sample.home, 'outside.png'), 'private')
    symlinkSync(join(sample.home, 'outside.png'), sample.file)
    expect(() => readAttachmentAsBase64(sample.oldFile, sample.locator)).toThrow('符号链接')
  })

  test('Given 迁移目标父目录链接到根外 When 读取旧引用 Then 拒绝实际路径越界', () => {
    const sample = fixture()
    /** 整个附件目录被外部链接替换，必须在读取字节前阻断。 */
    const parent = join(sample.file, '..')
    rmSync(parent, { recursive: true })
    mkdirSync(join(sample.home, 'outside'))
    writeFileSync(join(sample.home, 'outside', '图片.png'), 'private')
    symlinkSync(join(sample.home, 'outside'), parent)
    expect(() => readAttachmentAsBase64(sample.oldFile, sample.locator)).toThrow('授权目录')
  })
})


describe('统一数据根附件引用', () => {
  test('Given 新附件 When 保存后读取并删除 Then 返回可迁移引用且只操作当前根', () => {
    /** 隔离定位器保证保存过程不接触真实业务数据。 */
    const sample = fixture()
    /** 保存结果具备显式数据根语义。 */
    const result = saveAttachment({ conversationId: 'conversation', filename: '内容.txt', mediaType: 'text/plain', data: Buffer.from('portable').toString('base64') }, sample.locator)
    expect(result.attachment.localPath).toMatch(/^dutydeck-data:\/attachments\/conversation\//)
    expect(Buffer.from(readAttachmentAsBase64(result.attachment.localPath, sample.locator), 'base64').toString()).toBe('portable')
    deleteAttachment(result.attachment.localPath, sample.locator)
    expect(() => readAttachmentAsBase64(result.attachment.localPath, sample.locator)).toThrow('附件文件不存在')
  })

  test('Given 数据根引用 When 读取会话附件 Then 返回当前数据根字节', () => {
    /** 对中文文件名采用逐段编码，避免路径分隔符歧义。 */
    const sample = fixture()
    expect(Buffer.from(readAttachmentAsBase64('dutydeck-data:/agent-workspaces/workspace-test/session-test/attachments/%E5%9B%BE%E7%89%87.png', sample.locator), 'base64').toString()).toBe('migrated-image')
  })

  test('Given 非聊天附件或穿越引用 When 删除 Then 拒绝并保留文件', () => {
    /** Agent 文件可读取但不能被 Chat 附件清理接口删除。 */
    const sample = fixture()
    for (const path of ['dutydeck-data:/agent-workspaces/workspace-test/session-test/attachments/%E5%9B%BE%E7%89%87.png', '../settings.json', 'dutydeck-data:/attachments/../settings.json']) {
      expect(() => deleteAttachment(path, sample.locator)).toThrow()
    }
    expect(existsSync(sample.file)).toBe(true)
  })

  test('Given 附件父目录链接到外部 When 删除 Then 拒绝且外部文件保持', () => {
    /** 外部文件不因附件目录别名而成为可删除资源。 */
    const sample = fixture()
    mkdirSync(join(sample.root, 'attachments'))
    mkdirSync(join(sample.home, 'outside'))
    writeFileSync(join(sample.home, 'outside', 'image.png'), 'private')
    symlinkSync(join(sample.home, 'outside'), join(sample.root, 'attachments', 'linked'))
    expect(() => deleteAttachment('dutydeck-data:/attachments/linked/image.png', sample.locator)).toThrow()
    expect(readFileSync(join(sample.home, 'outside', 'image.png'), 'utf8')).toBe('private')
  })
})


test('Given 受管文档新旧引用 When 提取正文 Then 从当前根读取并拒绝外部链接', async () => {
  /** 文档使用生产解析器和临时数据根，不加载真实应用。 */
  const { extractTextFromAttachment } = await import('./document-parser')
  const sample = fixture()
  mkdirSync(join(sample.root, 'attachments', 'conversation'), { recursive: true })
  writeFileSync(join(sample.root, 'attachments', 'conversation', 'note.txt'), '文档正文')
  for (const path of ['dutydeck-data:/attachments/conversation/note.txt', 'conversation/note.txt', join(sample.oldRoot, 'attachments', 'conversation', 'note.txt')]) {
    expect(await extractTextFromAttachment(path, sample.locator)).toBe('文档正文')
  }
  writeFileSync(join(sample.home, 'secret.txt'), 'private')
  symlinkSync(join(sample.home, 'secret.txt'), join(sample.root, 'attachments', 'conversation', 'linked.txt'))
  await expect(extractTextFromAttachment('dutydeck-data:/attachments/conversation/linked.txt', sample.locator)).rejects.toThrow('符号链接')
})
