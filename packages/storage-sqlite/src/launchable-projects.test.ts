import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'
import { SqliteLaunchableProjectReader } from './launchable-projects'
import { refreshLaunchableSessionIndex } from './launchable-project-index'

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
  summary?: boolean
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
  refreshLaunchableSessionIndex(storage.db, undefined, {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
  })
  if (input.summary !== false) {
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


test('launchable project reader does not hide canonical sessions while summary projection is missing', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    seedBase(storage)
    seedSession(storage, {
      projectId: 'canonical-only',
      projectName: 'Canonical Only',
      repositoryIdentity: 'z7ping/canonical-only',
      workspaceId: 'workspace-canonical-only',
      workspacePath: '/workspace/canonical-only',
      sessionId: 'session-canonical-only',
      endedAt: isoMinute(9),
      summary: false,
    })

    const projectionCount = storage.db.prepare(
      'SELECT COUNT(*) AS count FROM session_summary_projection',
    ).get() as { count: number }
    assert.equal(projectionCount.count, 0)

    const result = await storage.launchableProjects.query({ limit: 10 })
    assert.deepEqual(result.items.map(item => item.projectId), ['canonical-only'])
    assert.equal(result.items[0]?.workspaces[0]?.workspacePath, '/workspace/canonical-only')
    assert.equal(result.items[0]?.lastSeenAt, isoMinute(9))
  } finally {
    storage.close()
  }
})


test('launchable project reader hydrates a candidate page with one workspace batch query', async () => {
  const prepared: string[] = []
  const executor = {
    db: {
      prepare(sql: string) {
        prepared.push(sql)
        return {
          all(...args: unknown[]) {
            if (sql.includes('WITH project_activity AS')) {
              assert.deepEqual(args, [4])
              return [
                {
                  project_key: 'project-a',
                  project_id: 'project-a',
                  project_name: 'Project A',
                  repository_identity: null,
                  last_seen_at: isoMinute(3),
                },
                {
                  project_key: 'project-b',
                  project_id: 'project-b',
                  project_name: 'Project B',
                  repository_identity: null,
                  last_seen_at: isoMinute(2),
                },
                {
                  project_key: 'project-c',
                  project_id: 'project-c',
                  project_name: 'Project C',
                  repository_identity: null,
                  last_seen_at: isoMinute(1),
                },
              ]
            }
            assert.match(sql, /WITH workspace_activity AS/)
            assert.match(sql, /ROW_NUMBER\(\) OVER/)
            assert.deepEqual(args, ['project-a', 'project-b', 'project-c', 64])
            return [
              {
                project_key: 'project-a',
                workspace_id: 'workspace-a',
                workspace_path: '/workspace/a',
                last_seen_at: isoMinute(3),
              },
              {
                project_key: 'project-b',
                workspace_id: 'workspace-b',
                workspace_path: '/workspace/b',
                last_seen_at: isoMinute(2),
              },
              {
                project_key: 'project-c',
                workspace_id: 'workspace-c',
                workspace_path: '/workspace/c',
                last_seen_at: isoMinute(1),
              },
            ]
          },
        }
      },
    },
    run<T>(operation: () => T): Promise<T> {
      return Promise.resolve(operation())
    },
  }

  const reader = new SqliteLaunchableProjectReader(executor as never)
  const result = await reader.query({ limit: 3 })

  assert.equal(prepared.length, 2)
  assert.deepEqual(
    result.items.map(item => item.workspaces[0]?.workspacePath),
    ['/workspace/a', '/workspace/b', '/workspace/c'],
  )
})


test('canonical repository writes maintain the launchable project index incrementally', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    seedBase(storage)
    await storage.repositories.sessions.putProject({
      id: 'indexed-project',
      name: 'Indexed Project',
      repositoryIdentity: 'z7ping/indexed-project',
      createdAt: BASE_TIME,
      lastSeenAt: isoMinute(1),
    })
    await storage.repositories.sessions.putWorkspace({
      id: 'indexed-workspace',
      hostId: 'host-local',
      projectId: 'indexed-project',
      path: '/workspace/indexed-project',
    })
    await storage.repositories.sessions.putLogicalSession({
      id: 'indexed-session',
      installationId: 'install-pi',
      projectId: 'indexed-project',
      workspaceId: 'indexed-workspace',
      startedAt: isoMinute(2),
      endedAt: isoMinute(3),
    })

    const projectIndex = storage.db.prepare(`
      SELECT project_name, repository_identity, last_seen_at
      FROM launchable_project_index
      WHERE project_key = 'indexed-project'
    `).get() as { project_name: string; repository_identity: string; last_seen_at: string }
    assert.deepEqual(projectIndex, {
      project_name: 'Indexed Project',
      repository_identity: 'z7ping/indexed-project',
      last_seen_at: isoMinute(3),
    })

    const result = await storage.launchableProjects.query({ limit: 10 })
    assert.equal(result.items[0]?.projectId, 'indexed-project')
    assert.equal(result.items[0]?.workspaces[0]?.workspacePath, '/workspace/indexed-project')

    await storage.repositories.sessions.putWorkspace({
      id: 'indexed-workspace',
      hostId: 'host-local',
      projectId: 'indexed-project',
      path: '/workspace/indexed-project-moved',
    })
    const moved = await storage.launchableProjects.query({ limit: 10 })
    assert.equal(moved.items[0]?.workspaces[0]?.workspacePath, '/workspace/indexed-project-moved')
    assert.equal(moved.items[0]?.workspaces[0]?.validationStatus, 'unknown')
  } finally {
    storage.close()
  }
})

test('launchable workspace validation cache persists without touching canonical session history', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    seedBase(storage)
    seedSession(storage, {
      projectId: 'cached-project',
      projectName: 'Cached Project',
      workspaceId: 'cached-workspace',
      workspacePath: '/workspace/cached-project',
      sessionId: 'cached-session',
      endedAt: isoMinute(4),
    })

    await storage.launchableProjects.recordWorkspaceValidation?.({
      workspaceId: 'cached-workspace',
      workspacePath: '/workspace/cached-project',
      status: 'valid',
      validatedAt: isoMinute(5),
    })
    const result = await storage.launchableProjects.query({ limit: 10 })

    assert.equal(result.items[0]?.workspaces[0]?.validationStatus, 'valid')
    assert.equal(result.items[0]?.workspaces[0]?.validatedAt, isoMinute(5))
  } finally {
    storage.close()
  }
})
