import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('Bootstrap Generation lifecycle is durable, monotonic, and revision-bound', async () => {
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

    const staged = await storage.replicationBootstrapLifecycle.ensure({
      streamId: 'stream-1',
      generationId: 'gen-1',
      entityType: 'CanonicalObservation',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      now: '2026-09-16T00:00:00.000Z',
    })
    assert.equal(staged.stage, 'staged')

    for (const stage of ['snapshot', 'delta', 'reconcile', 'active'] as const) {
      const state = await storage.replicationBootstrapLifecycle.transition({
        streamId: 'stream-1',
        generationId: 'gen-1',
        entityType: 'CanonicalObservation',
        stage,
        policyRevision: 'policy-1',
        historyRevision: 'history-1',
      })
      assert.equal(state.stage, stage)
    }

    await assert.rejects(
      storage.replicationBootstrapLifecycle.transition({
        streamId: 'stream-1',
        generationId: 'gen-1',
        entityType: 'CanonicalObservation',
        stage: 'reconcile',
        policyRevision: 'policy-1',
        historyRevision: 'history-1',
      }),
      /cannot move backwards/,
    )
    await assert.rejects(
      storage.replicationBootstrapLifecycle.ensure({
        streamId: 'stream-1',
        generationId: 'gen-1',
        entityType: 'CanonicalObservation',
        policyRevision: 'policy-2',
        historyRevision: 'history-1',
      }),
      /re-bootstrap is required/,
    )
  } finally {
    storage.close()
  }
})

test('Bootstrap Generation lifecycle rejects stage skipping and foreign generation', async () => {
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
    await storage.replicationBootstrapLifecycle.ensure({
      streamId: 'stream-1',
      generationId: 'gen-1',
      entityType: 'CanonicalObservation',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
    })

    await assert.rejects(
      storage.replicationBootstrapLifecycle.transition({
        streamId: 'stream-1',
        generationId: 'gen-1',
        entityType: 'CanonicalObservation',
        stage: 'delta',
        policyRevision: 'policy-1',
        historyRevision: 'history-1',
      }),
      /cannot skip stages/,
    )
    await assert.rejects(
      storage.replicationBootstrapLifecycle.ensure({
        streamId: 'stream-1',
        generationId: 'gen-2',
        entityType: 'CanonicalObservation',
        policyRevision: 'policy-1',
        historyRevision: 'history-1',
      }),
      /generation does not match stream/,
    )
  } finally {
    storage.close()
  }
})
