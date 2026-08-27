import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('storage migrations include durable replication state and canonical change journal', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()

    const migrations = storage.db.prepare(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number; name: string }>
    assert.equal(migrations.at(-1)?.version, 8)
    assert.equal(migrations.at(-1)?.name, 'replication-canonical-change-journal')

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
      'replication_entity_state',
      'replication_frozen_batches',
      'replication_pending_entities',
      'replication_reconciliation_cursors',
      'replication_streams',
    ])

    const triggers = storage.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'trg_rep_change_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    assert.equal(triggers.length, 36)
  } finally {
    storage.close()
  }
})
