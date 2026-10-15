/**
 * 附件存储服务
 *
 * 负责文件附件的本地存储、读取和删除。
 * 存储路径：当前数据根/attachments/{conversationId}/{uuid}.ext
 *
 * - 保存：base64 解码 → 写入文件
 * - 读取：文件 → base64 编码（用于 API 发送）
 * - 删除：单个文件或整个对话附件目录
 * - 文件选择对话框：Electron dialog → 小文件读取为 base64，大文件返回本地路径引用
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, rmSync, statSync, realpathSync, lstatSync } from 'node:fs'
import { extname, basename, join, isAbsolute, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dialog, BrowserWindow } from 'electron'
import {
  getConfigDir,
  createDataRootPathSerializer,
  getConversationAttachmentsDir,
  resolveAttachmentPath,
} from './config-paths'
import type { ConfigRootResolver } from './config-paths'
import { isDataRootReference } from './data-root-reference'
import { openAuthorizedAgentMediaSource } from './design/design-session-bridge'
import type {
  FileAttachment,
  AttachmentSaveInput,
  AttachmentSaveResult,
  FileDialogResult,
  FileDialogFile,
  FileDialogLargeFile,
  FileDialogSkippedFile,
  FileDialogDirectory,
  FileOrFolderDialogResult,
} from '@proma/shared'
import { MAX_ATTACHMENT_SIZE } from '@proma/shared'

/** 支持的图片 MIME 类型 */
const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/** 扩展名 → MIME 类型映射 */
const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.dot': 'application/msword',
  '.wps': 'application/vnd.ms-works',
  '.wpt': 'application/vnd.ms-works',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.docm': 'application/vnd.ms-word.document.macroEnabled.12',
  '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  '.dotm': 'application/vnd.ms-word.template.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.xlt': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xltx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  '.xltm': 'application/vnd.ms-excel.template.macroEnabled.12',
  '.et': 'application/vnd.ms-excel',
  '.ett': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pot': 'application/vnd.ms-powerpoint',
  '.pps': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  '.potx': 'application/vnd.openxmlformats-officedocument.presentationml.template',
  '.potm': 'application/vnd.ms-powerpoint.template.macroEnabled.12',
  '.ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  '.ppsm': 'application/vnd.ms-powerpoint.slideshow.macroEnabled.12',
  '.dps': 'application/vnd.ms-powerpoint',
  '.dpt': 'application/vnd.ms-powerpoint',
  '.rtf': 'application/rtf',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
}

/** 文件选择对话框支持的过滤器 */
const FILE_FILTERS = [
  {
    name: '支持的文件',
    extensions: [
      'png', 'jpg', 'jpeg', 'gif', 'webp',
      'pdf', 'txt', 'md', 'json', 'csv', 'xml', 'html',
      'doc', 'dot', 'docx', 'docm', 'dotx', 'dotm', 'wps', 'wpt', 'rtf',
      'xls', 'xlt', 'xlsx', 'xlsm', 'xltx', 'xltm', 'et', 'ett',
      'ppt', 'pot', 'pps', 'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm', 'dps', 'dpt',
      'odt', 'odp', 'ods',
    ],
  },
  {
    name: '所有文件',
    extensions: ['*'],
  },
]

/**
 * 判断是否为图片附件
 */
export function isImageAttachment(mediaType: string): boolean {
  return IMAGE_MIME_TYPES.has(mediaType)
}

/**
 * 根据扩展名获取 MIME 类型
 */
export function getMimeType(ext: string): string {
  const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  return MIME_MAP[normalized] || 'application/octet-stream'
}

/**
 * 保存附件到本地
 *
 * 将 base64 编码的文件数据解码后写入
 * 当前数据根/attachments/{conversationId}/{uuid}.ext
 *
 * @param input 保存附件参数
 * @param resolver 可选独立数据根定位器，默认使用生产定位器
 * @returns 保存结果，包含附件元信息
 */
export function saveAttachment(input: AttachmentSaveInput, resolver?: ConfigRootResolver): AttachmentSaveResult {
  const { conversationId, filename, mediaType, data } = input

  // 防御性检查：base64 数据量不应超过 100MB 限制
  // base64 字符串长度 × 0.75 ≈ 原始字节数
  if (data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
    throw new Error(`文件 ${filename} 超过 100MB 大小限制，无法保存`)
  }

  // 确保目录存在
  const dir = getConversationAttachmentsDir(conversationId, resolver)

  // 生成唯一文件名
  const ext = extname(filename) || '.bin'
  const id = randomUUID()
  const storedFilename = `${id}${ext}`
  const fullPath = join(dir, storedFilename)
  /** 持久化显式数据根引用，迁移无需重写附件元数据。 */
  const localPath = createDataRootPathSerializer(resolver)(fullPath)

  // base64 解码并写入
  const buffer = Buffer.from(data, 'base64')
  writeFileSync(fullPath, buffer)

  const attachment: FileAttachment = {
    id,
    filename,
    mediaType,
    localPath,
    size: buffer.length,
  }

  console.log(`[附件服务] 已保存附件: ${filename} → ${localPath} (${buffer.length} 字节)`)
  return { attachment }
}

