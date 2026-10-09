import { PROJECT_KNOWLEDGE_IPC_CHANNELS } from '@proma/shared'
import type { KnowledgeMemoryOrganizationPreview, KnowledgeReadResult, KnowledgeSearchResult, KnowledgeSnapshot, ProjectKnowledgeApi } from '@proma/shared'

/** 创建知识库窄桥接；参数合法性与访问范围由主进程核验。 */
export function createProjectKnowledgePreload(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
): ProjectKnowledgeApi {
  return {
    confirmProjectKnowledgePlan: (input) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.CONFIRM_PLAN, input) as Promise<KnowledgeSnapshot>,
    pauseProjectKnowledgeWorkflow: (input) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.PAUSE_WORKFLOW, input) as Promise<KnowledgeSnapshot>,
    getProjectKnowledgeSnapshot: (workspaceId) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.SNAPSHOT, { workspaceId }) as Promise<KnowledgeSnapshot>,
    scanProjectKnowledge: (workspaceId) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.SCAN, { workspaceId }) as Promise<KnowledgeSnapshot>,
    cancelProjectKnowledgeScan: (workspaceId) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.CANCEL_SCAN, { workspaceId }) as Promise<KnowledgeSnapshot>,
    searchProjectKnowledge: (input) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.SEARCH, input) as Promise<KnowledgeSearchResult>,
    readProjectKnowledge: (input) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.READ, input) as Promise<KnowledgeReadResult>,
    updateProjectKnowledgeMaintenance: (input) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.MAINTENANCE, input) as Promise<KnowledgeSnapshot>,
    retryProjectKnowledgeMaintenance: (workspaceId) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.RETRY, { workspaceId }) as Promise<KnowledgeSnapshot>,
    reviewProjectKnowledge: (input) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.REVIEW, input) as Promise<KnowledgeSnapshot>,
    organizeProjectKnowledge: (workspaceId) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.ORGANIZE, { workspaceId }) as Promise<KnowledgeSnapshot>,
    undoProjectKnowledgeOperation: (workspaceId, operationId) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.UNDO, { workspaceId, operationId }) as Promise<KnowledgeSnapshot>,
    excludeProjectKnowledgeSession: (workspaceId, sessionId) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.EXCLUDE_SESSION, { workspaceId, sessionId }) as Promise<KnowledgeSnapshot>,
    previewProjectKnowledgeMemory: (workspaceId) => invoke(PROJECT_KNOWLEDGE_IPC_CHANNELS.PREVIEW_MEMORY, { workspaceId }) as Promise<KnowledgeMemoryOrganizationPreview>,
  }
}
