import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('storage migrations keep heavy indexes out of startup and maintenance creates them later', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()

    const migrations = storage.db.prepare(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number; name: string }>
    assert.equal(migrations.at(-1)?.version, 27)
    assert.equal(migrations.at(-1)?.name, 'replication-entity-heads')

    const indexesBefore = storage.db.prepare("PRAGMA index_list('observations')").all() as Array<{ name: string }>
    const namesBefore = new Set(indexesBefore.map(item => item.name))
    assert.ok(namesBefore.has('idx_observations_kind_timeline_order'))
    assert.ok(namesBefore.has('idx_observations_installation_kind_timeline_order'))
    assert.ok(namesBefore.has('idx_observations_source_native_event'))
    assert.ok(namesBefore.has('idx_observations_source_native_parent'))
    assert.ok(namesBefore.has('idx_observations_parent'))
    assert.equal(namesBefore.has('idx_observations_captured_at'), false)

    const evidenceIndexesBefore = storage.db.prepare("PRAGMA index_list('evidence')").all() as Array<{ name: string }>
    assert.equal(evidenceIndexesBefore.some(index => index.name === 'idx_evidence_captured_at'), false)

    const sourceRecordIndexesBefore = storage.db.prepare("PRAGMA index_list('source_records')")
      .all() as Array<{ name: string }>
    assert.equal(sourceRecordIndexesBefore.some(index => index.name === 'idx_source_records_parser_replay'), false)
    assert.equal(sourceRecordIndexesBefore.some(index => index.name === 'idx_source_records_payload_compression_pending'), false)

    const ensured = await storage.maintenance.ensureDeferredIndexes()
    assert.deepEqual(new Set(ensured.created), new Set([
      'idx_source_records_parser_replay',
      'idx_observations_captured_at',
      'idx_evidence_captured_at',
    ]))

    const indexesAfter = storage.db.prepare("PRAGMA index_list('observations')").all() as Array<{ name: string }>
    assert.ok(indexesAfter.some(index => index.name === 'idx_observations_captured_at'))
    const evidenceIndexesAfter = storage.db.prepare("PRAGMA index_list('evidence')").all() as Array<{ name: string }>
    assert.ok(evidenceIndexesAfter.some(index => index.name === 'idx_evidence_captured_at'))
    const sourceRecordIndexesAfter = storage.db.prepare("PRAGMA index_list('source_records')")
      .all() as Array<{ name: string }>
    assert.ok(sourceRecordIndexesAfter.some(index => index.name === 'idx_source_records_parser_replay'))
    assert.equal(sourceRecordIndexesAfter.some(index => index.name === 'idx_source_records_payload_compression_pending'), false)

    const sourceRecordColumns = storage.db.prepare("PRAGMA table_info('source_records')")
      .all() as Array<{ name: string }>
    assert.ok(sourceRecordColumns.some(column => column.name === 'payload_encoding'))
    assert.ok(sourceRecordColumns.some(column => column.name === 'payload_blob'))
    const checkpointColumns = storage.db.prepare("PRAGMA table_info('source_checkpoints')")
      .all() as Array<{ name: string }>
    assert.ok(checkpointColumns.some(column => column.name === 'revision'))

    const assetBindingColumns = storage.db.prepare("PRAGMA table_info('asset_bindings')")
      .all() as Array<{ name: string }>
    assert.ok(assetBindingColumns.some(column => column.name === 'scope'))
    assert.ok(assetBindingColumns.some(column => column.name === 'scope_root'))
    const assetBindingIndexes = storage.db.prepare("PRAGMA index_list('asset_bindings')")
      .all() as Array<{ name: string }>
    assert.ok(assetBindingIndexes.some(index => index.name === 'idx_asset_bindings_scope'))

    const checkpointTriggers = storage.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'trg_source_checkpoint_revision_guard'
    `).all() as Array<{ name: string }>
    assert.equal(checkpointTriggers.length, 1)

    const maintenanceColumns = storage.db.prepare("PRAGMA table_info('maintenance_jobs')")
      .all() as Array<{ name: string }>
    assert.ok(maintenanceColumns.some(column => column.name === 'revision'))
    assert.ok(maintenanceColumns.some(column => column.name === 'priority'))

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
      'replication_bootstrap_generations',
      'replication_canonical_changes',
      'replication_capture_watermarks',
      'replication_change_progress',
      'replication_entity_heads',
      'replication_entity_state',
      'replication_frozen_batches',
      'replication_journal_state',
      'replication_pending_entities',
      'replication_reconciliation_cursors',
      'replication_reconciliation_cycles',
      'replication_snapshot_bootstrap_progress',
      'replication_stream_authorizations',
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


test('v27 从已有 v26 journal 回填 Entity Head 并补独立 Root watermark', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()
    await storage.replication.ensureStream({
      relationshipId: 'rel-upgrade',
      hubId: 'hub-upgrade',
      streamId: 'stream-upgrade',
      generationId: 'gen-upgrade',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      now: '2026-09-17T05:30:00.000Z',
    })

    storage.db.exec(`
      DROP TRIGGER IF EXISTS trg_replication_entity_head_after_change;
      DROP TABLE IF EXISTS replication_entity_heads;
      DELETE FROM schema_migrations WHERE version = 27;
      DELETE FROM replication_capture_watermarks
      WHERE stream_id = 'stream-upgrade'
        AND entity_type IN (
          'SessionRelationship',
          'Coverage',
          'AssetDefinition',
          'AssetBinding',
          'AssetStateObservation',
          'ToolDefinition'
        );
    `)

    await storage.repositories.coverage.put({
      id: 'coverage-pre-v27',
      subjectType: 'node',
      subjectId: 'node-upgrade',
      capability: 'history',
      status: 'complete',
      evidenceRefs: [],
    })
    await storage.repositories.coverage.put({
      id: 'coverage-pre-v27',
      subjectType: 'node',
      subjectId: 'node-upgrade',
      capability: 'history',
      status: 'partial',
      reason: 'latest before v27',
      evidenceRefs: [],
    })

    const latestJournal = storage.db.prepare(`
      SELECT revision, changed_at AS changedAt
      FROM replication_canonical_changes
      WHERE entity_type = 'Coverage'
        AND origin_entity_id = 'coverage-pre-v27'
      ORDER BY revision DESC
      LIMIT 1
    `).get() as { revision: number; changedAt: string }

    assert.equal(await storage.migrate(), 27)

    const head = storage.db.prepare(`
      SELECT latest_revision AS latestRevision,
             latest_changed_at AS latestChangedAt
      FROM replication_entity_heads
      WHERE entity_type = 'Coverage'
        AND origin_entity_id = 'coverage-pre-v27'
    `).get() as { latestRevision: number; latestChangedAt: string }
    assert.deepEqual(head, {
      latestRevision: latestJournal.revision,
      latestChangedAt: latestJournal.changedAt,
    })

    const independentWatermarks = storage.db.prepare(`
      SELECT entity_type AS entityType,
             captured_revision AS capturedRevision,
             dependency_state AS dependencyState
      FROM replication_capture_watermarks
      WHERE stream_id = 'stream-upgrade'
        AND entity_type IN (
          'SessionRelationship',
          'Coverage',
          'AssetDefinition',
          'AssetBinding',
          'AssetStateObservation',
          'ToolDefinition'
        )
      ORDER BY entity_type
    `).all() as Array<{
      entityType: string
      capturedRevision: number
      dependencyState: string
    }>
    assert.equal(independentWatermarks.length, 6)
    assert.ok(independentWatermarks.every(item => item.capturedRevision === 0))
    assert.ok(independentWatermarks.every(item => item.dependencyState === 'dependent'))

    const current = await storage.replicationIndependentRoots.get(
      'Coverage',
      'coverage-pre-v27',
    )
    assert.equal(current?.entityType, 'Coverage')
    if (current?.entityType === 'Coverage') {
      assert.equal(current.entity.status, 'partial')
      assert.equal(current.entity.reason, 'latest before v27')
    }
  } finally {
    await storage.close()
  }
})
