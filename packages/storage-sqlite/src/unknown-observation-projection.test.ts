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
    ) VALUES (
      'unknown-1', 'host', 'install', 'logical', 'source-session',
      'unknown', '2026-09-01T00:00:02.000Z', '{}'
    );
    INSERT INTO evidence(
      id, capture_method, derivation, confidence, source_record_id, captured_at
    ) VALUES
      ('evidence-a', 'native-log', 'reported', 'exact', 'record-a', '2026-09-01T00:00:02.000Z'),
      ('evidence-b', 'native-log', 'reported', 'exact', 'record-b', '2026-09-01T00:00:02.000Z');
  `)
  return storage
}

test('Unknown 投影按 observation/source/nativeType 去重并随 Replay 语义变化撤销', async () => {
  const storage = await setup()
  try {
    storage.db.prepare(`
      INSERT INTO observation_evidence(observation_id, evidence_id) VALUES ('unknown-1', 'evidence-a')
    `).run()
    let summary = await storage.unknownObservationProjection.summary()
    assert.equal(summary.total, 1)
    assert.deepEqual(summary.groups.map(item => [item.sourceId, item.nativeType, item.count]), [
      ['codex', 'response_item/message', 1],
    ])

    storage.db.prepare(`
      INSERT INTO observation_evidence(observation_id, evidence_id) VALUES ('unknown-1', 'evidence-b')
    `).run()
    summary = await storage.unknownObservationProjection.summary()
    assert.equal(summary.total, 1, 'same observation/group must not be counted twice')

    storage.db.prepare(`UPDATE observations SET kind = 'message.agent' WHERE id = 'unknown-1'`).run()
    summary = await storage.unknownObservationProjection.summary()
    assert.equal(summary.total, 0, 'unknown -> known must remove projection membership')

    storage.db.prepare(`UPDATE observations SET kind = 'unknown' WHERE id = 'unknown-1'`).run()
    summary = await storage.unknownObservationProjection.summary()
    assert.equal(summary.total, 1, 'known -> unknown must restore membership from current evidence')

    storage.db.prepare(`
      DELETE FROM observation_evidence WHERE observation_id = 'unknown-1' AND evidence_id = 'evidence-a'
    `).run()
    summary = await storage.unknownObservationProjection.summary()
    assert.equal(summary.total, 1, 'remaining evidence in the same group keeps membership alive')

    storage.db.prepare(`
      DELETE FROM observation_evidence WHERE observation_id = 'unknown-1' AND evidence_id = 'evidence-b'
    `).run()
    summary = await storage.unknownObservationProjection.summary()
    assert.equal(summary.total, 0)
  } finally {
    await storage.close()
  }
})

test('Unknown 投影可从 Canonical Observation + Evidence 全量重建', async () => {
  const storage = await setup()
  try {
    storage.db.prepare(`
      INSERT INTO observation_evidence(observation_id, evidence_id) VALUES ('unknown-1', 'evidence-a')
    `).run()
    storage.db.prepare(`DELETE FROM unknown_observation_projection`).run()
    assert.equal((await storage.unknownObservationProjection.summary()).total, 0)

    await storage.unknownObservationProjection.rebuild()
    const summary = await storage.unknownObservationProjection.summary()
    assert.equal(summary.total, 1)
    assert.equal(summary.groups[0]?.lastSeenAt, '2026-09-01T00:00:02.000Z')
  } finally {
    await storage.close()
  }
})
