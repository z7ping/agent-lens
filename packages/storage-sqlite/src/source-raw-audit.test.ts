import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

const NOW = '2026-09-16T00:00:00.000Z'

async function seedIdentity(storage: SqliteStorageService) {
  storage.db.prepare(`
    INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
    VALUES ('host-1', 'devbox', 'linux', 'x64', ?, ?)
  `).run(NOW, NOW)
  storage.db.prepare(`
    INSERT INTO agent_products(id, name) VALUES ('pi', 'Pi')
  `).run()
  storage.db.prepare(`
    INSERT INTO agent_installations(id, host_id, product_id, first_seen_at, last_seen_at)
    VALUES ('installation-1', 'host-1', 'pi', ?, ?)
  `).run(NOW, NOW)
  storage.db.prepare(`
    INSERT INTO logical_sessions(id, installation_id, started_at)
    VALUES ('session-1', 'installation-1', ?)
  `).run(NOW)
  storage.db.prepare(`
    INSERT INTO source_sessions(
      id, source_id, installation_id, native_session_id, logical_session_id
    ) VALUES ('source-session-1', 'pi', 'installation-1', 'native-session', 'session-1')
  `).run()
}

async function putRaw(storage: SqliteStorageService, id: string) {
  await storage.repositories.sourceRecords.put({
    id,
    sourceId: 'pi',
    installationId: 'installation-1',
    sourceSessionNativeId: 'native-session',
    nativeType: 'history/message',
    capturedAt: NOW,
    locator: { kind: 'file', path: '/tmp/session.jsonl', offset: 0 },
    fingerprint: id + '-fingerprint',
    payload: { raw: id },
    parserVersion: '1',
  })
}

test('Raw audit reader 区分 Evidence-only 与 Canonical+Evidence', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    await seedIdentity(storage)
    await putRaw(storage, 'raw-a')
    await putRaw(storage, 'raw-b')

    await storage.repositories.evidence.put({
      id: 'evidence-a',
      captureMethod: 'native-log',
      derivation: 'reported',
      confidence: 'high',
      sourceRecordId: 'raw-a',
      capturedAt: NOW,
    })
    await storage.repositories.evidence.put({
      id: 'evidence-b',
      captureMethod: 'native-log',
      derivation: 'reported',
      confidence: 'high',
      sourceRecordId: 'raw-b',
      capturedAt: NOW,
    })
    await storage.repositories.observations.put({
      id: 'observation-b',
      hostId: 'host-1',
      installationId: 'installation-1',
      logicalSessionId: 'session-1',
      sourceSessionId: 'source-session-1',
      kind: 'message.assistant',
      capturedAt: NOW,
      payload: { text: 'done' },
      evidenceRefs: ['evidence-b'],
    })

    const page = await storage.sourceRawAudit.list(undefined, 10)
    assert.equal(page.items.length, 2)
    const a = page.items.find(item => item.record.id === 'raw-a')
    const b = page.items.find(item => item.record.id === 'raw-b')
    assert.equal(a?.evidenceStable, true)
    assert.equal(a?.canonicalStable, false)
    assert.equal(b?.evidenceStable, true)
    assert.equal(b?.canonicalStable, true)
    assert.equal(b?.pinned, false)
  } finally {
    await storage.close()
  }
})


test('Raw audit 只读元数据，不解压 gzip Payload', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    await seedIdentity(storage)
    await storage.repositories.sourceRecords.put({
      id: 'raw-compressed',
      sourceId: 'pi',
      installationId: 'installation-1',
      sourceSessionNativeId: 'native-session',
      nativeType: 'history/message',
      capturedAt: NOW,
      locator: { kind: 'file', path: '/tmp/session.jsonl', offset: 42 },
      fingerprint: 'raw-compressed-fingerprint',
      payload: { text: 'x'.repeat(16_000) },
      parserVersion: '1',
    })

    const encoding = storage.db.prepare(`
      SELECT payload_encoding AS encoding
      FROM source_records
      WHERE id = 'raw-compressed'
    `).get() as { encoding: string }
    assert.equal(encoding.encoding, 'gzip-json')

    // Corrupt the blob deliberately. A normal SourceRecord get() would fail to
    // gunzip this payload, while Raw audit must remain metadata-only.
    storage.db.prepare(`
      UPDATE source_records
      SET payload_blob = ?, payload_json = 'null'
      WHERE id = 'raw-compressed'
    `).run(Buffer.from([0, 1, 2, 3]))

    const page = await storage.sourceRawAudit.list(undefined, 10)
    const item = page.items.find(value => value.record.id === 'raw-compressed')
    assert.ok(item)
    assert.equal(item.record.payload, null)
    assert.equal(item.record.locator.path, '/tmp/session.jsonl')
    assert.equal(item.record.locator.offset, 42)
    assert.equal(item.record.fingerprint, 'raw-compressed-fingerprint')
  } finally {
    await storage.close()
  }
})


test('Raw audit 分页固定本轮 rowid 上界，不混入审计中途新增记录', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    await seedIdentity(storage)
    await putRaw(storage, 'raw-a')
    await putRaw(storage, 'raw-b')
    await putRaw(storage, 'raw-c')

    const first = await storage.sourceRawAudit.list(undefined, 1)
    assert.deepEqual(first.items.map(item => item.record.id), ['raw-a'])
    assert.equal(first.hasMore, true)
    assert.ok(first.cursor)

    await putRaw(storage, 'raw-new-after-audit-started')

    const second = await storage.sourceRawAudit.list(first.cursor, 10)
    assert.deepEqual(second.items.map(item => item.record.id), ['raw-b', 'raw-c'])
    assert.equal(second.hasMore, false)
    assert.equal(second.cursor, undefined)

    const fresh = await storage.sourceRawAudit.list(undefined, 10)
    assert.deepEqual(
      fresh.items.map(item => item.record.id),
      ['raw-a', 'raw-b', 'raw-c', 'raw-new-after-audit-started'],
    )
  } finally {
    await storage.close()
  }
})
