import { existsSync, lstatSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { ensureDirectoryDurable } from '../safe-file'
import type { ResolvedKnowledgeProject } from './types'

/** 知识库固定目录名。 */
const KNOWLEDGE_DIRECTORY_PARTS = ['.proma', 'knowledge'] as const

/** 确认路径是实际目录，拒绝符号链接。 */
export function assertActualDirectory(directoryPath: string, label: string): void {
  if (!isAbsolute(directoryPath)) throw new Error(`${label}必须是绝对路径`)
  const stat = lstatSync(directoryPath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}不是安全的实际目录`)
}

/** 校验 resolver 返回的所有可信根，不创建任何目录。 */
export function validateResolvedProject(project: ResolvedKnowledgeProject): void {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(project.projectId)) throw new Error('项目 ID 非法')
  assertActualDirectory(project.projectRoot, '项目根目录')
  if (!isAbsolute(project.memoryRoot)) throw new Error('记忆根目录必须是绝对路径')
  if (existsSync(project.memoryRoot)) assertActualDirectory(project.memoryRoot, '记忆根目录')
  if (!isAbsolute(project.cacheRoot)) throw new Error('缓存根目录必须是绝对路径')
  if (existsSync(project.cacheRoot)) assertActualDirectory(project.cacheRoot, '缓存根目录')
}

/** 按数据根、缓存父目录和工作区目录逐级创建可重建索引目录。 */
export function ensureKnowledgeCacheDirectories(project: ResolvedKnowledgeProject): void {
  validateResolvedProject(project)
  /** 运行时固定的 knowledge-cache 父目录。 */
  const cacheParent = dirname(project.cacheRoot)
  /** 活动数据根必须已经存在，不能由知识服务递归猜测创建。 */
  const dataRoot = dirname(cacheParent)
  assertActualDirectory(dataRoot, '知识缓存数据根')
  if (existsSync(cacheParent)) assertActualDirectory(cacheParent, '知识缓存父目录')
  else ensureDirectoryDurable(cacheParent)
  if (existsSync(project.cacheRoot)) assertActualDirectory(project.cacheRoot, '缓存根目录')
  else ensureDirectoryDurable(project.cacheRoot)
}

/** 只读校验可重建索引的完整父目录链。 */
export function assertKnowledgeCacheDirectories(project: ResolvedKnowledgeProject): void {
  validateResolvedProject(project)
  /** 工作区缓存目录的固定父目录。 */
  const cacheParent = dirname(project.cacheRoot)
  assertActualDirectory(dirname(cacheParent), '知识缓存数据根')
  assertActualDirectory(cacheParent, '知识缓存父目录')
  assertActualDirectory(project.cacheRoot, '缓存根目录')
}

/** 返回权威知识目录，不产生文件系统副作用。 */
export function getKnowledgeRoot(project: ResolvedKnowledgeProject): string {
  return join(project.projectRoot, ...KNOWLEDGE_DIRECTORY_PARTS)
}

/** 返回权威清单路径。 */
export function getManifestPath(project: ResolvedKnowledgeProject): string {
  return join(getKnowledgeRoot(project), 'manifest.json')
}

/** 返回跨进程短临界区锁路径。 */
export function getKnowledgeLockPath(project: ResolvedKnowledgeProject): string {
  return join(getKnowledgeRoot(project), '.knowledge.lock')
}

/** 返回不可变条目版本文件路径。 */
export function getEntryRevisionPath(
  project: ResolvedKnowledgeProject,
  entryId: string,
  revision: string,
): string {
  if (!/^[a-f0-9]{32}$/.test(entryId) || !/^[a-f0-9]{64}$/.test(revision)) {
    throw new Error('知识条目版本定位非法')
  }
  return join(getKnowledgeRoot(project), 'entries', entryId, 'revisions', revision, 'entry.json')
}

/** 返回不可变受管正文路径。 */
export function getEntryContentPath(
  project: ResolvedKnowledgeProject,
  entryId: string,
  revision: string,
): string {
  return join(dirname(getEntryRevisionPath(project, entryId, revision)), 'content.md')
}

/** 返回可重建索引路径。 */
export function getIndexPath(project: ResolvedKnowledgeProject): string {
  return join(project.cacheRoot, 'project-knowledge-index.json')
}

/** 按层创建知识目录，并在每一步拒绝既有符号链接。 */
export function ensureKnowledgeDirectories(project: ResolvedKnowledgeProject): void {
  validateResolvedProject(project)
  /** 从项目根开始逐层建立的目录。 */
  let currentPath = project.projectRoot
  for (const part of KNOWLEDGE_DIRECTORY_PARTS) {
    currentPath = join(currentPath, part)
    if (existsSync(currentPath)) assertActualDirectory(currentPath, '知识库目录')
    else ensureDirectoryDurable(currentPath)
  }
}

/** 只读校验知识目录完整父链，拒绝任一级被替换为符号链接。 */
export function assertKnowledgeDirectories(project: ResolvedKnowledgeProject): void {
  validateResolvedProject(project)
  /** 从项目根逐级复核的现有知识目录。 */
  let currentPath = project.projectRoot
  for (const part of KNOWLEDGE_DIRECTORY_PARTS) {
    currentPath = join(currentPath, part)
    assertActualDirectory(currentPath, '知识库目录')
  }
}

/** 只读校验不可变条目版本的完整父目录链。 */
export function assertEntryRevisionDirectory(
  project: ResolvedKnowledgeProject,
  entryId: string,
  revision: string,
): string {
  assertKnowledgeDirectories(project)
  /** 条目 JSON 的最终路径。 */
  const entryPath = getEntryRevisionPath(project, entryId, revision)
  /** 从 entries 到具体 revision 的全部父目录。 */
  const directories = [
    join(getKnowledgeRoot(project), 'entries'),
    join(getKnowledgeRoot(project), 'entries', entryId),
    join(getKnowledgeRoot(project), 'entries', entryId, 'revisions'),
    dirname(entryPath),
  ]
  for (const directoryPath of directories) assertActualDirectory(directoryPath, '条目版本目录')
  return entryPath
}

/** 按层创建不可变条目目录。 */
export function ensureEntryRevisionDirectory(
  project: ResolvedKnowledgeProject,
  entryId: string,
  revision: string,
): string {
  /** 条目 JSON 的最终路径。 */
  const entryPath = getEntryRevisionPath(project, entryId, revision)
  /** 需要从知识根逐级创建的目录。 */
  const directories = [
    join(getKnowledgeRoot(project), 'entries'),
    join(getKnowledgeRoot(project), 'entries', entryId),
    join(getKnowledgeRoot(project), 'entries', entryId, 'revisions'),
    dirname(entryPath),
  ]
  for (const directoryPath of directories) {
    if (existsSync(directoryPath)) assertActualDirectory(directoryPath, '条目版本目录')
    else ensureDirectoryDurable(directoryPath)
  }
  return entryPath
}

/** 将扫描器生成的相对路径标准化为跨平台 locator。 */
export function normalizeSourceRelativePath(value: string): string {
  /** 统一使用正斜线保存的来源路径。 */
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) throw new Error('来源路径非法')
  /** 路径的各级片段。 */
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('来源路径越界')
  return segments.join('/')
}

/** 在可信来源根内解析 locator，不允许越界。 */
export function resolveSourcePath(rootPath: string, relativePath: string): string {
  /** 已验证的跨平台相对路径。 */
  const normalized = normalizeSourceRelativePath(relativePath)
  /** 当前平台上的绝对来源路径。 */
  const sourcePath = resolve(rootPath, ...normalized.split('/'))
  /** 相对可信根的回查结果。 */
  const checkedRelative = relative(rootPath, sourcePath)
  if (!checkedRelative || checkedRelative.startsWith('..') || isAbsolute(checkedRelative)) {
    throw new Error('来源路径越界')
  }
  /** 逐级复核来源目录链，防止发现后父目录被替换为软链接。 */
  let currentDirectory = rootPath
  assertActualDirectory(currentDirectory, '来源根目录')
  const pathSegments = normalized.split('/')
  for (const segment of pathSegments.slice(0, -1)) {
    currentDirectory = join(currentDirectory, segment)
    assertActualDirectory(currentDirectory, '来源目录')
  }
  return sourcePath
}

/** 从路径派生无扩展名标题。 */
export function titleFromRelativePath(relativePath: string): string {
  /** 文件名最后一段。 */
  const fileName = basename(relativePath)
  /** 最后一个扩展名分隔符。 */
  const extensionIndex = fileName.lastIndexOf('.')
  return extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName
}
