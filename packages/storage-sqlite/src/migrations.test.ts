import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('storage migrations include tool usage timeline indexes', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()

    const migrations = storage.db.prepare(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number; name: string }>
    assert.equal(migrations.at(-1)?.version, 6)
    assert.equal(migrations.at(-1)?.name, 'observation-tool-usage-order-indexes')

    const indexes = storage.db.prepare("PRAGMA index_list('observations')").all() as Array<{ name: string }>
    const names = new Set(indexes.map(item => item.name))
    assert.ok(names.has('idx_observations_kind_timeline_order'))
    assert.ok(names.has('idx_observations_installation_kind_timeline_order'))
  } finally {
    storage.close()
  }
})
