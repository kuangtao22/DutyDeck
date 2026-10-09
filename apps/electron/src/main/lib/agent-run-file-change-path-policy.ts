/**
 * 判断路径是否属于 DutyDeck 写入项目根的内部知识目录。
 *
 * 仅匹配连续的 `.proma/knowledge` 路径段；其它 `.proma` 项目文件仍属于用户可见改动。
 */
export function isDutyDeckInternalKnowledgePath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return segments.some((segment, index) => segment === '.proma' && segments[index + 1] === 'knowledge')
}

/** 本轮文件统计只保留用户项目文件，排除 DutyDeck 自身的知识持久化写入。 */
export function shouldTrackAgentRunFilePath(path: string): boolean {
  return !isDutyDeckInternalKnowledgePath(path)
}
