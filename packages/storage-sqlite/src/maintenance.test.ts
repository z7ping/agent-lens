import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { SqliteStorageService } from './storage'

async function seedIdentity(storage: SqliteStorageService) {
  const now = '2026-09-01T00:00:00.000Z'
  await storage.repositories.hosts.put({
    id: 'host', name: 'host', platform: 'linux', arch: 'x64', createdAt: now, lastSeenAt: now,
  })
  await storage.repositories.installations.putProduct({ id: 'codex', name: 'Codex' })
  await storage.repositories.installations.put({
    id: 'install', hostId: 'host', productId: 'codex', firstSeenAt: now, lastSeenAt: now,
  })
}

test('SourceRecord 大 payload 透明 gzip，旧 JSON 可分批迁移且读取语义不变', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    await seedIdentity(storage)
    const payload = { text: 'AgentLens '.repeat(2000), nested: { ok: true } }
    await storage.repositories.sourceRecords.put({
      id: 'compressed',
      sourceId: 'codex',
      installationId: 'install',
      nativeType: 'response_item/message',
      capturedAt: '2026-09-01T00:00:00.000Z',
      locator: { kind: 'external', key: 'compressed' },
      payload,
      parserVersion: '19',
    })

    const raw = storage.db.prepare(`
      SELECT payload_json, payload_encoding, length(payload_blob) AS blob_bytes
      FROM source_records WHERE id = 'compressed'
    `).get() as { payload_json: string; payload_encoding: string; blob_bytes: number }
    assert.equal(raw.payload_encoding, 'gzip-json')
    assert.equal(raw.payload_json, 'null')
    assert.ok(raw.blob_bytes > 0)
    assert.deepEqual((await storage.repositories.sourceRecords.get('compressed'))?.payload, payload)

    storage.db.prepare(`
      INSERT INTO source_records(
        id, source_id, installation_id, native_type, captured_at, locator_json, payload_json, parser_version
      ) VALUES (?, 'codex', 'install', 'legacy', ?, '{}', ?, '1')
    `).run('legacy', '2026-08-01T00:00:00.000Z', JSON.stringify(payload))
    const migrated = await storage.maintenance.compressSourceRecords(10)
    assert.equal(migrated.scanned, 1)
    assert.equal(migrated.compressed, 1)
    assert.ok(migrated.savedBytes > 0)
    assert.deepEqual((await storage.repositories.sourceRecords.get('legacy'))?.payload, payload)
  } finally {
    await storage.close()
  }
})

test('Retention 默认 dry-run，并按完整逻辑会话事务清理孤立 Evidence 与 SourceRecord', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    await seedIdentity(storage)
    storage.db.exec(`
      INSERT INTO logical_sessions(id, installation_id, title, started_at, ended_at)
      VALUES ('old-session', 'install', 'old', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
      INSERT INTO source_sessions(id, source_id, installation_id, native_session_id, logical_session_id)
      VALUES ('old-source-session', 'codex', 'install', 'native-old', 'old-session');
      INSERT INTO source_records(
        id, source_id, installation_id, source_session_native_id, native_type,
        captured_at, locator_json, payload_json, parser_version
      ) VALUES (
        'old-record', 'codex', 'install', 'native-old', 'message',
        '2026-01-01T00:00:00.000Z', '{}', '{"text":"old"}', '19'
      );
      INSERT INTO observations(
        id, host_id, installation_id, logical_session_id, source_session_id,
        kind, captured_at, payload_json
      ) VALUES (
        'old-observation', 'host', 'install', 'old-session', 'old-source-session',
        'message.agent', '2026-01-01T00:00:01.000Z', '{"text":"old"}'
      );
      INSERT INTO evidence(
        id, capture_method, derivation, confidence, source_record_id, captured_at
      ) VALUES ('old-evidence', 'native-log', 'reported', 'exact', 'old-record', '2026-01-01T00:00:01.000Z');
      INSERT INTO observation_evidence(observation_id, evidence_id)
      VALUES ('old-observation', 'old-evidence');
      INSERT INTO session_summary_projection(
        logical_session_id, installation_id, started_at, ended_at,
        observation_count, user_message_count, tool_count, error_count,
        source_ids_json, rebuilt_at
      ) VALUES (
        'old-session', 'install', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z',
        1, 0, 0, 0, '["codex"]', '2026-09-01T00:00:00.000Z'
      );
    `)

    const preview = await storage.maintenance.purgeSessions({
      before: '2026-06-01T00:00:00.000Z',
      limit: 10,
    })
    assert.equal(preview.dryRun, true)
    assert.deepEqual(preview.sessionIds, ['old-session'])
    assert.ok(storage.db.prepare(`SELECT 1 FROM logical_sessions WHERE id = 'old-session'`).get())

    const purged = await storage.maintenance.purgeSessions({
      before: '2026-06-01T00:00:00.000Z',
      limit: 10,
      dryRun: false,
    })
    assert.equal(purged.sessionsDeleted, 1)
    assert.equal(purged.sourceSessionsDeleted, 1)
    assert.equal(purged.observationsDeleted, 1)
    assert.equal(purged.evidenceDeleted, 1)
    assert.equal(purged.sourceRecordsDeleted, 1)
    for (const [table, id] of [
      ['logical_sessions', 'old-session'],
      ['source_sessions', 'old-source-session'],
      ['observations', 'old-observation'],
      ['evidence', 'old-evidence'],
      ['source_records', 'old-record'],
    ] as const) {
      assert.equal(storage.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id), undefined)
    }
  } finally {
    await storage.close()
  }
})

test('VACUUM INTO 生成独立紧凑库，不替换在线数据库', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-lens-vacuum-'))
  const source = join(root, 'source.db')
  const compacted = join(root, 'compacted.db')
  const storage = new SqliteStorageService({ path: source })
  try {
    await storage.migrate()
    await seedIdentity(storage)
    const result = await storage.maintenance.vacuumInto(compacted)
    assert.equal(result.path, compacted)
    assert.ok(result.bytes > 0)
    assert.equal(existsSync(compacted), true)
    const copy = new Database(compacted, { readonly: true })
    try {
      const version = copy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
      assert.equal(version.version, 19)
    } finally {
      copy.close()
    }
  } finally {
    await storage.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('索引审计只报告重复/前缀候选，不自动删除', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    storage.db.exec(`
      CREATE INDEX idx_test_source_short ON source_records(source_id);
      CREATE INDEX idx_test_source_long ON source_records(source_id, installation_id);
    `)
    const audit = await storage.maintenance.auditIndexes()
    assert.ok(audit.some(item =>
      item.index === 'idx_test_source_short'
      && item.coveredBy === 'idx_test_source_long'
      && item.reason === 'prefix'))
    const names = (storage.db.prepare("PRAGMA index_list('source_records')").all() as Array<{ name: string }>).map(item => item.name)
    assert.ok(names.includes('idx_test_source_short'))
    assert.ok(names.includes('idx_test_source_long'))
  } finally {
    await storage.close()
  }
})
