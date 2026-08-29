import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('storage migrations include project fallback and tool usage indexes', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  try {
    await storage.migrate()

    const migrations = storage.db.prepare(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number; name: string }>
    assert.equal(migrations.at(-1)?.version, 7)
    assert.equal(migrations.at(-1)?.name, 'workspace-project-fallback')

    const indexes = storage.db.prepare("PRAGMA index_list('observations')").all() as Array<{ name: string }>
    const names = new Set(indexes.map(item => item.name))
    assert.ok(names.has('idx_observations_kind_timeline_order'))
    assert.ok(names.has('idx_observations_installation_kind_timeline_order'))

    const triggers = storage.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'trg_%project_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    assert.ok(triggers.some(item => item.name === 'trg_workspace_project_fallback_insert'))
    assert.ok(triggers.some(item => item.name === 'trg_observation_project_fallback_insert'))
  } finally {
    storage.close()
  }
})
