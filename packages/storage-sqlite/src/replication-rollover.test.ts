import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DurableReplicationError,
  JOURNAL_REPLICATION_ENTITY_TYPES,
} from '@agent-lens/core/replication'
import { SqliteStorageService } from './storage'

test('Policy Stream Rollover keeps Generation, freezes old Stream and transfers journal dependency', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    await storage.replication.ensureStream({
      relationshipId: 'rel-1',
      hubId: 'hub-1',
      streamId: 'stream-old',
      generationId: 'gen-active',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      now: '2026-09-17T00:00:00.000Z',
    })

    await storage.replication.enqueuePending({
      id: 'pending-old-1',
      streamId: 'stream-old',
      generationId: 'gen-active',
      dedupKey: 'Host:host-1',
      entityType: 'Host',
      originEntityId: 'host-1',
      candidateHash: 'candidate-old-1',
      phase: 'incremental',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: { body: { id: { state: 'value', value: 'host-1' } } },
      now: '2026-09-17T00:00:01.000Z',
    })
    const frozen = await storage.replication.freezeBatch({
      streamId: 'stream-old',
      generationId: 'gen-active',
      sequence: 1,
      batchId: 'batch-old-1',
      contentHash: 'hash-old-1',
      phase: 'incremental',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: { entities: [{ id: 'host-1' }] },
      pendingItemIds: ['pending-old-1'],
      now: '2026-09-17T00:00:02.000Z',
    })

    await storage.replicationRuntimeControl.putAuthorization({
      streamId: 'stream-old',
      generationId: 'gen-active',
      policy: { mode: 'full', revision: 'policy-1' },
      history: { mode: 'include-existing', revision: 'history-1' },
      now: '2026-09-17T00:00:02.500Z',
    })

    for (const entityType of JOURNAL_REPLICATION_ENTITY_TYPES) {
      await storage.replicationJournalLifecycle.advance({
        streamId: 'stream-old',
        generationId: 'gen-active',
        entityType,
        capturedRevision: 10,
        now: '2026-09-17T00:00:03.000Z',
      })
    }

    const rollover = await storage.replication.rolloverStream({
      fromStreamId: 'stream-old',
      toStreamId: 'stream-new',
      policyRevision: 'policy-2',
      historyRevision: 'history-1',
      now: '2026-09-17T00:00:04.000Z',
    })

    assert.equal(rollover.previous.status, 'rollover-required')
    assert.equal(rollover.next.status, 'active')
    assert.equal(rollover.next.relationshipId, 'rel-1')
    assert.equal(rollover.next.hubId, 'hub-1')
    assert.equal(rollover.next.generationId, 'gen-active')
    assert.equal(rollover.next.policyRevision, 'policy-2')
    assert.equal(rollover.next.historyRevision, 'history-1')
    assert.equal(rollover.next.nextSequence, 1)
    assert.equal(rollover.next.ackSequence, 0)

    const oldWatermarks = storage.db.prepare(`
      SELECT dependency_state AS dependencyState
      FROM replication_capture_watermarks
      WHERE stream_id = 'stream-old'
      ORDER BY entity_type
    `).all() as Array<{ dependencyState: string }>
    assert.equal(oldWatermarks.length, JOURNAL_REPLICATION_ENTITY_TYPES.length)
    assert.ok(oldWatermarks.every(item => item.dependencyState === 'retired'))

    const newWatermarks = storage.db.prepare(`
      SELECT entity_type AS entityType,
             captured_revision AS capturedRevision,
             dependency_state AS dependencyState
      FROM replication_capture_watermarks
      WHERE stream_id = 'stream-new'
      ORDER BY entity_type
    `).all() as Array<{
      entityType: string
      capturedRevision: number
      dependencyState: string
    }>
    assert.deepEqual(
      newWatermarks.map(item => item.entityType),
      [...JOURNAL_REPLICATION_ENTITY_TYPES].sort(),
    )
    assert.ok(newWatermarks.every(item => item.capturedRevision === 0))
    assert.ok(newWatermarks.every(item => item.dependencyState === 'dependent'))

    // Old authorization is retained for audit/retry, but rollover-required is
    // not runnable. New stream is fail-closed until its full authorization is
    // explicitly persisted.
    assert.deepEqual(
      await storage.replicationRuntimeControl.listRunnableStreams(),
      [],
    )
    await storage.replicationRuntimeControl.putAuthorization({
      streamId: 'stream-new',
      generationId: 'gen-active',
      policy: { mode: 'redacted', revision: 'policy-2' },
      history: { mode: 'include-existing', revision: 'history-1' },
      now: '2026-09-17T00:00:04.500Z',
    })
    assert.deepEqual(
      (await storage.replicationRuntimeControl.listRunnableStreams())
        .map(item => item.stream.streamId),
      ['stream-new'],
    )

    // Frozen old-policy body remains immutable and exact-retriable.
    const retry = await storage.replication.freezeBatch({
      streamId: 'stream-old',
      generationId: 'gen-active',
      sequence: 1,
      batchId: 'batch-old-1',
      contentHash: 'hash-old-1',
      phase: 'incremental',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      payload: { entities: [{ id: 'ignored-on-exact-retry' }] },
      pendingItemIds: [],
      now: '2026-09-17T00:00:05.000Z',
    })
    assert.deepEqual(retry, frozen)

    await assert.rejects(
      storage.replication.freezeBatch({
        streamId: 'stream-old',
        generationId: 'gen-active',
        sequence: 2,
        batchId: 'batch-old-2',
        contentHash: 'hash-old-2',
        phase: 'incremental',
        policyRevision: 'policy-1',
        historyRevision: 'history-1',
        payload: { entities: [] },
        pendingItemIds: ['pending-old-1'],
        now: '2026-09-17T00:00:06.000Z',
      }),
      (error: unknown) =>
        error instanceof DurableReplicationError
        && error.code === 'STREAM_INVALID',
    )
  } finally {
    storage.close()
  }
})
