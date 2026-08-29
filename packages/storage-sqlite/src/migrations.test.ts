import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('storage migrations include replication, Hub replica state, and workspace project fallback', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()

    const migrations = storage.db.prepare(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number; name: string }>
    assert.equal(migrations.at(-1)?.version, 11)
    assert.equal(migrations.at(-1)?.name, 'workspace-project-fallback')

    const indexes = storage.db.prepare("PRAGMA index_list('observations')").all() as Array<{ name: string }>
    const names = new Set(indexes.map(item => item.name))
    assert.ok(names.has('idx_observations_kind_timeline_order'))
    assert.ok(names.has('idx_observations_installation_kind_timeline_order'))

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
