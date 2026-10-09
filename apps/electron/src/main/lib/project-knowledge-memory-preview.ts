import type { KnowledgeMemoryOrganizationPreview } from '@proma/shared'
import type { ProjectKnowledgeIpcService } from './project-knowledge-ipc'

/** 在最多 100 个已登记条目与 256 KiB 总正文内，预览旧记忆的混合主题。 */
export async function previewKnowledgeMemory(
  workspaceId: string,
  service: Pick<ProjectKnowledgeIpcService, 'search' | 'read'>,
): Promise<KnowledgeMemoryOrganizationPreview> {
  const result: KnowledgeMemoryOrganizationPreview = { projectId: workspaceId, inspected: 0, truncated: false, proposals: [] }
  const directory = await service.search({ workspaceId, query: '', limit: 100 })
  result.truncated = directory.nextOffset !== undefined
  let bytes = 0
  for (const { entry } of directory.items) {
    if (entry.source.kind !== 'memory-file') continue
    if (bytes + 24 * 1024 > 256 * 1024) { result.truncated = true; break }
    const page = await service.read({ workspaceId, entryId: entry.id, expectedRevision: entry.revision })
    result.inspected += 1
    if (page.status !== 'readable') continue
    bytes += Buffer.byteLength(page.content)
    const sections = [...page.content.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]!.trim()).slice(0, 30)
    if (sections.length < 3 && !page.truncated) continue
    result.proposals.push({ entryId: entry.id, revision: entry.revision, title: entry.title,
      relativePath: entry.source.relativePath ?? entry.title, sections, truncated: page.truncated })
  }
  return result
}
