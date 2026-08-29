import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('workspace path supplies a fallback project and propagates it to sessions and observations', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const now = '2026-08-29T05:40:00.000Z'
    storage.db.prepare(`
      INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
      VALUES ('host-1', 'local', 'win32', 'x64', ?, ?)
    `).run(now, now)
    storage.db.prepare(`INSERT INTO agent_products(id, name) VALUES ('codex', 'Codex')`).run()
    storage.db.prepare(`
      INSERT INTO agent_installations(id, host_id, product_id, first_seen_at, last_seen_at)
      VALUES ('install-1', 'host-1', 'codex', ?, ?)
    `).run(now, now)

    storage.db.prepare(`
      INSERT INTO workspaces(id, host_id, project_id, path)
      VALUES ('workspace-demo', 'host-1', NULL, 'C:\\work\\agent-lens')
    `).run()

    const workspace = storage.db.prepare(`
      SELECT project_id FROM workspaces WHERE id = 'workspace-demo'
    `).get() as { project_id: string | null }
    assert.equal(workspace.project_id, 'project-demo')

    const project = storage.db.prepare(`
      SELECT repository_identity FROM projects WHERE id = 'project-demo'
    `).get() as { repository_identity: string | null }
    assert.equal(project.repository_identity, 'C:\\work\\agent-lens')

    storage.db.prepare(`
      INSERT INTO logical_sessions(id, installation_id, project_id, workspace_id, started_at)
      VALUES ('logical-1', 'install-1', NULL, 'workspace-demo', ?)
    `).run(now)
    storage.db.prepare(`
      INSERT INTO source_sessions(id, source_id, installation_id, native_session_id, logical_session_id)
      VALUES ('source-session-1', 'codex', 'install-1', 'native-1', 'logical-1')
    `).run()
    storage.db.prepare(`
      INSERT INTO observations(
        id, host_id, installation_id, project_id, workspace_id,
        logical_session_id, source_session_id, kind, captured_at, payload_json
      ) VALUES (
        'observation-1', 'host-1', 'install-1', NULL, 'workspace-demo',
        'logical-1', 'source-session-1', 'message', ?, '{}'
      )
    `).run(now)

    const session = storage.db.prepare(`
      SELECT project_id FROM logical_sessions WHERE id = 'logical-1'
    `).get() as { project_id: string | null }
    const observation = storage.db.prepare(`
      SELECT project_id FROM observations WHERE id = 'observation-1'
    `).get() as { project_id: string | null }
    assert.equal(session.project_id, 'project-demo')
    assert.equal(observation.project_id, 'project-demo')

    storage.db.prepare(`
      INSERT INTO projects(id, name, repository_identity, created_at, last_seen_at)
      VALUES ('project-explicit', 'agent-lens', 'https://github.com/z7ping/agent-lens', ?, ?)
    `).run(now, now)
    storage.db.prepare(`
      UPDATE workspaces SET project_id = 'project-explicit' WHERE id = 'workspace-demo'
    `).run()

    const upgradedSession = storage.db.prepare(`
      SELECT project_id FROM logical_sessions WHERE id = 'logical-1'
    `).get() as { project_id: string | null }
    const upgradedObservation = storage.db.prepare(`
      SELECT project_id FROM observations WHERE id = 'observation-1'
    `).get() as { project_id: string | null }
    assert.equal(upgradedSession.project_id, 'project-explicit')
    assert.equal(upgradedObservation.project_id, 'project-explicit')
  } finally {
    storage.close()
  }
})
