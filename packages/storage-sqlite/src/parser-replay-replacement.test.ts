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
  storage.db.prepare(`INSERT INTO logical_sessions(id, installation_id, started_at, ended_at) VALUES (?, ?, ?, ?)`)
    .run('session', 'install', now, now)
  storage.db.prepare(`INSERT INTO source_sessions(id, source_id, installation_id, native_session_id, logical_session_id) VALUES (?, ?, ?, ?, ?)`)
    .run('source-session', 'codex', 'install', 'native-session', 'session')
  return { storage, now }
}

function insertSourceRecord(storage: SqliteStorageService, id: string, parserVersion: string, now: string) {
  storage.db.prepare(`
    INSERT INTO source_records(
      id, source_id, installation_id, source_session_native_id, native_type,
      captured_at, locator_json, payload_json, parser_version
    ) VALUES (?, 'codex', 'install', 'native-session', 'response_item/message', ?, '{}', '{}', ?)
  `).run(id, now, parserVersion)
}

function insertEvidence(storage: SqliteStorageService, id: string, sourceRecordId: string, parserVersion: string, now: string) {
  storage.db.prepare(`
    INSERT INTO evidence(id, capture_method, derivation, confidence, source_record_id, parser_version, captured_at)
    VALUES (?, 'native-log', 'reported', 'high', ?, ?, ?)
  `).run(id, sourceRecordId, parserVersion, now)
}

function insertObservation(storage: SqliteStorageService, id: string, evidenceIds: string[], now: string) {
  storage.db.prepare(`
    INSERT INTO observations(
      id, host_id, installation_id, logical_session_id, source_session_id,
      kind, captured_at, payload_json
    ) VALUES (?, 'host', 'install', 'session', 'source-session', 'message.user', ?, '{}')
  `).run(id, now)
  const link = storage.db.prepare(`INSERT INTO observation_evidence(observation_id, evidence_id) VALUES (?, ?)`)
  for (const evidenceId of evidenceIds) link.run(id, evidenceId)
}

function replayRecord(id: string, now: string, parserVersion = '11') {
  return {
    id,
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: 'native-session',
    nativeType: 'response_item/message',
    capturedAt: now,
    locator: { kind: 'file' as const, path: '/tmp/rollout.jsonl', offset: 1 },
    payload: { type: 'response_item' },
    parserVersion,
  }
}

test('parser version change removes only stale canonical derivation and preserves SourceRecord/Evidence', async () => {
  const { storage, now } = await setup()
  try {
    insertSourceRecord(storage, 'record-old', '10', now)
    insertEvidence(storage, 'evidence-old', 'record-old', '10', now)
    insertObservation(storage, 'observation-old', ['evidence-old'], now)

    await storage.repositories.sourceRecords.put(replayRecord('record-old', now))

    assert.equal((await storage.repositories.sourceRecords.get('record-old'))?.parserVersion, '11')
    assert.equal(await storage.repositories.observations.get('observation-old'), null)
    assert.ok(await storage.repositories.evidence.get('evidence-old'))
  } finally {
    await storage.close()
  }
})

test('replay detaches one SourceRecord without deleting an observation supported by other evidence', async () => {
  const { storage, now } = await setup()
  try {
    insertSourceRecord(storage, 'record-old', '10', now)
    insertSourceRecord(storage, 'record-shared', '11', now)
    insertEvidence(storage, 'evidence-old', 'record-old', '10', now)
    insertEvidence(storage, 'evidence-shared', 'record-shared', '11', now)
    insertObservation(storage, 'observation-shared', ['evidence-old', 'evidence-shared'], now)

    await storage.repositories.sourceRecords.put(replayRecord('record-old', now))

    const observation = await storage.repositories.observations.get('observation-shared')
    assert.ok(observation)
    assert.deepEqual(observation.evidenceRefs, ['evidence-shared'])
    assert.ok(await storage.repositories.evidence.get('evidence-old'))
  } finally {
    await storage.close()
  }
})

test('replaying the same parser version is idempotent', async () => {
  const { storage, now } = await setup()
  try {
    insertSourceRecord(storage, 'record-current', '11', now)
    insertEvidence(storage, 'evidence-current', 'record-current', '11', now)
    insertObservation(storage, 'observation-current', ['evidence-current'], now)

    await storage.repositories.sourceRecords.put(replayRecord('record-current', now))
    await storage.repositories.sourceRecords.put(replayRecord('record-current', now))

    assert.ok(await storage.repositories.observations.get('observation-current'))
    assert.ok(await storage.repositories.evidence.get('evidence-current'))
  } finally {
    await storage.close()
  }
})
