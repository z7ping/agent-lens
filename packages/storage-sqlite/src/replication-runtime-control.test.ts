import assert from 'node:assert/strict'
import test from 'node:test'
import {
  JOURNAL_REPLICATION_ENTITY_TYPES,
} from '@agent-lens/core/replication'
import { SqliteStorageService } from './storage'

async function createStorage() {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  return storage
}

async function createStream(storage: SqliteStorageService, status: 'active' | 'paused' = 'active') {
  return storage.replication.ensureStream({
    relationshipId: 'relationship-1',
    hubId: 'hub-1',
    streamId: 'stream-1',
    generationId: 'generation-1',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    status,
    now: '2026-09-16T00:00:00.000Z',
  })
}

test('new stream conservatively registers every journal-producing R1 Root capture dependency', async () => {
  const storage = await createStorage()
  try {
    await createStream(storage)
    const rows = storage.db.prepare(`
      SELECT entity_type AS entityType,
             captured_revision AS capturedRevision,
             dependency_state AS dependencyState
      FROM replication_capture_watermarks
      WHERE stream_id = 'stream-1'
      ORDER BY entity_type
    `).all() as Array<{
      entityType: string
      capturedRevision: number
      dependencyState: string
    }>

    assert.deepEqual(
      rows.map(row => row.entityType),
      [...JOURNAL_REPLICATION_ENTITY_TYPES].sort(),
    )
    assert.ok(rows.every(row => row.capturedRevision === 0))
    assert.ok(rows.every(row => row.dependencyState === 'dependent'))
  } finally {
    storage.close()
  }
})

test('runnable stream requires persisted authorization matching generation and revisions', async () => {
  const storage = await createStorage()
  try {
    await createStream(storage)
    assert.deepEqual(await storage.replicationRuntimeControl.listRunnableStreams(), [])

    await assert.rejects(
      storage.replicationRuntimeControl.putAuthorization({
        streamId: 'stream-1',
        generationId: 'generation-1',
        policy: { mode: 'full', revision: 'wrong-policy' },
        history: { mode: 'include-existing', revision: 'history-1' },
      }),
      /revision does not match stream/,
    )

    await storage.replicationRuntimeControl.putAuthorization({
      streamId: 'stream-1',
      generationId: 'generation-1',
      policy: { mode: 'redacted', revision: 'policy-1' },
      history: { mode: 'include-existing', revision: 'history-1' },
      now: '2026-09-16T00:01:00.000Z',
    })
    const [runnable] = await storage.replicationRuntimeControl.listRunnableStreams()
    assert.equal(runnable?.stream.streamId, 'stream-1')
    assert.equal(runnable?.authorization.policy.mode, 'redacted')
    assert.equal(runnable?.authorization.history.mode, 'include-existing')

    await storage.replication.setStreamPolicyState({
      streamId: 'stream-1',
      status: 'paused',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
    })
    assert.deepEqual(await storage.replicationRuntimeControl.listRunnableStreams(), [])
  } finally {
    storage.close()
  }
})

test('from-now authorization requires a durable valid boundary', async () => {
  const storage = await createStorage()
  try {
    await createStream(storage)
    await assert.rejects(
      storage.replicationRuntimeControl.putAuthorization({
        streamId: 'stream-1',
        generationId: 'generation-1',
        policy: { mode: 'full', revision: 'policy-1' },
        history: { mode: 'from-now', revision: 'history-1' },
      }),
      /requires a valid boundaryCapturedAt/,
    )

    const authorization = await storage.replicationRuntimeControl.putAuthorization({
      streamId: 'stream-1',
      generationId: 'generation-1',
      policy: { mode: 'full', revision: 'policy-1' },
      history: {
        mode: 'from-now',
        revision: 'history-1',
        boundaryCapturedAt: '2026-09-16T00:02:00.000Z',
      },
    })
    assert.equal(
      authorization.history.boundaryCapturedAt,
      '2026-09-16T00:02:00.000Z',
    )
    assert.deepEqual(
      await storage.replicationRuntimeControl.getAuthorization('stream-1'),
      authorization,
    )
  } finally {
    storage.close()
  }
})

test('periodic reconciliation cycle resumes after interruption and resets cursor only for a new cycle', async () => {
  const storage = await createStorage()
  try {
    await createStream(storage)
    await storage.replication.setReconciliationCursor({
      streamId: 'stream-1',
      entityType: 'CanonicalObservation',
      cursor: 'observation-100',
      updatedAt: '2026-09-16T00:00:00.000Z',
    })

    const first = await storage.replicationRuntimeControl.beginReconciliationCycle({
      streamId: 'stream-1',
      generationId: 'generation-1',
      entityType: 'CanonicalObservation',
      throughRevision: 50,
      now: '2026-09-16T00:05:00.000Z',
    })
    assert.equal(first.kind, 'running')
    assert.equal(
      await storage.replication.getReconciliationCursor('stream-1', 'CanonicalObservation'),
      undefined,
    )

    await storage.replication.setReconciliationCursor({
      streamId: 'stream-1',
      entityType: 'CanonicalObservation',
      cursor: 'observation-200',
      updatedAt: '2026-09-16T00:06:00.000Z',
    })
    const resumed = await storage.replicationRuntimeControl.beginReconciliationCycle({
      streamId: 'stream-1',
      generationId: 'generation-1',
      entityType: 'CanonicalObservation',
      throughRevision: 99,
      now: '2026-09-16T00:07:00.000Z',
    })
    assert.equal(resumed.kind, 'running')
    if (resumed.kind === 'running') {
      assert.equal(resumed.cycle.cycle, 1)
      assert.equal(resumed.cycle.throughRevision, 50)
    }
    assert.equal(
      (await storage.replication.getReconciliationCursor(
        'stream-1',
        'CanonicalObservation',
      ))?.cursor,
      'observation-200',
    )

    await storage.replicationRuntimeControl.completeReconciliationCycle({
      streamId: 'stream-1',
      generationId: 'generation-1',
      entityType: 'CanonicalObservation',
      nextDueAt: '2026-09-16T01:00:00.000Z',
      now: '2026-09-16T00:10:00.000Z',
    })
    const notDue = await storage.replicationRuntimeControl.beginReconciliationCycle({
      streamId: 'stream-1',
      generationId: 'generation-1',
      entityType: 'CanonicalObservation',
      throughRevision: 60,
      now: '2026-09-16T00:30:00.000Z',
    })
    assert.deepEqual(notDue, {
      kind: 'not-due',
      nextDueAt: '2026-09-16T01:00:00.000Z',
    })

    const second = await storage.replicationRuntimeControl.beginReconciliationCycle({
      streamId: 'stream-1',
      generationId: 'generation-1',
      entityType: 'CanonicalObservation',
      throughRevision: 60,
      now: '2026-09-16T01:00:00.000Z',
    })
    assert.equal(second.kind, 'running')
    if (second.kind === 'running') {
      assert.equal(second.cycle.cycle, 2)
      assert.equal(second.cycle.throughRevision, 60)
    }
    assert.equal(
      await storage.replication.getReconciliationCursor('stream-1', 'CanonicalObservation'),
      undefined,
    )
  } finally {
    storage.close()
  }
})
