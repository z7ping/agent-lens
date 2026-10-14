import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'
import { SqliteExecutor } from './executor'
import { SqliteFacetScopeReader } from './facet-scope'

test('all-project facet uses the latest indexed session across the complete history', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    storage.db.exec(`
      INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
      VALUES ('host', 'local', 'test', 'x64', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO agent_products(id, name) VALUES ('pi', 'Pi');
      INSERT INTO agent_installations(id, host_id, product_id, first_seen_at, last_seen_at)
      VALUES ('installation', 'host', 'pi', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO projects(id, name, created_at, last_seen_at) VALUES
        ('recent', 'Recently used', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('old', 'Older', '2026-01-01T00:00:00.000Z', '2026-10-14T00:00:00.000Z');
      INSERT INTO logical_sessions(id, installation_id, project_id, started_at, ended_at) VALUES
        ('recent-early', 'installation', 'recent', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
        ('recent-late', 'installation', 'recent', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
        ('old-session', 'installation', 'old', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    `)
    const insert = storage.db.prepare(`
      INSERT INTO session_summary_projection(
        logical_session_id, installation_id, started_at, ended_at,
        observation_count, user_message_count, tool_count, error_count,
        source_ids_json, rebuilt_at
      ) VALUES (?, 'installation', ?, ?, 1, 1, 0, 0, '["pi"]', ?)
    `)
    for (const [id, at] of [
      ['recent-early', '2026-05-01T00:00:00.000Z'],
      ['recent-late', '2026-10-13T00:00:00.000Z'],
      ['old-session', '2026-07-01T00:00:00.000Z'],
    ]) insert.run(id, at, at, at)

    const result = await new SqliteFacetScopeReader(new SqliteExecutor(storage.db)).query()
    assert.deepEqual(result.projects.map(item => [item.id, item.lastActivityAt]), [
      ['recent', '2026-10-13T00:00:00.000Z'],
      ['old', '2026-07-01T00:00:00.000Z'],
    ])
    assert.equal(result.from, '2026-05-01T00:00:00.000Z')
    assert.equal(result.to, '2026-10-13T00:00:00.000Z')
  } finally {
    storage.close()
  }
})
