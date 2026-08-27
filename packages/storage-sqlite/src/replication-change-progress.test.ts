import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteStorageService } from './storage'
import { SqliteReplicationChangeProgressRepository } from './replication-change-progress'

test('replication change progress persists across storage reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lens-replication-progress-'))
  const path = join(dir, 'agent-lens.db')
  try {
    const first = new SqliteStorageService({ path })
    await first.migrate()
    await first.replication.ensureStream({
      relationshipId: 'rel-1',
      hubId: 'hub-1',
      streamId: 'stream-1',
      generationId: 'gen-1',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
    })
    const firstProgress = new SqliteReplicationChangeProgressRepository(first.executor)
    await firstProgress.put({
      streamId: 'stream-1',
      generationId: 'gen-1',
      phase: 'bootstrap',
      entityType: 'CanonicalObservation',
      revision: 42,
      throughRevision: 100,
      updatedAt: '2026-08-28T00:00:00.000Z',
    })
    await first.close()

    const reopened = new SqliteStorageService({ path })
    const reopenedProgress = new SqliteReplicationChangeProgressRepository(reopened.executor)
    assert.deepEqual(await reopenedProgress.get({
      streamId: 'stream-1',
      generationId: 'gen-1',
      phase: 'bootstrap',
      entityType: 'CanonicalObservation',
    }), {
      streamId: 'stream-1',
      generationId: 'gen-1',
      phase: 'bootstrap',
      entityType: 'CanonicalObservation',
      revision: 42,
      throughRevision: 100,
      updatedAt: '2026-08-28T00:00:00.000Z',
    })
    await reopened.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('replication change progress rejects cursor beyond fixed high-water', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const progress = new SqliteReplicationChangeProgressRepository(storage.executor)
    await assert.rejects(progress.put({
      streamId: 'stream-1',
      generationId: 'gen-1',
      phase: 'bootstrap',
      entityType: 'CanonicalObservation',
      revision: 101,
      throughRevision: 100,
      updatedAt: '2026-08-28T00:00:00.000Z',
    }), /throughRevision must be >= revision/)
  } finally {
    await storage.close()
  }
})
