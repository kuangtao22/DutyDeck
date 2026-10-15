import { posix, win32 } from 'node:path'

/** 数据根命名空间；不与旧 Chat 的附件相对路径或系统绝对路径混用。 */
const DATA_ROOT_REFERENCE_PREFIX = 'dutydeck-data:/'

/** 宿主向独立 Agent runtime 传递的固定根快照，不允许 runtime 从 cwd 猜测位置。 */
export interface DataRootPathSnapshot {
  /** 已验证的活动数据根。 */
  activeRoot: string
  /** 仅用于旧引用映射的历史根。 */
  historicalRoots: string[]
}

/** 固定数据根快照的无 I/O 编解码器；解析不代表授予文件读取权限。 */
export interface DataRootReferenceCodec {
  /** 将受管绝对路径转换为持久化引用，外部路径保持原样。 */
  serialize(path: string): string
  /** 将引用或已知旧根路径恢复为当前绝对路径，供调用方继续验证权限。 */
  resolve(path: string): string
}

/** 判断字符串是否声明了受管数据根命名空间，实际内容由解码器严格校验。 */
export function isDataRootReference(path: string): boolean {
  return path.startsWith(DATA_ROOT_REFERENCE_PREFIX)
}

/**
 * 创建固定根的路径转换器，不检查文件存在性、不扫描目录。
 * @param activeRoot 当前数据根绝对路径。
 * @param historicalRoots 已知历史根，仅作为别名，不能用于回退读取。
 * @returns 保存相对引用和恢复当前绝对路径的一对纯函数。
 */
export function createDataRootReferenceCodec(activeRoot: string, historicalRoots: readonly string[] = []): DataRootReferenceCodec {
  /** 按根目录选择平台语义，允许离线验证跨平台引用。 */
  const api = /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]/.test(activeRoot) ? win32 : posix
  if (!api.isAbsolute(activeRoot)) throw new Error('数据根引用需要绝对根目录')
  /** 根仅规范化一次，转换单条路径时没有定位器或磁盘 I/O。 */
  const root = api.resolve(activeRoot)
  const previousRoots = [...new Set(historicalRoots)].filter((path) => api.isAbsolute(path))
    .map((path) => api.resolve(path)).sort((left, right) => right.length - left.length)

  /** 返回根内相对位置；同名前缀和根外路径不属于受管数据。 */
  const relativeWithin = (base: string, path: string): string | undefined => {
    const suffix = api.relative(base, path)
    return suffix !== '..' && !suffix.startsWith(`..${api.sep}`) && !api.isAbsolute(suffix) ? suffix : undefined
  }

  /** 验证原始分段后再拼接，避免 URL 解析器预先折叠 .. 或解码分隔符。 */
  const decode = (reference: string): string => {
    const suffix = reference.slice(DATA_ROOT_REFERENCE_PREFIX.length)
    if (!suffix) return root
    try {
      const segments = suffix.split('/').map((segment) => decodeURIComponent(segment))
      if (segments.some((segment) => !segment || segment === '.' || segment === '..'
        || /[\\/\u0000-\u001f\u007f]/.test(segment) || (api === win32 && segment.includes(':')))) {
        throw new Error('无效路径分段')
      }
      return api.join(root, ...segments)
    } catch {
      throw new Error('无效的数据根引用')
    }
  }

  /** 旧根严格后代才映射；普通相对路径留给其所属业务解析。 */
  const resolvePath = (path: string): string => {
    if (isDataRootReference(path)) return decode(path)
    if (!api.isAbsolute(path) || relativeWithin(root, path) !== undefined) return path
    for (const previousRoot of previousRoots) {
      const suffix = relativeWithin(previousRoot, path)
      if (suffix) return api.join(root, suffix)
    }
    return path
  }

  return {
    resolve: resolvePath,
    serialize: (path) => {
      /** 已有引用也复核语法，规范编码只进行一次。 */
      const resolved = resolvePath(path)
      if (!api.isAbsolute(resolved)) return path
      const suffix = relativeWithin(root, resolved)
      if (suffix === undefined) return path
      const reference = DATA_ROOT_REFERENCE_PREFIX + (suffix ? suffix.split(api.sep).map(encodeURIComponent).join('/') : '')
      // 编码结果必须能安全往返，拒绝宿主平台的控制字符及特殊分隔语义。
      decode(reference)
      return reference
    },
  }
}
