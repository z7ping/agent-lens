import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SqliteCanonicalObservationSnapshotReader,
  SqliteReplicationSnapshotBootstrapProgressRepository,
} from './index'
import { SqliteStorageService } from './storage'

const OLD = '2026-08-01T00:00:00.000Z'
const NEW = '2026-09-16T00:00:00.000Z'

async function seededStorage() {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  storage.db.prepare(`
    INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
    VALUES ('host-1', 'devbox', 'linux', 'x64', ?, ?)
  `).run(OLD, NEW)
  storage.db.prepare(`
    INSERT INTO agent_products(id, name) VALUES ('codex', 'Codex')
  `).run()
  storage.db.prepare(`
    INSERT INTO agent_installations(
      id, host_id, product_id, first_seen_at, last_seen_at
    ) VALUES ('installation-1', 'host-1', 'codex', ?, ?)
  `).run(OLD, NEW)
  storage.db.prepare(`
    INSERT INTO logical_sessions(id, installation_id, started_at)
    VALUES ('session-1', 'installation-1', ?)
  `).run(OLD)
  storage.db.prepare(`
    INSERT INTO source_sessions(
      id, source_id, installation_id, native_session_id, logical_session_id
    ) VALUES ('source-session-1', 'codex', 'installation-1', 'native-1', 'session-1')
  `).run()
  return storage
}

function insertObservation(
  storage: SqliteStorageService,
  id: string,
  capturedAt: string,
) {
  storage.db.prepare(`
    INSERT INTO observations(
      id, host_id, installation_id, logical_session_id, source_session_id,
      kind, captured_at, payload_json
    ) VALUES (?, 'host-1', 'installation-1', 'session-1', 'source-session-1',
              'message.assistant', ?, ?)
  `).run(id, capturedAt, JSON.stringify({ id }))
}

test('Canonical Snapshot scanner 使用稳定主键游标分页，并保留 Evidence refs', async () => {
  const storage = await seededStorage()
  try {
    insertObservation(storage, 'observation-c', NEW)
    insertObservation(storage, 'observation-a', OLD)
    insertObservation(storage, 'observation-b', NEW)
    storage.db.prepare(`
      INSERT INTO evidence(
        id, capture_method, derivation, confidence, captured_at
      ) VALUES ('evidence-b', 'native-log', 'observed', 'high', ?)
    `).run(NEW)
    storage.db.exec(`
      INSERT INTO observation_evidence(observation_id, evidence_id)
      VALUES ('observation-b', 'evidence-b')
    `)

    const reader = new SqliteCanonicalObservationSnapshotReader(storage.executor)
    const first = await reader.scan({ limit: 2 })
    assert.deepEqual(first.items.map(item => item.id), [
      'observation-a',
      'observation-b',
    ])
    assert.equal(first.nextCursor, 'observation-b')
    assert.equal(first.done, false)
    assert.deepEqual(first.items[1]?.evidenceRefs, ['evidence-b'])

    const second = await reader.scan({
      afterId: first.nextCursor,
      limit: 2,
    })
    assert.deepEqual(second.items.map(item => item.id), ['observation-c'])
    assert.equal(second.nextCursor, 'observation-c')
    assert.equal(second.done, true)
  } finally {
    await storage.close()
  }
})

test('Canonical Snapshot scanner 可按 from-now capturedAt boundary 排除旧 Root', async () => {
  const storage = await seededStorage()
  try {
    insertObservation(storage, 'observation-old', OLD)
    insertObservation(storage, 'observation-new-a', NEW)
    insertObservation(storage, 'observation-new-b', '2026-09-16T01:00:00.000Z')

    const reader = new SqliteCanonicalObservationSnapshotReader(storage.executor)
    const page = await reader.scan({
      capturedAtOnOrAfter: '2026-09-01T00:00:00.000Z',
      limit: 10,
    })
    assert.deepEqual(page.items.map(item => item.id), [
      'observation-new-a',
      'observation-new-b',
    ])
    assert.equal(page.done, true)
  } finally {
    await storage.close()
  }
})

test('Snapshot Bootstrap progress 与 Stream / Generation 持久绑定', async () => {
  const storage = await seededStorage()
  try {
    await storage.replication.ensureStream({
      relationshipId: 'relationship-1',
      hubId: 'hub-1',
      streamId: 'stream-1',
      generationId: 'generation-1',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
    })
    const progress = new SqliteReplicationSnapshotBootstrapProgressRepository(storage.executor)
    await progress.put({
      streamId: 'stream-1',
      generationId: 'generation-1',
      entityType: 'CanonicalObservation',
      baselineRevision: 42,
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      cursor: 'observation-b',
      snapshotComplete: false,
      updatedAt: NEW,
    })

    assert.deepEqual(await progress.get({
      streamId: 'stream-1',
      generationId: 'generation-1',
      entityType: 'CanonicalObservation',
    }), {
      streamId: 'stream-1',
      generationId: 'generation-1',
      entityType: 'CanonicalObservation',
      baselineRevision: 42,
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      cursor: 'observation-b',
      snapshotComplete: false,
      updatedAt: NEW,
    })

    await progress.put({
      streamId: 'stream-1',
      generationId: 'generation-1',
      entityType: 'CanonicalObservation',
      baselineRevision: 42,
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      cursor: 'observation-c',
      snapshotComplete: true,
      updatedAt: '2026-09-16T01:00:00.000Z',
    })
    assert.equal((await progress.get({
      streamId: 'stream-1',
      generationId: 'generation-1',
      entityType: 'CanonicalObservation',
    }))?.snapshotComplete, true)
  } finally {
    await storage.close()
  }
})
