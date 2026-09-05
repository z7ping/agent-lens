import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('storage migrations include replay, diagnostics and maintenance projections', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()

    const migrations = storage.db.prepare(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number; name: string }>
    assert.equal(migrations.at(-1)?.version, 19)
    assert.equal(migrations.at(-1)?.name, 'source-record-payload-compression')

    const indexes = storage.db.prepare("PRAGMA index_list('observations')").all() as Array<{ name: string }>
    const names = new Set(indexes.map(item => item.name))
    assert.ok(names.has('idx_observations_kind_timeline_order'))
    assert.ok(names.has('idx_observations_installation_kind_timeline_order'))
    assert.ok(names.has('idx_observations_source_native_event'))
    assert.ok(names.has('idx_observations_source_native_parent'))
    assert.ok(names.has('idx_observations_parent'))
    assert.ok(names.has('idx_observations_captured_at'))

    const evidenceIndexes = storage.db.prepare("PRAGMA index_list('evidence')").all() as Array<{ name: string }>
    assert.ok(evidenceIndexes.some(index => index.name === 'idx_evidence_captured_at'))

    const sourceRecordIndexes = storage.db.prepare("PRAGMA index_list('source_records')")
      .all() as Array<{ name: string }>
    assert.ok(sourceRecordIndexes.some(index => index.name === 'idx_source_records_parser_replay'))
    assert.ok(sourceRecordIndexes.some(index => index.name === 'idx_source_records_payload_compression_pending'))
    const sourceRecordColumns = storage.db.prepare("PRAGMA table_info('source_records')")
      .all() as Array<{ name: string }>
    assert.ok(sourceRecordColumns.some(column => column.name === 'payload_encoding'))
    assert.ok(sourceRecordColumns.some(column => column.name === 'payload_blob'))

    const projectionTables = storage.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('unknown_observation_projection', 'tool_usage_fact_projection')
      ORDER BY name
    `).all() as Array<{ name: string }>
    assert.deepEqual(projectionTables.map(row => row.name), [
      'tool_usage_fact_projection',
      'unknown_observation_projection',
    ])

    const candidateColumns = storage.db.prepare("PRAGMA table_info('session_relationship_candidates')")
      .all() as Array<{ name: string }>
    assert.ok(candidateColumns.some(column => column.name === 'source_record_id'))
    const candidateIndexes = storage.db.prepare("PRAGMA index_list('session_relationship_candidates')")
      .all() as Array<{ name: string }>
    assert.ok(candidateIndexes.some(index => index.name === 'idx_relationship_candidates_source_record'))

    const replicationTables = storage.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'replication_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    assert.deepEqual(replicationTables.map(row => row.name), [
      'replication_batch_items',
      'replication_canonical_changes',
      'replication_change_progress',
      'replication_entity_state',
      'replication_frozen_batches',
      'replication_pending_entities',
      'replication_reconciliation_cursors',
      'replication_streams',
    ])

    const hubTables = storage.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'hub_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    assert.deepEqual(hubTables.map(row => row.name), [
      'hub_committed_batches',
      'hub_remote_replica_entities',
      'hub_remote_shared_identity_state',
      'hub_replica_generations',
      'hub_replication_streams',
    ])

    const triggers = storage.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'trg_rep_change_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    assert.equal(triggers.length, 36)

    const projectTriggers = storage.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'trg_%project_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    assert.ok(projectTriggers.some(item => item.name === 'trg_workspace_project_fallback_insert'))
    assert.ok(projectTriggers.some(item => item.name === 'trg_observation_project_fallback_insert'))
  } finally {
    storage.close()
  }
})


test('late native parent can repair child relation without losing native parent id', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    const repo = storage.repositories.observations
    assert.ok(repo.findIdByNativeEventId && repo.linkChildrenToParent)
    storage.db.exec(`
      INSERT INTO hosts (id, name, platform, arch, created_at, last_seen_at)
      VALUES ('host-1', 'test', 'linux', 'x64', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
      INSERT INTO agent_products (id, name) VALUES ('product-1', 'test');
      INSERT INTO agent_installations (id, host_id, product_id, first_seen_at, last_seen_at)
      VALUES ('install-1', 'host-1', 'product-1', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
      INSERT INTO logical_sessions (id, installation_id) VALUES ('logical-1', 'install-1');
      INSERT INTO source_sessions (id, source_id, installation_id, native_session_id, logical_session_id)
      VALUES ('source-1', 'pi', 'install-1', 'native-session-1', 'logical-1');
    `)
    const common = {
      hostId: 'host-1', installationId: 'install-1', logicalSessionId: 'logical-1',
      sourceSessionId: 'source-1', kind: 'unknown' as const, capturedAt: '2026-08-20T00:00:00.000Z',
      payload: {}, evidenceRefs: [],
    }
    await repo.put({ id: 'child-1', ...common, nativeEventId: 'C', nativeParentEventId: 'B' })
    assert.equal((await repo.get('child-1'))?.parentObservationId, undefined)
    await repo.put({ id: 'parent-1', ...common, nativeEventId: 'B' })
    await repo.linkChildrenToParent('source-1', 'B', 'parent-1')
    const child = await repo.get('child-1')
    assert.equal(child?.nativeParentEventId, 'B')
    assert.equal(child?.parentObservationId, 'parent-1')
  } finally {
    storage.close()
  }
})
