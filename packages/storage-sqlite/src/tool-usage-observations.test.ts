import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('tool usage reader filters canonical tool observations without loading evidence', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const { db } = storage
    const t0 = '2026-08-26T00:00:00.000Z'
    const t1 = '2026-08-26T00:00:01.000Z'
    const t2 = '2026-08-26T00:00:02.000Z'

    db.prepare('INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('host-1', 'host', 'linux', 'x64', t0, t2)
    db.prepare('INSERT INTO agent_products(id, name, vendor, homepage) VALUES (?, ?, ?, ?)')
      .run('product-1', 'Agent', 'AgentLens', null)
    db.prepare(`
      INSERT INTO agent_installations(id, host_id, product_id, version, executable, config_root, data_root, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `).run('installation-1', 'host-1', 'product-1', t0, t2)
    db.prepare('INSERT INTO projects(id, name, repository_identity, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run('project-1', 'Test', 'repo:test', t0, t2)
    db.prepare('INSERT INTO logical_sessions(id, installation_id, project_id, workspace_id, title, started_at, ended_at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
      .run('session-1', 'installation-1', 'project-1', 'Session', t0, t2)
    db.prepare('INSERT INTO source_sessions(id, source_id, installation_id, native_session_id, logical_session_id, native_parent_session_id) VALUES (?, ?, ?, ?, ?, NULL)')
      .run('source-session-1', 'codex', 'installation-1', 'native-1', 'session-1')

    const insertObservation = db.prepare(`
      INSERT INTO observations(
        id, host_id, installation_id, project_id, workspace_id, logical_session_id, source_session_id,
        interaction_id, actor_id, kind, source_sequence, canonical_sequence, occurred_at, captured_at, payload_json
      ) VALUES (?, 'host-1', 'installation-1', 'project-1', NULL, 'session-1', 'source-session-1', NULL, NULL, ?, ?, ?, ?, ?, ?)
    `)
    insertObservation.run('call-1', 'tool.call', 1, 1, t0, t0, JSON.stringify({ callId: 'c1', toolName: 'Read' }))
    insertObservation.run('result-1', 'tool.result', 2, 2, t1, t1, JSON.stringify({ callId: 'c1', success: true }))
    insertObservation.run('call-2', 'tool.call', 3, 3, t2, t2, JSON.stringify({ callId: 'c2', toolName: 'Write' }))

    const calls = await storage.toolUsageObservations.query({
      kind: 'tool.call',
      installationId: 'installation-1',
      projectId: 'project-1',
      sourceId: 'codex',
      limit: 10,
    })
    assert.deepEqual(calls.map(item => item.id), ['call-1', 'call-2'])
    assert.equal(calls[0]?.sourceId, 'codex')
    assert.equal(calls[0]?.productId, 'product-1')
    assert.equal(calls[0]?.projectId, 'project-1')

    const afterFirst = await storage.toolUsageObservations.query({
      kind: 'tool.call',
      after: { effectiveAt: t0, sequence: 1, id: 'call-1' },
      limit: 10,
    })
    assert.deepEqual(afterFirst.map(item => item.id), ['call-2'])

    const wrongSource = await storage.toolUsageObservations.query({ kind: 'tool.call', sourceId: 'claude', limit: 10 })
    assert.equal(wrongSource.length, 0)

    const evidenceCount = Number((db.prepare('SELECT COUNT(*) AS count FROM evidence').get() as { count: number }).count)
    assert.equal(evidenceCount, 0)
  } finally {
    storage.close()
  }
})
