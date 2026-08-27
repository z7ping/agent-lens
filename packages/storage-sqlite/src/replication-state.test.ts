import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DurableReplicationError } from '@agent-lens/core/replication'
import { SqliteStorageService } from './storage'

const T0 = '2026-08-28T00:00:00.000Z'
const T1 = '2026-08-28T00:01:00.000Z'
const T2 = '2026-08-28T00:02:00.000Z'

async function createStorage(path: string): Promise<SqliteStorageService> {
  const storage = new SqliteStorageService({ path })
  await storage.migrate()
  return storage
}

test('pending enqueue is idempotent and mutable only before freeze', async () => {
  const storage = await createStorage(':memory:')
  try {
    await storage.replication.ensureStream({
      relationshipId: 'rel-1',
      hubId: 'hub-1',
      streamId: 'stream-1',
      generationId: 'gen-1',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      now: T0,
    })

    const first = await storage.replication.enqueuePending({
      id: 'pending-1',
      streamId: 'stream-1',
      generationId: 'gen-1',
      dedupKey: 'LogicalSession:session-1',
      entityType: 'LogicalSession',
      originEntityId: 'session-1',
      candidateHash: 'candidate-a',
      phase: 'incremental',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: { title: 'v1' },
      now: T0,
    })
    assert.equal(first.created, true)
    assert.equal(first.replaced, false)

    const duplicate = await storage.replication.enqueuePending({
      id: 'pending-duplicate',
      streamId: 'stream-1',
      generationId: 'gen-1',
      dedupKey: 'LogicalSession:session-1',
      entityType: 'LogicalSession',
      originEntityId: 'session-1',
      candidateHash: 'candidate-a',
      phase: 'reconcile',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: { title: 'should-not-replace' },
      now: T1,
    })
    assert.equal(duplicate.item.id, 'pending-1')
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.replaced, false)
    assert.deepEqual(duplicate.item.payload, { title: 'v1' })

    const replaced = await storage.replication.enqueuePending({
      id: 'pending-replacement',
      streamId: 'stream-1',
      generationId: 'gen-1',
      dedupKey: 'LogicalSession:session-1',
      entityType: 'LogicalSession',
      originEntityId: 'session-1',
      candidateHash: 'candidate-b',
      phase: 'reconcile',
      policyRevision: 'policy-2',
      historyRevision: 'history-1',
      payload: { title: 'v2' },
      now: T1,
    })
    assert.equal(replaced.item.id, 'pending-1')
    assert.equal(replaced.created, false)
    assert.equal(replaced.replaced, true)
    assert.deepEqual(replaced.item.payload, { title: 'v2' })

    const batch = await storage.replication.freezeBatch({
      streamId: 'stream-1',
      generationId: 'gen-1',
      sequence: 1,
      batchId: 'batch-1',
      contentHash: 'batch-hash-1',
      phase: 'reconcile',
      policyRevision: 'policy-2',
      historyRevision: 'history-1',
      payload: { batch: 1 },
      pendingItemIds: ['pending-1'],
      now: T2,
    })
    assert.equal(batch.sequence, 1)

    const retry = await storage.replication.freezeBatch({
      streamId: 'stream-1',
      generationId: 'gen-1',
      sequence: 1,
      batchId: 'ignored-on-exact-retry',
      contentHash: 'batch-hash-1',
      phase: 'incremental',
      policyRevision: 'different',
      historyRevision: 'different',
      payload: { changed: true },
      pendingItemIds: ['pending-1'],
      now: T2,
    })
    assert.equal(retry.batchId, 'batch-1')
    assert.deepEqual(retry.payload, { batch: 1 })

    await assert.rejects(
      () => storage.replication.freezeBatch({
        streamId: 'stream-1',
        generationId: 'gen-1',
        sequence: 1,
        batchId: 'batch-conflict',
        contentHash: 'different-hash',
        phase: 'incremental',
        policyRevision: 'policy-2',
        historyRevision: 'history-1',
        payload: { batch: 'conflict' },
        pendingItemIds: ['pending-1'],
      }),
      (error: unknown) => error instanceof DurableReplicationError && error.code === 'SEQUENCE_REUSE_CONFLICT',
    )

    const unchangedAfterFreeze = await storage.replication.enqueuePending({
      id: 'pending-after-freeze-same',
      streamId: 'stream-1',
      generationId: 'gen-1',
      dedupKey: 'LogicalSession:session-1',
      entityType: 'LogicalSession',
      originEntityId: 'session-1',
      candidateHash: 'candidate-b',
      phase: 'reconcile',
      policyRevision: 'policy-2',
      historyRevision: 'history-1',
      payload: { title: 'same state' },
    })
    assert.equal(unchangedAfterFreeze.item.id, 'pending-1')
    assert.equal(unchangedAfterFreeze.created, false)

    const changedAfterFreeze = await storage.replication.enqueuePending({
      id: 'pending-2',
      streamId: 'stream-1',
      generationId: 'gen-1',
      dedupKey: 'LogicalSession:session-1',
      entityType: 'LogicalSession',
      originEntityId: 'session-1',
      candidateHash: 'candidate-c',
      phase: 'reconcile',
      policyRevision: 'policy-2',
      historyRevision: 'history-1',
      payload: { title: 'v3' },
    })
    assert.equal(changedAfterFreeze.item.id, 'pending-2')
    assert.equal(changedAfterFreeze.created, true)
  } finally {
    storage.close()
  }
})

test('ACK advances contiguously and stream/batch state survives restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-replication-'))
  const dbPath = join(root, 'agent-lens.db')
  try {
    const first = await createStorage(dbPath)
    await first.replication.ensureStream({
      relationshipId: 'rel-1',
      hubId: 'hub-1',
      streamId: 'stream-1',
      generationId: 'gen-1',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      now: T0,
    })
    await first.replication.enqueuePending({
      id: 'pending-1',
      streamId: 'stream-1',
      generationId: 'gen-1',
      dedupKey: 'Project:project-1',
      entityType: 'Project',
      originEntityId: 'project-1',
      candidateHash: 'candidate-1',
      phase: 'bootstrap',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: { id: 'project-1' },
      now: T0,
    })
    await first.replication.freezeBatch({
      streamId: 'stream-1',
      generationId: 'gen-1',
      sequence: 1,
      batchId: 'batch-1',
      contentHash: 'hash-1',
      phase: 'bootstrap',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: { sequence: 1 },
      pendingItemIds: ['pending-1'],
      now: T1,
    })
    first.close()

    const second = await createStorage(dbPath)
    try {
      const restored = await second.replication.getStream('stream-1')
      assert.equal(restored?.nextSequence, 2)
      assert.equal(restored?.ackSequence, 0)
      assert.equal((await second.replication.getFrozenBatch('stream-1', 1))?.contentHash, 'hash-1')

      await assert.rejects(
        () => second.replication.acknowledge('stream-1', 2),
        (error: unknown) => error instanceof DurableReplicationError && error.code === 'SEQUENCE_GAP',
      )

      const acked = await second.replication.acknowledge('stream-1', 1, T2)
      assert.equal(acked.ackSequence, 1)
      const repeated = await second.replication.acknowledge('stream-1', 1, T2)
      assert.equal(repeated.ackSequence, 1)
      assert.equal((await second.replication.getFrozenBatch('stream-1', 1))?.status, 'acked')
    } finally {
      second.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
