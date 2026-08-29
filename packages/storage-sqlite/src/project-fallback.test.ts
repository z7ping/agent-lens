import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

function seedProjectlessData(storage: SqliteStorageService, prefix: string) {
  const now = '2026-08-29T05:40:00.000Z'
  storage.db.prepare(`
    INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
    VALUES (?, 'local', 'win32', 'x64', ?, ?)
  `).run(`host-${prefix}`, now, now)
  storage.db.prepare(`INSERT OR IGNORE INTO agent_products(id, name) VALUES ('codex', 'Codex')`).run()
  storage.db.prepare(`
    INSERT INTO agent_installations(id, host_id, product_id, first_seen_at, last_seen_at)
    VALUES (?, ?, 'codex', ?, ?)
  `).run(`install-${prefix}`, `host-${prefix}`, now, now)
  storage.db.prepare(`
    INSERT INTO workspaces(id, host_id, project_id, path)
    VALUES (?, ?, NULL, ?)
  `).run(`workspace-${prefix}`, `host-${prefix}`, `C:\\work\\${prefix}`)
  storage.db.prepare(`
    INSERT INTO logical_sessions(id, installation_id, project_id, workspace_id, started_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(`logical-${prefix}`, `install-${prefix}`, `workspace-${prefix}`, now)
  storage.db.prepare(`
    INSERT INTO source_sessions(id, source_id, installation_id, native_session_id, logical_session_id)
    VALUES (?, 'codex', ?, ?, ?)
  `).run(`source-session-${prefix}`, `install-${prefix}`, `native-${prefix}`, `logical-${prefix}`)
  storage.db.prepare(`
    INSERT INTO observations(
      id, host_id, installation_id, project_id, workspace_id,
      logical_session_id, source_session_id, kind, captured_at, payload_json
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'message', ?, '{}')
  `).run(
    `observation-${prefix}`,
    `host-${prefix}`,
    `install-${prefix}`,
    `workspace-${prefix}`,
    `logical-${prefix}`,
    `source-session-${prefix}`,
    now,
  )
}

test('workspace path supplies a fallback project and propagates it to sessions and observations', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    seedProjectlessData(storage, 'demo')

    const workspace = storage.db.prepare(`
      SELECT project_id FROM workspaces WHERE id = 'workspace-demo'
    `).get() as { project_id: string | null }
    assert.equal(workspace.project_id, 'project-demo')

    const project = storage.db.prepare(`
      SELECT repository_identity FROM projects WHERE id = 'project-demo'
    `).get() as { repository_identity: string | null }
    assert.equal(project.repository_identity, 'C:\\work\\demo')

    const session = storage.db.prepare(`
      SELECT project_id FROM logical_sessions WHERE id = 'logical-demo'
    `).get() as { project_id: string | null }
    const observation = storage.db.prepare(`
      SELECT project_id FROM observations WHERE id = 'observation-demo'
    `).get() as { project_id: string | null }
    assert.equal(session.project_id, 'project-demo')
    assert.equal(observation.project_id, 'project-demo')

    const now = '2026-08-29T05:40:00.000Z'
    storage.db.prepare(`
      INSERT INTO projects(id, name, repository_identity, created_at, last_seen_at)
      VALUES ('project-explicit', 'agent-lens', 'https://github.com/z7ping/agent-lens', ?, ?)
    `).run(now, now)
    storage.db.prepare(`
      UPDATE workspaces SET project_id = 'project-explicit' WHERE id = 'workspace-demo'
    `).run()

    let upgradedWorkspace = storage.db.prepare(`
      SELECT project_id FROM workspaces WHERE id = 'workspace-demo'
    `).get() as { project_id: string | null }
    let upgradedSession = storage.db.prepare(`
      SELECT project_id FROM logical_sessions WHERE id = 'logical-demo'
    `).get() as { project_id: string | null }
    let upgradedObservation = storage.db.prepare(`
      SELECT project_id FROM observations WHERE id = 'observation-demo'
    `).get() as { project_id: string | null }
    assert.equal(upgradedWorkspace.project_id, 'project-explicit')
    assert.equal(upgradedSession.project_id, 'project-explicit')
    assert.equal(upgradedObservation.project_id, 'project-explicit')

    // 模拟后续来源只再次报告 workspacePath，而没有 repositoryRoot/gitRemote。
    storage.db.prepare(`
      UPDATE workspaces SET project_id = NULL WHERE id = 'workspace-demo'
    `).run()

    upgradedWorkspace = storage.db.prepare(`
      SELECT project_id FROM workspaces WHERE id = 'workspace-demo'
    `).get() as { project_id: string | null }
    upgradedSession = storage.db.prepare(`
      SELECT project_id FROM logical_sessions WHERE id = 'logical-demo'
    `).get() as { project_id: string | null }
    upgradedObservation = storage.db.prepare(`
      SELECT project_id FROM observations WHERE id = 'observation-demo'
    `).get() as { project_id: string | null }
    assert.equal(upgradedWorkspace.project_id, 'project-explicit')
    assert.equal(upgradedSession.project_id, 'project-explicit')
    assert.equal(upgradedObservation.project_id, 'project-explicit')
  } finally {
    storage.close()
  }
})

test('schema v11 backfills project identity for data created before the migration', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    for (const trigger of [
      'trg_workspace_project_fallback_insert',
      'trg_workspace_project_fallback_update',
      'trg_workspace_project_propagate',
      'trg_logical_session_project_fallback_insert',
      'trg_logical_session_project_fallback_update',
      'trg_observation_project_fallback_insert',
      'trg_observation_project_fallback_update',
    ]) {
      storage.db.exec(`DROP TRIGGER IF EXISTS ${trigger}`)
    }
    storage.db.prepare('DELETE FROM schema_migrations WHERE version = 11').run()

    seedProjectlessData(storage, 'legacy')
    assert.equal(
      (storage.db.prepare(`SELECT project_id FROM observations WHERE id = 'observation-legacy'`).get() as { project_id: string | null }).project_id,
      null,
    )

    await storage.migrate()

    const workspace = storage.db.prepare(`
      SELECT project_id FROM workspaces WHERE id = 'workspace-legacy'
    `).get() as { project_id: string | null }
    const session = storage.db.prepare(`
      SELECT project_id FROM logical_sessions WHERE id = 'logical-legacy'
    `).get() as { project_id: string | null }
    const observation = storage.db.prepare(`
      SELECT project_id FROM observations WHERE id = 'observation-legacy'
    `).get() as { project_id: string | null }
    const migration = storage.db.prepare(`
      SELECT name FROM schema_migrations WHERE version = 11
    `).get() as { name: string }

    assert.equal(workspace.project_id, 'project-legacy')
    assert.equal(session.project_id, 'project-legacy')
    assert.equal(observation.project_id, 'project-legacy')
    assert.equal(migration.name, 'workspace-project-fallback')
  } finally {
    storage.close()
  }
})
