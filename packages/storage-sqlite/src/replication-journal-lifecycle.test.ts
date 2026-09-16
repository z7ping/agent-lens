import assert from 'node:assert/strict'
import test from 'node:test'
import { JOURNAL_REPLICATION_ENTITY_TYPES } from '@agent-lens/core/replication'
import { SqliteStorageService } from './storage'

const T0 = '2026-09-16T00:00:00.000Z'
const T1 = '2026-09-16T00:01:00.000Z'

async function storage() {
  const value = new SqliteStorageService({ path: ':memory:' })
  await value.migrate()
  return value
}
async function putHost(db: SqliteStorageService, id: string, seenAt: string) {
  await db.repositories.hosts.put({
    id, name: id, platform: 'linux', arch: 'x64', createdAt: T0, lastSeenAt: seenAt,
  })
}

function appendObservationChange(db: SqliteStorageService, id: string): void {
  db.db.prepare(`
    INSERT INTO replication_canonical_changes(entity_type, origin_entity_id)
    VALUES ('CanonicalObservation', ?)
  `).run(id)
}

async function advanceJournalCapture(
  db: SqliteStorageService,
  streamId: string,
  generationId: string,
  capturedRevision: number,
): Promise<void> {
  for (const entityType of JOURNAL_REPLICATION_ENTITY_TYPES) {
    await db.replicationJournalLifecycle.advance({
      streamId,
      generationId,
      entityType,
      capturedRevision,
    })
  }
}

test('journal high-water survives bounded GC and remains monotonic after new writes', async () => {
  const db = await storage()
  try {
    appendObservationChange(db, 'observation-1')
    appendObservationChange(db, 'observation-2')
    const highWater = await db.replicationJournalLifecycle.highWaterRevision()
    assert.ok(highWater >= 2)

    const before = await db.replicationJournalLifecycle.safety()
    assert.equal(before.safeJournalRevision, highWater)
    assert.equal(before.blockingStreams.length, 0)
    assert.ok(before.reclaimableChanges >= 2)

    const first = await db.replicationJournalLifecycle.reclaimBatch({ limit: 1 })
    assert.equal(first.deletedChanges, 1)
    assert.equal(await db.replicationJournalLifecycle.highWaterRevision(), highWater)

    while ((await db.replicationJournalLifecycle.safety()).reclaimableChanges > 0) {
      await db.replicationJournalLifecycle.reclaimBatch({ limit: 100 })
    }
    assert.equal(await db.replicationJournalLifecycle.highWaterRevision(), highWater)

    appendObservationChange(db, 'observation-3')
    assert.ok((await db.replicationJournalLifecycle.highWaterRevision()) > highWater)
  } finally {
    db.close()
  }
})

test('paused stream blocks GC until explicit retirement and diagnostics explains the blocker', async () => {
  const db = await storage()
  try {
    appendObservationChange(db, 'observation-before')
    const captured = await db.replicationJournalLifecycle.highWaterRevision()
    await db.replication.ensureStream({
      relationshipId: 'rel-1', hubId: 'hub-1', streamId: 'stream-1', generationId: 'gen-1',
      policyRevision: 'policy-1', historyRevision: 'history-1',
    })
    await advanceJournalCapture(db, 'stream-1', 'gen-1', captured)
    await db.replication.setStreamPolicyState({
      streamId: 'stream-1', status: 'paused',
      policyRevision: 'policy-1', historyRevision: 'history-1',
    })
    appendObservationChange(db, 'observation-after')
    const highWater = await db.replicationJournalLifecycle.highWaterRevision()
    assert.ok(highWater > captured)

    const safety = await db.replicationJournalLifecycle.safety()
    assert.equal(safety.safeJournalRevision, captured)
    assert.equal(safety.blockingStreams[0]?.streamId, 'stream-1')
    assert.equal(safety.blockingStreams[0]?.streamStatus, 'paused')

    await db.replicationJournalLifecycle.reclaimBatch({ limit: 1000 })
    const remaining = db.db.prepare(
      'SELECT revision FROM replication_canonical_changes ORDER BY revision',
    ).all() as Array<{ revision: number }>
    assert.ok(remaining.every(row => row.revision > captured))

    const diagnostics = await db.diagnostics()
    const journal = (diagnostics.details as {
      replicationJournal: {
        gcAvailable: boolean
        safeJournalRevision: number
        blockingStreams: Array<{ streamId: string }>
      }
    }).replicationJournal
    assert.equal(journal.gcAvailable, true)
    assert.equal(journal.safeJournalRevision, captured)
    assert.equal(journal.blockingStreams[0]?.streamId, 'stream-1')

    assert.equal(
      await db.replicationJournalLifecycle.retireGeneration({
        streamId: 'stream-1',
        generationId: 'gen-1',
      }),
      JOURNAL_REPLICATION_ENTITY_TYPES.length,
    )
    assert.equal((await db.replicationJournalLifecycle.safety()).safeJournalRevision, highWater)
  } finally {
    db.close()
  }
})

