import { describe, expect, test } from 'bun:test'
import { buildStorageProjectUsage, type StorageSessionUsageInput } from './storage-usage'

function createSession(overrides: Partial<StorageSessionUsageInput>): StorageSessionUsageInput {
  return {
    sessionId: 'session-default',
    title: '默认会话',
    workspaceSlug: 'project-a',
    workspaceName: '项目 A',
    transcriptBytes: 100,
    workspaceBytes: 50,
    updatedAt: 1_000,
    archived: false,
    ...overrides,
  }
}

describe('storage usage grouping', () => {
  test('Given multiple sessions When grouped Then project totals and session sizes are accurate', () => {
    const result = buildStorageProjectUsage([
      createSession({ sessionId: 'small', transcriptBytes: 10, workspaceBytes: 5, updatedAt: 2_000 }),
      createSession({ sessionId: 'large', transcriptBytes: 300, workspaceBytes: 100, updatedAt: 1_000 }),
      createSession({
        sessionId: 'unassigned',
        workspaceSlug: undefined,
        workspaceName: undefined,
        transcriptBytes: 20,
        workspaceBytes: 0,
      }),
    ])

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ projectId: 'project-a', projectName: '项目 A', totalBytes: 415, sessionCount: 2 })
    expect(result[0]?.sessions.map((session) => session.sessionId)).toEqual(['large', 'small'])
    expect(result[1]).toMatchObject({ projectId: '__unassigned__', projectName: '未关联项目', totalBytes: 20, sessionCount: 1 })
  })

  test('Given sessions with invalid negative sizes When grouped Then negative values do not reduce totals', () => {
    const [project] = buildStorageProjectUsage([
      createSession({ transcriptBytes: -20, workspaceBytes: -5 }),
    ])

    expect(project?.totalBytes).toBe(0)
    expect(project?.sessions[0]).toMatchObject({ bytes: 0, transcriptBytes: 0, workspaceBytes: 0 })
  })
})
