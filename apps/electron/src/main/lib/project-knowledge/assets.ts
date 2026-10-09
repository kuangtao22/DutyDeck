import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import type { KnowledgeAssetCopyInput, KnowledgeAssetCopyResult } from '@proma/shared'
import { ensureDirectoryDurable, syncDirectoryDurable } from '../safe-file'
import { assertActualDirectory, normalizeSourceRelativePath, resolveSourcePath, validateResolvedProject } from './paths'
import { createMetadataRevision } from './source-reader'
import type { ProjectKnowledgeServiceDependencies, ProjectKnowledgeStore } from './types'

/** 单个附件的复制上限，避免主进程一次分配无界 Buffer。 */
const MAX_ASSET_BYTES = 32 * 1024 * 1024
/** 只允许原格式资料和媒体，不接管源码、凭据或可执行文件。 */
const ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif', '.pdf', '.fig', '.sketch', '.psd', '.ai', '.docx', '.xlsx', '.pptx', '.mp4', '.mov', '.mp3', '.wav'])

/** 读取 no-follow 单链接附件；返回字节和用于核对扫描版本的文件身份。 */
function readAsset(filePath: string): { content: Buffer; revision: string } {
  /** 不跟随最终文件符号链接。 */
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    /** 读取前的真实文件身份。 */
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_ASSET_BYTES) throw new Error('附件不是普通文件或超过 32 MiB')
    /** 有界原格式内容，不作文本解析。 */
    const content = readFileSync(descriptor)
    /** 读取期间文件变化必须重新扫描。 */
    const after = fstatSync(descriptor)
    if (content.byteLength > MAX_ASSET_BYTES || createMetadataRevision(before) !== createMetadataRevision(after)) {
      throw new Error('附件读取期间发生变化')
    }
    return { content, revision: createMetadataRevision(after) }
  } finally {
    closeSync(descriptor)
  }
}

/** 在已确认大纲范围内复制登记资产；不覆盖原件或同名不同内容附件。 */
export async function copyKnowledgeAsset(
  dependencies: ProjectKnowledgeServiceDependencies,
  store: ProjectKnowledgeStore,
  input: KnowledgeAssetCopyInput,
): Promise<KnowledgeAssetCopyResult> {
  /** 每次调用重新绑定项目，拒绝迁移前路径。 */
  const project = dependencies.resolveProject(input.workspaceId)
  validateResolvedProject(project)
  /** 规范路径并将归档限定在可迁移资产子目录。 */
  const assetRelativePath = normalizeSourceRelativePath(input.relativePath)
  if (!assetRelativePath.startsWith('assets/') || assetRelativePath.split('/').some((part) => part.startsWith('.'))) {
    throw new Error('附件必须保存在资料库 assets 目录')
  }
  /** 只有锁内成功复制后才返回已落盘结果。 */
  let result: KnowledgeAssetCopyResult | undefined
  await store.transact(project, input.workspaceId, (current) => {
    /** 用户确认的范围及执行进度。 */
    const workflow = current.manifest.workflow
    if (workflow?.paused) throw new Error('知识库流程已暂停')
    if (!workflow?.approved || workflow.approved.revision !== input.planRevision
      || !workflow.outline || workflow.outline.revision !== input.outlineRevision) throw new Error('已确认计划或大纲版本冲突')
    /** 附件必须属于仍在已确认范围内的一个文档。 */
    const item = workflow.outline.items.find((candidate) => candidate.id === input.itemId)
    if (!item || !workflow.approved.groups.some((group) => group.id === item.groupId)) throw new Error('附件对应大纲项不存在')
    /** 宿主从可信登记记录解析源路径，Agent 不能传任意绝对路径。 */
    const source = current.entries.find((entry) => entry.id === input.sourceEntryId)
    if (!source || source.revision !== input.sourceRevision || source.state === 'archived'
      || source.freshness !== 'current' || !source.metadataOnly || source.source.kind !== 'project-file'
      || !source.source.relativePath || current.manifest.excludedSources?.includes(source.source.id)) throw new Error('附件来源不可用或版本已变化')
    /** 原格式扩展名必须保持一致。 */
    const extension = extname(source.source.relativePath).toLowerCase()
    if (!ASSET_EXTENSIONS.has(extension) || extname(assetRelativePath).toLowerCase() !== extension) throw new Error('附件必须保留受支持的原格式')
    /** 来源路径逐级拒绝符号链接。 */
    const sourcePath = resolveSourcePath(project.projectRoot, source.source.relativePath)
    const asset = readAsset(sourcePath)
    if (asset.revision !== source.source.revision) throw new Error('附件来源已变化，请重新扫描')
    /** 库根必须已经由保存大纲创建，不在此隐式接管项目目录。 */
    const rootPath = resolveSourcePath(project.projectRoot, workflow.approved.rootRelativePath)
    assertActualDirectory(rootPath, '资料库目录')
    /** 从可信库根逐级建立 assets 父目录。 */
    let parentPath = rootPath
    for (const part of assetRelativePath.split('/').slice(0, -1)) {
      parentPath = join(parentPath, part)
      if (existsSync(parentPath)) assertActualDirectory(parentPath, '附件目录')
      else ensureDirectoryDurable(parentPath)
    }
    /** 最终归档定位不允许覆盖现有不同内容。 */
    const targetPath = join(rootPath, assetRelativePath)
    const contentRevision = createHash('sha256').update(asset.content).digest('hex')
    if (existsSync(targetPath)) {
      const existing = readAsset(targetPath)
      if (createHash('sha256').update(existing.content).digest('hex') !== contentRevision) throw new Error('同名附件已存在且内容不同')
    } else {
      /** 写临时兄弟文件再原子建立硬链接，目标出现时 link 会失败，不覆盖外部编辑。 */
      const temporaryPath = join(parentPath, `.knowledge-asset-${randomUUID()}.tmp`)
      const descriptor = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      try {
        try {
          writeFileSync(descriptor, asset.content)
          fsyncSync(descriptor)
        } finally {
          closeSync(descriptor)
        }
        linkSync(temporaryPath, targetPath)
      } finally {
        unlinkSync(temporaryPath)
      }
      syncDirectoryDurable(parentPath)
    }
    result = {
      relativePath: assetRelativePath,
      documentRelativePath: relative(dirname(join(rootPath, item.relativePath)), targetPath).replaceAll('\\', '/'),
      contentRevision,
      byteSize: asset.content.byteLength,
    }
    return {}
  })
  if (!result) throw new Error('附件未成功保存')
  return result
}
