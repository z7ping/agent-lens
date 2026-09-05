import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

async function setup() {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  storage.db.exec(`
    INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
    VALUES ('host', 'host', 'test', 'x64', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO agent_products(id, name) VALUES ('codex', 'Codex');
    INSERT INTO agent_installations(id, host_id, product_id, first_seen_at, last_seen_at)
    VALUES ('install', 'host', 'codex', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO logical_sessions(id, installation_id) VALUES ('logical', 'install');
    INSERT INTO source_sessions(id, source_id, installation_id, native_session_id, logical_session_id)
    VALUES ('source-session', 'codex', 'install', 'native-session', 'logical');
    INSERT INTO source_records(
      id, source_id, installation_id, source_session_native_id, native_type,
      captured_at, locator_json, payload_json, parser_version
    ) VALUES
      ('record-a', 'codex', 'install', 'native-session', 'response_item/message',
       '2026-09-01T00:00:00.000Z', '{}', '{}', '1'),
      ('record-b', 'codex', 'install', 'native-session', 'response_item/message',
       '2026-09-01T00:00:01.000Z', '{}', '{}', '1');
    INSERT INTO observations(
      id, host_id, installation_id, logical_session_id, source_session_id,
      kind, captured_at, payload_json
    ) VALUES
      ('a-unknown', 'host', 'install', 'logical', 'source-session',
       'unknown', '2026-09-01T00:00:02.000Z', '{}'),
      ('b-tool', 'host', 'install', 'logical', 'source-session',
       'tool.call', '2026-09-01T00:00:03.000Z', '{"callId":"c1","toolName":"Skill","input":{"skill":"review-code"}}'),
      ('c-tool', 'host', 'install', 'logical', 'source-session',
       'tool.result', '2026-09-01T00:00:04.000Z', '{"call_id":"c1","success":false,"duration_ms":12}');
    INSERT INTO evidence(
      id, capture_method, derivation, confidence, source_record_id, captured_at
    ) VALUES
      ('evidence-a', 'native-log', 'reported', 'exact', 'record-a', '2026-09-01T00:00:02.000Z');
    INSERT INTO observation_evidence(observation_id, evidence_id)
    VALUES ('a-unknown', 'evidence-a');
  `)

  // Simulate rows that existed before migrations 17/18. Current triggers populated
  // them during setup, so remove only the materialized rows before exercising the
  // maintenance backfill path.
  storage.db.exec(`
    DELETE FROM unknown_observation_projection;
    DELETE FROM tool_usage_fact_projection;
  `)
  return storage
}

test('Unknown history projection backfills with a stable cursor', async () => {
  const storage = await setup()
  try {
    assert.equal((await storage.unknownObservationProjection.summary()).total, 0)
    const first = await storage.projectionBackfill.backfillUnknownObservations(undefined, 1)
    assert.equal(first.scanned, 1)
    assert.equal(first.written, 1)
    assert.equal(first.cursor, 'a-unknown')
    assert.equal(first.hasMore, true)
    assert.equal((await storage.unknownObservationProjection.summary()).total, 1)

    const second = await storage.projectionBackfill.backfillUnknownObservations(first.cursor, 1)
    assert.equal(second.scanned, 0)
    assert.equal(second.hasMore, false)
  } finally {
    await storage.close()
  }
})

test('Tool usage history projection resumes across bounded batches', async () => {
  const storage = await setup()
  try {
    const first = await storage.projectionBackfill.backfillToolUsageFacts(undefined, 1)
    assert.equal(first.scanned, 1)
    assert.equal(first.cursor, 'b-tool')
    assert.equal(first.hasMore, true)

    const second = await storage.projectionBackfill.backfillToolUsageFacts(first.cursor, 1)
    assert.equal(second.scanned, 1)
    assert.equal(second.cursor, 'c-tool')
    assert.equal(second.hasMore, true)

    const done = await storage.projectionBackfill.backfillToolUsageFacts(second.cursor, 1)
    assert.equal(done.scanned, 0)
    assert.equal(done.hasMore, false)

    const rows = storage.db.prepare(`
      SELECT observation_id, tool_name, call_id, success, duration_ms
      FROM tool_usage_fact_projection
      ORDER BY observation_id
    `).all()
    assert.deepEqual(rows, [
      { observation_id: 'b-tool', tool_name: 'Skill', call_id: 'c1', success: null, duration_ms: null },
      { observation_id: 'c-tool', tool_name: null, call_id: 'c1', success: 0, duration_ms: 12 },
    ])
  } finally {
    await storage.close()
  }
})