/**
 * 读取附件并返回 base64 编码
 *
 * 支持三种路径格式：
 * 1. 相对路径 {conversationId}/{uuid}.ext → 当前数据根的 attachments/
 * 2. Agent 绝对路径 → 已知旧根先映射到当前根，再复核实际文件的授权边界
 * 3. dutydeck-data:/ 数据根引用 → 当前根下对应文件
 *
 * @param localPath 相对路径或绝对路径
 * @param resolver 可选的独立定位器，用于隔离测试；生产使用进程固定定位器
 * @returns base64 编码的文件数据
 */
export function readAttachmentAsBase64(localPath: string, resolver?: ConfigRootResolver): string {
  return readAttachmentBytes(localPath, resolver).toString('base64')
}

/** 从受控附件引用读取稳定字节，供预览和文档解析共享安全边界。 */
export function readAttachmentBytes(localPath: string, resolver?: ConfigRootResolver): Buffer {
  /** 历史根只作别名；所有字节最终必须来自当前根。 */
  const configDir = getConfigDir(resolver)
  const absolute = isAbsolute(localPath) || isDataRootReference(localPath)
  const allowedRoot = absolute ? configDir : join(configDir, 'attachments')
  const fullPath = resolveAttachmentPath(localPath, resolver)
  /** 先做词法边界检查，再由稳定句柄检查 realpath 和文件身份。 */
  const suffix = relative(allowedRoot, fullPath)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`附件路径不在安全目录内: ${localPath}`)
  }

  if (!existsSync(fullPath)) {
    throw new Error(`附件文件不存在: ${localPath}`)
  }

  /** attachments 根本身也不能通过目录链接将读取权限扩展到数据根之外。 */
  if (!absolute) assertAttachmentDescendant(realpathSync(configDir), realpathSync(allowedRoot))
  /** 复用媒体读取的 no-follow、普通文件、大小及读取前后身份验证。 */
  const source = openAuthorizedAgentMediaSource({ inputPath: fullPath, baseDir: configDir,
    allowedRoots: [allowedRoot], maxBytes: MAX_ATTACHMENT_SIZE, label: '媒体' })
  try {
    return source.readBytes()
  } finally {
    source.close()
  }
}

/** 校验候选路径为授权根的严格后代；不以同名前缀代替目录边界。 */
function assertAttachmentDescendant(root: string, candidate: string): void {
  /** 相对后缀不可为空、向上穿越或指向另一驱动器。 */
  const suffix = relative(root, candidate)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('附件路径不在安全目录内')
  }
}

/**
 * 删除单个附件
 *
 * @param localPath 新数据根引用或旧 Chat 路径；只能删除 attachments 下的文件
 * @param resolver 可选独立数据根定位器
 */
export function deleteAttachment(localPath: string, resolver?: ConfigRootResolver): void {
  /** 删除权限只覆盖 Chat 附件，不能扩大至整个业务数据根。 */
  const fullPath = resolveAttachmentPath(localPath, resolver)
  const root = join(getConfigDir(resolver), 'attachments')
  assertAttachmentDescendant(root, fullPath)
  if (existsSync(fullPath)) {
    assertAttachmentDescendant(realpathSync(root), realpathSync(fullPath))
    assertAttachmentDescendant(realpathSync(getConfigDir(resolver)), realpathSync(fullPath))
    if (lstatSync(fullPath).isSymbolicLink()) throw new Error('附件路径不能是符号链接')
  }

  if (existsSync(fullPath)) {
    try {
      unlinkSync(fullPath)
      console.log(`[附件服务] 已删除附件: ${localPath}`)
    } catch (error) {
      console.warn(`[附件服务] 删除附件失败: ${localPath}`, error)
    }
  }
}

/**
 * 删除对话的全部附件
 *
 * 删除整个当前数据根/attachments/{conversationId}/ 目录。
 *
 * @param conversationId 对话 ID
 */
export function deleteConversationAttachments(conversationId: string): void {
  const dir = join(resolveAttachmentPath(''), conversationId)

  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true })
      console.log(`[附件服务] 已删除对话附件目录: ${conversationId}`)
    } catch (error) {
      console.warn(`[附件服务] 删除对话附件目录失败: ${conversationId}`, error)
    }
  }
}

