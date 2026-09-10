import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LaunchableProjectsResponseDto } from '@agent-lens/protocol'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

test('GET /api/v1/projects/launchable returns only current-host launchable cwd and supports server search', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lens-project-route-'))
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const now = '2026-09-11T01:00:00.000Z'

  storage.db.prepare(`
    INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
    VALUES ('host-local', 'local', ?, ?, ?, ?)
  `).run(process.platform, process.arch, now, now)
  storage.db.prepare(`INSERT INTO agent_products(id, name) VALUES ('pi', 'Pi')`).run()
  storage.db.prepare(`
    INSERT INTO agent_installations(id, host_id, product_id, first_seen_at, last_seen_at)
    VALUES ('install-pi', 'host-local', 'pi', ?, ?)
  `).run(now, now)
  storage.db.prepare(`
    INSERT INTO projects(id, name, repository_identity, created_at, last_seen_at)
    VALUES ('project-agent-lens', 'AgentLens', 'z7ping/agent-lens', ?, ?)
  `).run(now, now)
  storage.db.prepare(`
    INSERT INTO workspaces(id, host_id, project_id, path)
    VALUES ('workspace-agent-lens', 'host-local', 'project-agent-lens', ?)
  `).run(cwd)
  storage.db.prepare(`
    INSERT INTO logical_sessions(id, installation_id, project_id, workspace_id, started_at, ended_at)
    VALUES ('session-agent-lens', 'install-pi', 'project-agent-lens', 'workspace-agent-lens', ?, ?)
  `).run(now, now)
  storage.db.prepare(`
    INSERT INTO session_summary_projection(
      logical_session_id, installation_id, started_at, ended_at,
      observation_count, user_message_count, tool_count, error_count,
      source_ids_json, rebuilt_at
    ) VALUES ('session-agent-lens', 'install-pi', ?, ?, 1, 1, 0, 0, '["pi"]', ?)
  `).run(now, now, now)

  const surface = await startHttpSurface(storage, { port: 0 })
  const base = `http://${surface.host}:${surface.port}`

  try {
    const response = await fetch(`${base}/api/v1/projects/launchable?search=agentlens&limit=20`)
    assert.equal(response.status, 200)
    const body = await response.json() as LaunchableProjectsResponseDto
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0]?.projectId, 'project-agent-lens')
    assert.equal(body.items[0]?.projectName, 'AgentLens')
    assert.equal(body.items[0]?.workspacePath, cwd)
    assert.equal(body.meta.hasMore, false)

    const missing = await fetch(`${base}/api/v1/projects/launchable?search=does-not-exist`)
    assert.equal(missing.status, 200)
    assert.deepEqual((await missing.json() as LaunchableProjectsResponseDto).items, [])
  } finally {
    await surface.dispose()
    storage.close()
    await rm(cwd, { recursive: true, force: true })
  }
})