test('journal GC does not depend on network ACK and preserves frozen exact-retry payload', async () => {
  const db = await storage()
  try {
    appendObservationChange(db, 'observation-1')
    const highWater = await db.replicationJournalLifecycle.highWaterRevision()
    await db.replication.ensureStream({
      relationshipId: 'rel-frozen', hubId: 'hub-1', streamId: 'stream-frozen',
      generationId: 'gen-frozen', policyRevision: 'policy-1', historyRevision: 'history-1',
    })
    await advanceJournalCapture(
      db,
      'stream-frozen',
      'gen-frozen',
      highWater,
    )
    const pending = await db.replication.enqueuePending({
      id: 'pending-1', streamId: 'stream-frozen', generationId: 'gen-frozen',
      dedupKey: 'CanonicalObservation:observation-1',
      entityType: 'CanonicalObservation', originEntityId: 'observation-1',
      candidateHash: 'candidate-hash-1', phase: 'incremental',
      policyRevision: 'policy-1', historyRevision: 'history-1',
      payload: { id: 'observation-1', text: 'immutable retry body' },
    })
    await db.replication.freezeBatch({
      streamId: 'stream-frozen', generationId: 'gen-frozen', sequence: 1,
      batchId: 'batch-1', contentHash: 'batch-hash-1', phase: 'incremental',
      policyRevision: 'policy-1', historyRevision: 'history-1',
      payload: { entities: [{ id: 'observation-1', text: 'immutable retry body' }] },
      pendingItemIds: [pending.item.id],
    })
    const before = await db.replication.getFrozenBatch('stream-frozen', 1)
    assert.equal(before?.status, 'frozen')

    const reclaimed = await db.replicationJournalLifecycle.reclaimBatch({ limit: 1000 })
    assert.ok(reclaimed.deletedChanges > 0)
    assert.deepEqual(await db.replication.getFrozenBatch('stream-frozen', 1), before)
    assert.equal((await db.replication.getStream('stream-frozen'))?.ackSequence, 0)
  } finally {
    db.close()
  }
})


test('full R1 journal coverage reclaims all 18 Root types while Entity Head survives', async () => {
  const db = await storage()
  try {
    await putHost(db, 'host-covered', T0)
    await db.repositories.coverage.put({
      id: 'coverage-covered',
      subjectType: 'host',
      subjectId: 'host-covered',
      capability: 'history',
      status: 'complete',
      evidenceRefs: [],
    })
    appendObservationChange(db, 'observation-covered')

    const safety = await db.replicationJournalLifecycle.safety()
    assert.ok(safety.reclaimableChanges >= 3)
    assert.equal(safety.uncoveredChanges, 0)
    assert.deepEqual(
      safety.gcCoveredEntityTypes,
      JOURNAL_REPLICATION_ENTITY_TYPES,
    )

    const headBefore = db.db.prepare(`
      SELECT latest_revision AS latestRevision
      FROM replication_entity_heads
      WHERE entity_type = 'Coverage' AND origin_entity_id = 'coverage-covered'
    `).get() as { latestRevision: number }
    assert.ok(headBefore.latestRevision > 0)

    await db.replicationJournalLifecycle.reclaimBatch({ limit: 10000 })

    const rows = db.db.prepare(`
      SELECT entity_type AS entityType, origin_entity_id AS originEntityId
      FROM replication_canonical_changes
      WHERE origin_entity_id IN ('host-covered', 'coverage-covered', 'observation-covered')
      ORDER BY revision
    `).all() as Array<{ entityType: string; originEntityId: string }>
    assert.deepEqual(rows, [])

    const headAfter = db.db.prepare(`
      SELECT latest_revision AS latestRevision
      FROM replication_entity_heads
      WHERE entity_type = 'Coverage' AND origin_entity_id = 'coverage-covered'
    `).get() as { latestRevision: number }
    assert.equal(headAfter.latestRevision, headBefore.latestRevision)

    const coverage = await db.replicationIndependentRoots.get('Coverage', 'coverage-covered')
    assert.equal(coverage?.entityType, 'Coverage')
    if (coverage?.entityType === 'Coverage') {
      assert.equal(coverage.entity.status, 'complete')
    }
  } finally {
    db.close()
  }
})
