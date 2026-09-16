import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanonicalReplicationReader } from './canonical-graph'
import { pumpObservationBootstrapGenerationStep } from './observation-bootstrap-orchestrator'
import { pumpObservationIncrementalPage } from './observation-incremental'
import {
  SqliteReplicationReconciliationSink,
  SqliteStorageService,
} from '@agent-lens/storage-sqlite'

function emptyDependencies(): CanonicalReplicationReader {
  return {
    getHost: async () => null,
    getInstallation: async () => null,
    getAgentProduct: async () => null,
    getProject: async () => null,
    getWorkspace: async () => null,
    getRuntimeProfile: async () => null,
    getLogicalSession: async () => null,
    getSourceSession: async () => null,
    getActor: async () => null,
    getEvidence: async () => null,
    getSourceRecord: async () => null,
  }
}

test('SQLite-backed Bootstrap Generation reaches active only after Reconciliation, then incremental advances capture', async () => {
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

    const common = {
      changes: storage.replicationCanonicalChanges,
      snapshot: storage.replicationObservationSnapshot,
      observations: storage.repositories.observations,
      dependencies: emptyDependencies(),
      pendingSink: storage.replication,
      reconciliationSink: new SqliteReplicationReconciliationSink(storage.replication),
      snapshotProgress: storage.replicationSnapshotBootstrapProgress,
      deltaProgress: storage.replicationChangeProgress,
      captureProgress: storage.replicationJournalLifecycle,
      lifecycle: storage.replicationBootstrapLifecycle,
      nodeId: 'node-1',
      streamId: 'stream-1',
      generationId: 'gen-1',
      policy: { mode: 'full' as const, revision: 'policy-1' },
      history: { mode: 'include-existing' as const, revision: 'history-1' },
    }

    const snapshot = await pumpObservationBootstrapGenerationStep(common)
    assert.equal(snapshot.stage, 'delta')
    assert.equal(snapshot.active, false)
    assert.equal(snapshot.work.kind, 'snapshot')

    const delta = await pumpObservationBootstrapGenerationStep(common)
    assert.equal(delta.stage, 'reconcile')
    assert.equal(delta.active, false)
    assert.equal(delta.work.kind, 'delta')

    const reconcile = await pumpObservationBootstrapGenerationStep(common)
    assert.equal(reconcile.stage, 'active')
    assert.equal(reconcile.active, true)
    assert.equal(reconcile.work.kind, 'reconcile')

    const active = await pumpObservationBootstrapGenerationStep(common)
    assert.equal(active.stage, 'active')
    assert.deepEqual(active.work, { kind: 'none' })

    await storage.repositories.hosts.put({
      id: 'host-after-bootstrap',
      name: 'after',
      platform: 'linux',
      arch: 'x64',
      createdAt: '2026-09-16T00:00:00.000Z',
      lastSeenAt: '2026-09-16T00:00:00.000Z',
    })
    const highWater = await storage.replicationCanonicalChanges.highWaterRevision()
    assert.ok(highWater > 0)

    const incremental = await pumpObservationIncrementalPage({
      changes: storage.replicationCanonicalChanges,
      observations: storage.repositories.observations,
      dependencies: emptyDependencies(),
      sink: storage.replication,
      progress: storage.replicationChangeProgress,
      captureProgress: storage.replicationJournalLifecycle,
      startRevision: 0,
      nodeId: 'node-1',
      streamId: 'stream-1',
      generationId: 'gen-1',
      policy: { mode: 'full', revision: 'policy-1' },
      history: { mode: 'include-existing', revision: 'history-1' },
    })
    assert.equal(incremental.done, true)
    assert.equal(incremental.nextRevision, highWater)
    assert.equal(
      (await storage.replicationJournalLifecycle.get({
        streamId: 'stream-1',
        generationId: 'gen-1',
        entityType: 'CanonicalObservation',
      }))?.capturedRevision,
      highWater,
    )
  } finally {
    storage.close()
  }
})
