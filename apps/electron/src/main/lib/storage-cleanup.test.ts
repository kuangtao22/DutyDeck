import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  executeStorageCleanup,
  previewStorageCleanup,
  type StorageCleanupContext,
  type StorageCleanupSessionSnapshot,
} from './storage-cleanup'

const NOW = 1_800_000_000_000
const OLD_TIME = NOW - 60 * 24 * 60 * 60 * 1000

async function createContext(
  root: string,
  sessions: StorageCleanupSessionSnapshot[],
  runningSessionIds = new Set<string>(),
): Promise<StorageCleanupContext> {
  const agentSessionsDir = join(root, 'agent-sessions')
  const agentWorkspacesDir = join(root, 'agent-workspaces')
  const piSessionsDir = join(root, 'sdk-config', 'sessions')
  await Promise.all([
    mkdir(agentSessionsDir, { recursive: true }),
    mkdir(agentWorkspacesDir, { recursive: true }),
    mkdir(piSessionsDir, { recursive: true }),
  ])
  return {
    agentSessionsDir,
    agentWorkspacesDir,
    piSessionsDir,
    sessions,
    runningSessionIds,
    deleteAgentSession: (sessionId) => {
      const index = sessions.findIndex((session) => session.id === sessionId)
      if (index >= 0) sessions.splice(index, 1)
    },
    getCurrentSessions: () => sessions,
    getRunningSessionIds: () => runningSessionIds,
  }
}

async function setOld(path: string): Promise<void> {
  await utimes(path, OLD_TIME / 1000, OLD_TIME / 1000)
}

describe('storage cleanup', () => {
  it('does not preview active or busy sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proma-storage-cleanup-'))
    try {
      const sessions: StorageCleanupSessionSnapshot[] = [
        { id: 'active', archived: false, updatedAt: OLD_TIME, workspaceSlug: 'default' },
        { id: 'busy', archived: true, updatedAt: OLD_TIME, workspaceSlug: 'default' },
      ]
      const context = await createContext(root, sessions, new Set(['busy']))
      for (const id of ['active', 'busy']) {
        const path = join(context.agentSessionsDir, `${id}.jsonl`)
        await writeFile(path, '{}\n')
        await setOld(path)
      }

      const preview = await previewStorageCleanup(context, {
        mode: 'archived',
        beforeDays: 30,
        gracePeriodMs: 30 * 24 * 60 * 60 * 1000,
      }, NOW)
      expect(preview.candidates).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('Given archived starred and pinned sessions When previewing Then neither becomes a cleanup candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proma-storage-cleanup-'))
    try {
      const sessions: StorageCleanupSessionSnapshot[] = [
        { id: 'starred', archived: true, starred: true, updatedAt: OLD_TIME },
        { id: 'pinned', archived: true, pinned: true, updatedAt: OLD_TIME },
      ]
      const context = await createContext(root, sessions)
      for (const session of sessions) {
        const path = join(context.agentSessionsDir, `${session.id}.jsonl`)
        await writeFile(path, '{}\n')
        await setOld(path)
      }
      const preview = await previewStorageCleanup(context, { mode: 'archived', beforeDays: 0 }, NOW)
      expect(preview.candidates).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('Given a session protected after preview When cleanup executes Then its files remain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proma-storage-cleanup-'))
    try {
      const sessions: StorageCleanupSessionSnapshot[] = [
        { id: 'protected-later', archived: true, updatedAt: OLD_TIME },
      ]
      const context = await createContext(root, sessions)
      const path = join(context.agentSessionsDir, 'protected-later.jsonl')
      await writeFile(path, '{}\n')
      await setOld(path)
      const preview = await previewStorageCleanup(context, { mode: 'archived', beforeDays: 0 }, NOW)
      sessions[0] = { ...sessions[0]!, starred: true }

      const result = await executeStorageCleanup({ ...preview, operationId: 'protected-later' }, context, preview.candidates.map((candidate) => candidate.id))
      expect(result.deletedCount).toBe(0)
      expect(result.skippedCount).toBeGreaterThan(0)
      expect(await Bun.file(path).exists()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('protects a Pi artifact while another indexed session still references it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proma-storage-cleanup-'))
    try {
      const artifactPath = join(root, 'sdk-config', 'sessions', 'shared.jsonl')
      const sessions: StorageCleanupSessionSnapshot[] = [
        { id: 'first', archived: true, updatedAt: OLD_TIME, piSessionFile: artifactPath },
        { id: 'second', archived: true, updatedAt: OLD_TIME, piSessionFile: artifactPath },
      ]
      const context = await createContext(root, sessions)
      for (const id of ['first', 'second']) {
        const path = join(context.agentSessionsDir, `${id}.jsonl`)
        await writeFile(path, '{}\n')
        await setOld(path)
      }
      await writeFile(artifactPath, '{}\n')
      await setOld(artifactPath)

      const preview = await previewStorageCleanup(context, {
        mode: 'archived',
        beforeDays: 30,
        gracePeriodMs: 30 * 24 * 60 * 60 * 1000,
      }, NOW)
      const firstOnly = preview.candidates
        .filter((candidate) => candidate.sessionId === 'first')
        .map((candidate) => candidate.id)
      const result = await executeStorageCleanup({ ...preview, operationId: 'test-shared' }, context, firstOnly)

      expect(result.errors).toHaveLength(0)
      expect(await Bun.file(artifactPath).exists()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips a session changed after preview confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proma-storage-cleanup-'))
    try {
      const sessions: StorageCleanupSessionSnapshot[] = [
        { id: 'changed', archived: true, updatedAt: OLD_TIME, workspaceSlug: 'default' },
      ]
      const context = await createContext(root, sessions)
      const path = join(context.agentSessionsDir, 'changed.jsonl')
      await writeFile(path, '{}\n')
      await setOld(path)
      const preview = await previewStorageCleanup(context, {
        mode: 'archived',
        beforeDays: 30,
        gracePeriodMs: 30 * 24 * 60 * 60 * 1000,
      }, NOW)
      sessions[0] = { ...sessions[0]!, archived: false, updatedAt: NOW }

      const result = await executeStorageCleanup({ ...preview, operationId: 'test-race' }, context, preview.candidates.map((candidate) => candidate.id))
      expect(result.deletedCount).toBe(0)
      expect(result.skippedCount).toBeGreaterThan(0)
      expect(await Bun.file(path).exists()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('deletes orphan JSONL only in explicit orphan mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proma-storage-cleanup-'))
    try {
      const sessions: StorageCleanupSessionSnapshot[] = []
      const context = await createContext(root, sessions)
      const path = join(context.agentSessionsDir, 'orphan.jsonl')
      await writeFile(path, '{}\n')
      await setOld(path)
      const preview = await previewStorageCleanup(context, {
        mode: 'orphaned',
        beforeDays: 30,
        gracePeriodMs: 30 * 24 * 60 * 60 * 1000,
      }, NOW)
      expect(preview.candidates.some((candidate) => candidate.sessionId === 'orphan')).toBe(true)
      const result = await executeStorageCleanup({ ...preview, operationId: 'test-orphan' }, context, preview.candidates.map((candidate) => candidate.id))
      expect(result.deletedCount).toBe(1)
      expect(await Bun.file(path).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
