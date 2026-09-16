import assert from 'node:assert/strict'
import test from 'node:test'
import type { IndependentReplicationRootEntityType } from '@agent-lens/core/replication'
import {
  canonicalReplicationReaderFromRepositories,
  pumpIndependentRootRuntimeStep,
} from '@agent-lens/replication-node'
import {
  SqliteReplicationReconciliationSink,
  SqliteStorageService,
} from '@agent-lens/storage-sqlite'

const NODE_ID = '11111111-1111-4111-8111-111111111111'

async function createStorage() {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  await storage.replication.ensureStream({
    relationshipId: 'relationship-1',
    hubId: 'hub-1',
    streamId: 'stream-1',
    generationId: 'generation-1',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
  })
  return storage
}

async function step(
  storage: SqliteStorageService,
  entityType: IndependentReplicationRootEntityType = 'Coverage',
) {
  return pumpIndependentRootRuntimeStep({
    entityType,
    changes: storage.replicationCanonicalChanges,
    roots: storage.replicationIndependentRoots,
    dependencies: canonicalReplicationReaderFromRepositories(
      storage.repositories,
      storage.runtimeProfiles,
    ),
    pendingSink: storage.replication,
    reconciliationSink: new SqliteReplicationReconciliationSink(storage.replication),
    snapshotProgress: storage.replicationSnapshotBootstrapProgress,
    deltaProgress: storage.replicationChangeProgress,
    incrementalProgress: storage.replicationChangeProgress,
    captureProgress: storage.replicationJournalLifecycle,
    lifecycle: storage.replicationBootstrapLifecycle,
    cycles: storage.replicationRuntimeControl,
    nodeId: NODE_ID,
    streamId: 'stream-1',
    generationId: 'generation-1',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
    pageLimit: 100,
    reconciliationIntervalMs: 30 * 60 * 1000,
    now: '2026-09-17T03:00:00.000Z',
  })
}

test('Independent Root Runtime reaches active and keeps capturedRevision current after updates', async () => {
  const storage = await createStorage()
  try {
    await storage.repositories.coverage.put({
      id: 'coverage-1',
      subjectType: 'host',
      subjectId: 'host-1',
      capability: 'history',
      status: 'partial',
      evidenceRefs: [],
    })
    const baseline = await storage.replicationCanonicalChanges.highWaterRevision()

    const first = await step(storage)
    assert.deepEqual(first, { kind: 'bootstrap', stage: 'delta', didWork: true })

    const second = await step(storage)
    assert.deepEqual(second, { kind: 'bootstrap', stage: 'reconcile', didWork: true })

    const third = await step(storage)
    assert.equal(third.kind, 'active')
    assert.equal(
      (await storage.replicationBootstrapLifecycle.get({
        streamId: 'stream-1',
        generationId: 'generation-1',
        entityType: 'Coverage',
      }))?.stage,
      'active',
    )
    assert.equal(
      (await storage.replicationJournalLifecycle.get({
        streamId: 'stream-1',
        generationId: 'generation-1',
        entityType: 'Coverage',
      }))?.capturedRevision,
      baseline,
    )
    assert.equal((await storage.replication.listPending('stream-1')).length, 1)

    await storage.repositories.coverage.put({
      id: 'coverage-1',
      subjectType: 'host',
      subjectId: 'host-1',
      capability: 'history',
      status: 'complete',
      evidenceRefs: [],
    })
    const updatedHighWater = await storage.replicationCanonicalChanges.highWaterRevision()
    assert.ok(updatedHighWater > baseline)

    const fourth = await step(storage)
    assert.equal(fourth.kind, 'active')
    assert.equal(
      (await storage.replicationJournalLifecycle.get({
        streamId: 'stream-1',
        generationId: 'generation-1',
        entityType: 'Coverage',
      }))?.capturedRevision,
      updatedHighWater,
    )
    assert.equal((await storage.replication.listPending('stream-1')).length, 1)
  } finally {
    await storage.close()
  }
})


test('orphan Host without any Observation is still covered by its own Current-State Root', async () => {
  const storage = await createStorage()
  try {
    await storage.repositories.hosts.put({
      id: 'host-orphan',
      name: 'orphan host',
      platform: 'linux',
      arch: 'x64',
      createdAt: '2026-09-17T00:00:00.000Z',
      lastSeenAt: '2026-09-17T00:00:00.000Z',
    })
    const baseline = await storage.replicationCanonicalChanges.highWaterRevision()

    assert.deepEqual(await step(storage, 'Host'), { kind: 'bootstrap', stage: 'delta', didWork: true })
    assert.deepEqual(await step(storage, 'Host'), { kind: 'bootstrap', stage: 'reconcile', didWork: true })
    const active = await step(storage, 'Host')
    assert.equal(active.kind, 'active')

    const pending = await storage.replication.listPending('stream-1')
    assert.ok(pending.some(item =>
      item.entityType === 'Host' && item.originEntityId === 'host-orphan'
    ))
    assert.equal(
      (await storage.replicationJournalLifecycle.get({
        streamId: 'stream-1',
        generationId: 'generation-1',
        entityType: 'Host',
      }))?.capturedRevision,
      baseline,
    )

    const observationCapture = await storage.replicationJournalLifecycle.get({
      streamId: 'stream-1',
      generationId: 'generation-1',
      entityType: 'CanonicalObservation',
    })
    assert.equal(observationCapture?.capturedRevision, 0)
  } finally {
    await storage.close()
  }
})
