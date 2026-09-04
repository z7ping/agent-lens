import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

async function setup() {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const now = '2026-09-04T00:00:00.000Z'
  storage.db.prepare(`INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('host', 'host', 'test', 'x64', now, now)
  storage.db.prepare(`INSERT INTO agent_products(id, name) VALUES (?, ?)`)
    .run('codex', 'Codex')
  storage.db.prepare(`INSERT INTO agent_installations(id, host_id, product_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
    .run('install', 'host', 'codex', now, now)
  return { storage, now }
}

function session(storage: SqliteStorageService, id: string, nativeId: string, now: string) {
  storage.db.prepare(`INSERT INTO logical_sessions(id, installation_id, started_at, ended_at) VALUES (?, 'install', ?, ?)`)
    .run(id, now, now)
  storage.db.prepare(`INSERT INTO source_sessions(id, source_id, installation_id, native_session_id, logical_session_id) VALUES (?, 'codex', 'install', ?, ?)`)
    .run(`source-${id}`, nativeId, id)
}

function observation(storage: SqliteStorageService, id: string, logicalSessionId: string, kind: string, payload: unknown, now: string, sequence: number) {
  storage.db.prepare(`
    INSERT INTO observations(
      id, host_id, installation_id, logical_session_id, source_session_id,
      kind, source_sequence, canonical_sequence, captured_at, payload_json
    ) VALUES (?, 'host', 'install', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, logicalSessionId, `source-${logicalSessionId}`, kind, sequence, sequence, now, JSON.stringify(payload))
}

test('summary uses real user turns and counts system context separately', async () => {
  const { storage, now } = await setup()
  try {
    session(storage, 'root', 'root-native', now)
    observation(storage, 'system', 'root', 'context.injected', { text: 'system', provenance: { actualAuthor: 'system' } }, now, 1)
    observation(storage, 'user', 'root', 'message.user', { text: '真实用户请求' }, now, 2)
    observation(storage, 'tool', 'root', 'tool.call', { nativeToolName: 'exec' }, now, 3)
    await storage.sessionSummaryProjection.rebuild({ logicalSessionId: 'root' })

    const item = (await storage.sessionSummaries.query({ logicalSessionId: 'root', limit: 1 })).items[0]
    assert.ok(item)
    assert.equal(item.interactionCount, 1)
    assert.equal(item.userTurnCount, 1)
    assert.equal(item.systemContextCount, 1)
    assert.equal(item.toolCount, 1)
    assert.deepEqual(item.firstUserPayload, { text: '真实用户请求' })
  } finally {
    await storage.close()
  }
})

test('root task summary counts nested internal review and child points back to task-root', async () => {
  const { storage, now } = await setup()
  try {
    session(storage, 'root', 'root-native', now)
    session(storage, 'parent-worker', 'worker-native', now)
    session(storage, 'review', 'review-native', now)
    observation(storage, 'root-user', 'root', 'message.user', { text: '修复问题' }, now, 1)
    observation(storage, 'worker-meta', 'parent-worker', 'session.lifecycle', { event: 'session.discovered', sessionActivity: 'subagent' }, now, 1)
    observation(storage, 'review-meta', 'review', 'session.lifecycle', { event: 'session.discovered', sessionActivity: 'internal-review', activitySourceLabel: 'Guardian 审查' }, now, 1)

    const putRelationship = storage.repositories.sessions.putRelationship.bind(storage.repositories.sessions)
    await putRelationship({ id: 'root-worker', fromSessionId: 'root', toSessionId: 'parent-worker', type: 'task-root', confidence: 'exact', evidenceRefs: [] })
    await putRelationship({ id: 'root-review', fromSessionId: 'root', toSessionId: 'review', type: 'task-root', confidence: 'exact', evidenceRefs: [] })
    await putRelationship({ id: 'worker-review', fromSessionId: 'parent-worker', toSessionId: 'review', type: 'internal-review', confidence: 'exact', evidenceRefs: [] })

    await storage.sessionSummaryProjection.rebuild({ strategy: 'atomic' })
    const root = (await storage.sessionSummaries.query({ logicalSessionId: 'root', limit: 1 })).items[0]
    const review = (await storage.sessionSummaries.query({ logicalSessionId: 'review', limit: 1 })).items[0]
    assert.ok(root)
    assert.ok(review)
    assert.equal(root.internalReviewCount, 1)
    assert.equal(review.parentSessionId, 'root')
    assert.equal(review.sessionActivity, 'internal-review')
    assert.equal(review.activitySourceLabel, 'Guardian 审查')
  } finally {
    await storage.close()
  }
})
