import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureStorageWorkspace } from './storage-size'

describe('storage workspace measurement', () => {
  it('Given preserved files and removable artifacts When scanning Then both sizes share one file set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proma-storage-size-'))
    try {
      await mkdir(join(root, '.context'))
      await mkdir(join(root, 'node_modules'))
      await writeFile(join(root, '.context', 'notes.json'), 'keep')
      await writeFile(join(root, 'note.md'), 'memo')
      await writeFile(join(root, 'node_modules', 'package.js'), 'artifact')
      await writeFile(join(root, 'run.log'), 'log')

      const size = await measureStorageWorkspace(root)
      expect(size).toMatchObject({ bytes: 19, count: 4, removableBytes: 11, removableCount: 2, truncated: false })
      expect(size.removableBytes).toBeLessThanOrEqual(size.bytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('Given a symlink to another directory When scanning Then external bytes stay excluded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proma-storage-size-'))
    const external = await mkdtemp(join(tmpdir(), 'proma-storage-external-'))
    try {
      await writeFile(join(external, 'secret'), 'external')
      await symlink(external, join(root, 'linked'))
      await writeFile(join(root, 'local'), 'local')

      expect(await measureStorageWorkspace(root)).toMatchObject({ bytes: 5, count: 1, removableBytes: 5, truncated: false })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(external, { recursive: true, force: true })
    }
  })
})
