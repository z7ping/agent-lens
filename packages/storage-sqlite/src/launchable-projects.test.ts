import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

const BASE_TIME = '2026-09-01T00:00:00.000Z'

function isoMinute(index: number): string {
  return new Date(Date.parse(BASE_TIME) + index * 60_000).toISOString()
}

function seedBase(storage: SqliteStorageService): void {
  storage.db.prepare(`
    INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
    VALUES ('host-local', 'local', 'linux', 'x64', ?, ?)
  `).run(BASE_TIME, BASE_TIME)
  storage.db.prepare(`
    INSERT INTO agent_products(id, name) VALUES ('pi', 'Pi')
  `).run()
  storage.db.prepare(`
    INSERT INTO agent_installations(id, host_id, product_id, first_seen_at, last_seen_at)
    VALUES ('install-pi', 'host-local', 'pi', ?, ?)
  `).run(BASE_TIME, BASE_TIME)
}

function seedSession(storage: SqliteStorageService, input: {
  projectId: string
  projectName?: string
  repositoryIdentity?: string
  workspaceId: string
  workspacePath: string
  sessionId: string
  endedAt: string
}): void {
  storage.db.prepare(`
    INSERT OR IGNORE INTO projects(id, name, repository_identity, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.projectId,
    input.projectName ?? null,
    input.repositoryIdentity ?? null,
    BASE_TIME,
    input.endedAt,
  )
  storage.db.prepare(`
    UPDATE projects
    SET name = COALESCE(?, name),
        repository_identity = COALESCE(?, repository_identity),
        last_seen_at = MAX(last_seen_at, ?)
    WHERE id = ?
  `).run(input.projectName ?? null, input.repositoryIdentity ?? null, input.endedAt, input.projectId)
  storage.db.prepare(`
    INSERT OR IGNORE INTO workspaces(id, host_id, project_id, path)
    VALUES (?, 'host-local', ?, ?)
  `).run(input.workspaceId, input.projectId, input.workspacePath)
  storage.db.prepare(`
    INSERT INTO logical_sessions(id, installation_id, project_id, workspace_id, started_at, ended_at)
    VALUES (?, 'install-pi', ?, ?, ?, ?)
  `).run(input.sessionId, input.projectId, input.workspaceId, input.endedAt, input.endedAt)
  storage.db.prepare(`
    INSERT INTO session_summary_projection(
      logical_session_id,
      installation_id,
      started_at,
      ended_at,
      observation_count,
      user_message_count,
      tool_count,
      error_count,
      source_ids_json,
      rebuilt_at
    ) VALUES (?, 'install-pi', ?, ?, 1, 1, 0, 0, '["pi"]', ?)
  `).run(input.sessionId, input.endedAt, input.endedAt, input.endedAt)
}

test('launchable project reader is independent of the old recent-20 review window and paginates stably', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    seedBase(storage)
    for (let index = 0; index < 25; index += 1) {
      seedSession(storage, {
        projectId: `project-${String(index).padStart(2, '0')}`,
        projectName: `Project ${String(index).padStart(2, '0')}`,
        workspaceId: `workspace-${index}`,
        workspacePath: `/workspace/project-${index}`,
        sessionId: `session-${index}`,
        endedAt: isoMinute(index),
      })
    }

    const first = await storage.launchableProjects.query({ limit: 20 })
    assert.equal(first.items.length, 20)
    assert.equal(first.hasMore, true)
    assert.equal(first.items[0]?.projectId, 'project-24')
    assert.equal(first.items.at(-1)?.projectId, 'project-05')

    const boundary = first.items.at(-1)!
    const second = await storage.launchableProjects.query({
      limit: 20,
      after: { lastSeenAt: boundary.lastSeenAt, key: boundary.key },
    })
    assert.deepEqual(second.items.map(item => item.projectId), [
      'project-04',
      'project-03',
      'project-02',
      'project-01',
      'project-00',
    ])
    assert.equal(second.hasMore, false)
  } finally {
    storage.close()
  }
})

test('launchable project reader deduplicates project identity and orders its workspaces by real session activity', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    seedBase(storage)
    seedSession(storage, {
      projectId: 'agent-lens',
      projectName: 'AgentLens',
      repositoryIdentity: 'z7ping/agent-lens',
      workspaceId: 'workspace-old',
      workspacePath: '/workspace/old/agent-lens',
      sessionId: 'session-old',
      endedAt: isoMinute(2),
    })
    seedSession(storage, {
      projectId: 'agent-lens',
      projectName: 'AgentLens',
      repositoryIdentity: 'z7ping/agent-lens',
      workspaceId: 'workspace-new',
      workspacePath: '/workspace/current/agent-lens',
      sessionId: 'session-new',
      endedAt: isoMinute(8),
    })
    seedSession(storage, {
      projectId: 'other',
      projectName: 'Other',
      workspaceId: 'workspace-other',
      workspacePath: '/workspace/other',
      sessionId: 'session-other',
      endedAt: isoMinute(5),
    })

    const result = await storage.launchableProjects.query({ limit: 10 })
    assert.deepEqual(result.items.map(item => item.projectId), ['agent-lens', 'other'])
    assert.deepEqual(result.items[0]?.workspaces.map(item => item.workspacePath), [
      '/workspace/current/agent-lens',
      '/workspace/old/agent-lens',
    ])
    assert.equal(result.items[0]?.lastSeenAt, isoMinute(8))
  } finally {
    storage.close()
  }
})

test('launchable project reader searches the same server-side project name repository and cwd source', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    seedBase(storage)
    seedSession(storage, {
      projectId: 'agent-lens',
      projectName: 'AgentLens',
      repositoryIdentity: 'z7ping/agent-lens',
      workspaceId: 'workspace-agent-lens',
      workspacePath: '/workspace/observability/agent-lens',
      sessionId: 'session-agent-lens',
      endedAt: isoMinute(3),
    })
    seedSession(storage, {
      projectId: 'narratica',
      projectName: 'Narratica',
      repositoryIdentity: 'z7ping/narratica',
      workspaceId: 'workspace-narratica',
      workspacePath: '/workspace/story/narratica',
      sessionId: 'session-narratica',
      endedAt: isoMinute(4),
    })

    assert.deepEqual(
      (await storage.launchableProjects.query({ limit: 10, search: 'agentlens' })).items.map(item => item.projectId),
      ['agent-lens'],
    )
    assert.deepEqual(
      (await storage.launchableProjects.query({ limit: 10, search: 'z7ping/narratica' })).items.map(item => item.projectId),
      ['narratica'],
    )
    assert.deepEqual(
      (await storage.launchableProjects.query({ limit: 10, search: 'observability' })).items.map(item => item.projectId),
      ['agent-lens'],
    )
  } finally {
    storage.close()
  }
})