function readDialogFiles(
  filePaths: string[],
  directories?: FileDialogDirectory[],
): FileDialogResult {
  const files: FileDialogFile[] = []
  const largeFiles: FileDialogLargeFile[] = []
  const skippedFiles: FileDialogSkippedFile[] = []

  for (const filePath of filePaths) {
    const filename = basename(filePath)
    const ext = extname(filePath)
    const mediaType = getMimeType(ext)

    let fileSize: number
    try {
      const fileStat = statSync(filePath)
      if (directories && fileStat.isDirectory()) {
        directories.push({ name: filename || 'folder', path: filePath })
        continue
      }
      if (!fileStat.isFile()) {
        skippedFiles.push({
          filename,
          mediaType,
          path: filePath,
          reason: 'unreadable',
          message: '不是普通文件',
        })
        continue
      }
      fileSize = fileStat.size
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法获取文件大小'
      console.warn(`[附件服务] 无法获取文件大小，跳过: ${filePath}`, error)
      skippedFiles.push({ filename, mediaType, path: filePath, reason: 'unreadable', message })
      continue
    }

    if (fileSize > MAX_ATTACHMENT_SIZE) {
      largeFiles.push({
        filename,
        mediaType,
        size: fileSize,
        path: filePath,
      })
      continue
    }

    try {
      const buffer = readFileSync(filePath)
      files.push({
        filename,
        mediaType,
        data: buffer.toString('base64'),
        size: buffer.length,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取文件失败'
      console.warn(`[附件服务] 读取文件失败，跳过: ${filePath}`, error)
      skippedFiles.push({ filename, mediaType, size: fileSize, path: filePath, reason: 'unreadable', message })
    }
  }

  return {
    files,
    ...(largeFiles.length > 0 && { largeFiles }),
    ...(skippedFiles.length > 0 && { skippedFiles }),
  }
}

/**
 * 打开文件选择对话框
 *
 * 弹出 Electron 文件选择对话框，支持多选，
 * 读取选中的小文件并返回 base64 编码数据；超过内存导入上限的大文件仅返回路径。
 *
 * @returns 选中的文件列表
 */
export async function openFileDialog(): Promise<FileDialogResult> {
  // macOS 上必须传入父窗口，否则对话框可能出现在应用窗口后面
  const parentWindow = BrowserWindow.getFocusedWindow()
  const dialogOptions: Electron.OpenDialogOptions = {
    properties: ['openFile', 'multiSelections'],
    filters: FILE_FILTERS,
  }

  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)

  if (result.canceled || result.filePaths.length === 0) {
    return { files: [] }
  }

  const fileResult = readDialogFiles(result.filePaths)
  console.log(`[附件服务] 文件对话框选择了 ${fileResult.files.length} 个内存附件，${fileResult.largeFiles?.length ?? 0} 个大文件引用，${fileResult.skippedFiles?.length ?? 0} 个跳过`)
  return fileResult
}

/**
 * 打开 Agent Composer 的混合选择对话框。
 * 文件按附件语义读取，文件夹只返回路径，交由会话目录授权流程处理。
 */
export async function openFileOrFolderDialog(): Promise<FileOrFolderDialogResult> {
  const parentWindow = BrowserWindow.getFocusedWindow()
  let dialogOptions: Electron.OpenDialogOptions

  if (process.platform === 'win32' || process.platform === 'linux') {
    const choiceOptions: Electron.MessageBoxOptions = {
      type: 'question',
      title: '附加文件或文件夹',
      message: '请选择要附加的内容类型',
      buttons: ['文件', '文件夹', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    }
    const choice = parentWindow
      ? await dialog.showMessageBox(parentWindow, choiceOptions)
      : await dialog.showMessageBox(choiceOptions)
    if (choice.response === 2) return { files: [], directories: [] }

    dialogOptions = choice.response === 0
      ? { properties: ['openFile', 'multiSelections'], filters: FILE_FILTERS, title: '附加文件' }
      : { properties: ['openDirectory', 'multiSelections'], title: '附加文件夹' }
  } else {
    dialogOptions = {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      title: '附加文件或文件夹',
    }
  }

  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)

  if (result.canceled || result.filePaths.length === 0) {
    return { files: [], directories: [] }
  }

  const directories: FileDialogDirectory[] = []
  const fileResult = readDialogFiles(result.filePaths, directories)
  console.log(`[附件服务] 混合对话框选择了 ${fileResult.files.length} 个内存附件，${fileResult.largeFiles?.length ?? 0} 个大文件引用，${directories.length} 个目录，${fileResult.skippedFiles?.length ?? 0} 个跳过`)
  return { ...fileResult, directories }
}
