/** watcher 统计中不应占用预算的构建、依赖和 IDE 状态目录。 */
const AGENT_RUN_FILE_NOISE_SEGMENTS = new Set([
  '.build', '.swiftpm', 'xcuserdata', 'deriveddata', 'sourcepackages',
  'pods', 'carthage',
])

/**
 * 判断路径是否属于 DutyDeck 写入项目根的内部知识目录。
 *
 * 仅匹配连续的 `.proma/knowledge` 路径段；其它 `.proma` 项目文件仍属于用户可见改动。
 */
export function isDutyDeckInternalKnowledgePath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return segments.some((segment, index) => segment === '.proma' && segments[index + 1] === 'knowledge')
}

/**
 * 判断监听事件是否来自构建/依赖工具的高噪声路径。
 *
 * 这些路径仍可由用户明确通过 write/edit 统计；这里只用于过滤 watcher 候选，
 * 避免编译、依赖解析和 IDE 状态文件占满本轮统计预算。
 *
 * @param path 监听器报告的绝对或相对路径。
 * @returns 是否应从 watcher 统计中忽略。
 */
export function isAgentRunFileNoisePath(path: string): boolean {
  /** 路径分段统一小写，兼容 macOS/Windows 的目录大小写差异。 */
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean).map(segment => segment.toLowerCase())
  if (segments.some(segment => AGENT_RUN_FILE_NOISE_SEGMENTS.has(segment))) return true

  // ParsingBook 等项目把 SwiftPM 检出放在 Frameworks/checkouts；只过滤这组明确的
  // 依赖目录，保留用户可能直接维护的普通 Frameworks 源码。
  return segments.some((segment, index) => segment === 'frameworks' && segments[index + 1] === 'checkouts')
}

/** 本轮文件统计只保留用户项目文件，排除 DutyDeck 自身的知识持久化写入。 */
export function shouldTrackAgentRunFilePath(path: string): boolean {
  return !isDutyDeckInternalKnowledgePath(path)
}

/** watcher 统计的路径边界：排除宿主知识目录和高噪声构建/依赖事件。 */
export function shouldTrackAgentFileObservationPath(path: string): boolean {
  return shouldTrackAgentRunFilePath(path) && !isAgentRunFileNoisePath(path)
}
