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
