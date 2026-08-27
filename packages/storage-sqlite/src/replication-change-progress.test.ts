import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'
import { SqliteReplicationChangeProgressRepository } from './replication-change-progress'

test('replication change progress persists across storage reopen', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    await storage.replication.ensureStream({
      relationshipId: 'rel-1',
      hubId: 'hub-1',
      streamId: 'stream-1',
      generationId: 'gen-1',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
    })

    const progress = new SqliteReplicationChangeProgressRepository(storage.executor)
    await progress.put({
      streamId: 'stream-1',
      generationId: 'gen-1',
      phase: 'bootstrap',
      entityType: 'CanonicalObservation',
      revision: 42,
      throughRevision: 100,
      updatedAt: '2026-08-28T00:00:00.000Z',
    })

    assert.deepEqual(await progress.get({
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
  } finally {
    storage.close()
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
    storage.close()
  }
})
