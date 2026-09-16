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
      batchId: 'batch-1',
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
        batchId: 'batch-renamed',
        contentHash: 'batch-hash-1',
        phase: 'incremental',
        policyRevision: 'policy-2',
        historyRevision: 'history-1',
        payload: { batch: 1 },
        pendingItemIds: ['pending-1'],
      }),
      (error: unknown) => error instanceof DurableReplicationError && error.code === 'SEQUENCE_REUSE_CONFLICT',
    )

    await assert.rejects(
      () => storage.replication.freezeBatch({
        streamId: 'stream-1',
        generationId: 'gen-1',
        sequence: 1,
        batchId: 'batch-1',
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


test('dependency-minimized candidate cannot downgrade an existing full pending candidate', async () => {
  const storage = await createStorage(':memory:')
  try {
    await storage.replication.ensureStream({
      relationshipId: 'rel-quality',
      hubId: 'hub-quality',
      streamId: 'stream-quality',
      generationId: 'gen-quality',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      now: T0,
    })

    const full = await storage.replication.enqueuePending({
      id: 'pending-full',
      streamId: 'stream-quality',
      generationId: 'gen-quality',
      dedupKey: 'entity-r1-quality',
      entityType: 'Project',
      originEntityId: 'project-1',
      candidateHash: 'hash-full',
      phase: 'bootstrap',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: {
        body: {
          id: { state: 'value', value: 'project-1' },
          name: { state: 'value', value: 'Full Project' },
        },
      },
      now: T0,
    })
    assert.equal(full.created, true)

    const minimized = await storage.replication.enqueuePending({
      id: 'pending-minimized',
      streamId: 'stream-quality',
      generationId: 'gen-quality',
      dedupKey: 'entity-r1-quality',
      entityType: 'Project',
      originEntityId: 'project-1',
      candidateHash: 'hash-minimized',
      phase: 'bootstrap',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: {
        body: {
          id: { state: 'value', value: 'project-1' },
          name: { state: 'omitted', reason: 'dependency-minimized' },
        },
      },
      now: T1,
    })

    assert.equal(minimized.created, false)
    assert.equal(minimized.replaced, false)
    assert.equal(minimized.item.candidateHash, 'hash-full')
    assert.deepEqual(minimized.item.payload, full.item.payload)
  } finally {
    storage.close()
  }
})

test('full root candidate upgrades an existing dependency-minimized candidate', async () => {
  const storage = await createStorage(':memory:')
  try {
    await storage.replication.ensureStream({
      relationshipId: 'rel-quality-upgrade',
      hubId: 'hub-quality',
      streamId: 'stream-quality-upgrade',
      generationId: 'gen-quality-upgrade',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      now: T0,
    })

    const minimized = await storage.replication.enqueuePending({
      id: 'pending-minimized',
      streamId: 'stream-quality-upgrade',
      generationId: 'gen-quality-upgrade',
      dedupKey: 'entity-r1-quality',
      entityType: 'Project',
      originEntityId: 'project-1',
      candidateHash: 'hash-minimized',
      phase: 'bootstrap',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: {
        body: {
          id: { state: 'value', value: 'project-1' },
          name: { state: 'omitted', reason: 'dependency-minimized' },
        },
      },
      now: T0,
    })
    assert.equal(minimized.created, true)

    const full = await storage.replication.enqueuePending({
      id: 'pending-full',
      streamId: 'stream-quality-upgrade',
      generationId: 'gen-quality-upgrade',
      dedupKey: 'entity-r1-quality',
      entityType: 'Project',
      originEntityId: 'project-1',
      candidateHash: 'hash-full',
      phase: 'bootstrap',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: {
        body: {
          id: { state: 'value', value: 'project-1' },
          name: { state: 'value', value: 'Full Project' },
        },
      },
      now: T1,
    })

    assert.equal(full.created, false)
    assert.equal(full.replaced, true)
    assert.equal(full.item.candidateHash, 'hash-full')
  } finally {
    storage.close()
  }
})

test('dependency-minimized candidate does not requeue after full candidate is frozen', async () => {
  const storage = await createStorage(':memory:')
  try {
    await storage.replication.ensureStream({
      relationshipId: 'rel-quality-frozen',
      hubId: 'hub-quality',
      streamId: 'stream-quality-frozen',
      generationId: 'gen-quality-frozen',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      now: T0,
    })
    const full = await storage.replication.enqueuePending({
      id: 'pending-full-frozen',
      streamId: 'stream-quality-frozen',
      generationId: 'gen-quality-frozen',
      dedupKey: 'entity-r1-quality-frozen',
      entityType: 'Project',
      originEntityId: 'project-1',
      candidateHash: 'hash-full-frozen',
      phase: 'bootstrap',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: {
        body: {
          id: { state: 'value', value: 'project-1' },
          name: { state: 'value', value: 'Full Project' },
        },
      },
      now: T0,
    })
    await storage.replication.freezeBatch({
      streamId: 'stream-quality-frozen',
      generationId: 'gen-quality-frozen',
      sequence: 1,
      batchId: 'batch-quality-frozen',
      contentHash: 'batch-quality-frozen',
      phase: 'bootstrap',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: { entities: [full.item.payload] },
      pendingItemIds: [full.item.id],
      now: T1,
    })

    const minimized = await storage.replication.enqueuePending({
      id: 'pending-minimized-after-freeze',
      streamId: 'stream-quality-frozen',
      generationId: 'gen-quality-frozen',
      dedupKey: 'entity-r1-quality-frozen',
      entityType: 'Project',
      originEntityId: 'project-1',
      candidateHash: 'hash-minimized-after-freeze',
      phase: 'bootstrap',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: {
        body: {
          id: { state: 'value', value: 'project-1' },
          name: { state: 'omitted', reason: 'dependency-minimized' },
        },
      },
      now: T2,
    })

    assert.equal(minimized.created, false)
    assert.equal(minimized.replaced, false)
    assert.equal(minimized.item.id, 'pending-full-frozen')
    assert.equal((await storage.replication.listPending('stream-quality-frozen')).length, 0)
  } finally {
    storage.close()
  }
})


test('user content that resembles availability metadata is not mistaken for dependency minimization', async () => {
  const storage = await createStorage(':memory:')
  try {
    await storage.replication.ensureStream({
      relationshipId: 'rel-quality-user-content',
      hubId: 'hub-quality',
      streamId: 'stream-quality-user-content',
      generationId: 'gen-quality-user-content',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      now: T0,
    })
    await storage.replication.enqueuePending({
      id: 'pending-content-a',
      streamId: 'stream-quality-user-content',
      generationId: 'gen-quality-user-content',
      dedupKey: 'entity-r1-user-content',
      entityType: 'CanonicalObservation',
      originEntityId: 'observation-1',
      candidateHash: 'hash-content-a',
      phase: 'incremental',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: {
        body: {
          payload: {
            state: 'value',
            value: {
              state: 'omitted',
              reason: 'dependency-minimized',
            },
          },
        },
      },
      now: T0,
    })

    const replacement = await storage.replication.enqueuePending({
      id: 'pending-content-b',
      streamId: 'stream-quality-user-content',
      generationId: 'gen-quality-user-content',
      dedupKey: 'entity-r1-user-content',
      entityType: 'CanonicalObservation',
      originEntityId: 'observation-1',
      candidateHash: 'hash-content-b',
      phase: 'incremental',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: {
        body: {
          payload: {
            state: 'value',
            value: {
              state: 'omitted',
              reason: 'dependency-minimized',
              changed: true,
            },
          },
        },
      },
      now: T1,
    })

    assert.equal(replacement.replaced, true)
    assert.equal(replacement.item.candidateHash, 'hash-content-b')
  } finally {
    storage.close()
  }
})
