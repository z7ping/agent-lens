import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

async function storage() {
  const value = new SqliteStorageService({ path: ':memory:' })
  await value.migrate()
  return value
}

test('Entity Head keeps latest revision metadata while Current-State Root body comes from Canonical tables', async () => {
  const db = await storage()
  try {
    await db.repositories.coverage.put({
      id: 'coverage-1',
      subjectType: 'host',
      subjectId: 'host-1',
      capability: 'history',
      status: 'partial',
      reason: 'initial',
      evidenceRefs: [],
    })

    const firstHead = db.db.prepare(`
      SELECT latest_revision AS latestRevision,
             latest_changed_at AS latestChangedAt
      FROM replication_entity_heads
      WHERE entity_type = 'Coverage' AND origin_entity_id = 'coverage-1'
    `).get() as { latestRevision: number; latestChangedAt: string }
    assert.ok(firstHead.latestRevision > 0)

    await db.repositories.coverage.put({
      id: 'coverage-1',
      subjectType: 'host',
      subjectId: 'host-1',
      capability: 'history',
      status: 'complete',
      reason: 'updated canonical body',
      evidenceRefs: [],
    })

    const secondHead = db.db.prepare(`
      SELECT latest_revision AS latestRevision,
             latest_changed_at AS latestChangedAt
      FROM replication_entity_heads
      WHERE entity_type = 'Coverage' AND origin_entity_id = 'coverage-1'
    `).get() as { latestRevision: number; latestChangedAt: string }
    assert.ok(secondHead.latestRevision > firstHead.latestRevision)

    const snapshot = await db.replicationIndependentRoots.get('Coverage', 'coverage-1')
    assert.equal(snapshot?.latestRevision, secondHead.latestRevision)
    assert.equal(snapshot?.changedAt, secondHead.latestChangedAt)
    assert.equal(snapshot?.entityType, 'Coverage')
    if (snapshot?.entityType === 'Coverage') {
      assert.equal(snapshot.entity.status, 'complete')
      assert.equal(snapshot.entity.reason, 'updated canonical body')
    }
  } finally {
    db.close()
  }
})

test('Current-State Root Snapshot uses durable Entity Head changedAt for from-now filtering', async () => {
  const db = await storage()
  try {
    await db.repositories.coverage.put({
      id: 'coverage-old',
      subjectType: 'host',
      subjectId: 'host-1',
      capability: 'history',
      status: 'complete',
      evidenceRefs: [],
    })
    await db.repositories.coverage.put({
      id: 'coverage-new',
      subjectType: 'host',
      subjectId: 'host-1',
      capability: 'assets',
      status: 'complete',
      evidenceRefs: [],
    })

    db.db.prepare(`
      UPDATE replication_entity_heads
      SET latest_changed_at = '2026-09-17T00:00:00.000Z'
      WHERE entity_type = 'Coverage' AND origin_entity_id = 'coverage-old'
    `).run()
    db.db.prepare(`
      UPDATE replication_entity_heads
      SET latest_changed_at = '2026-09-17T02:00:00.000Z'
      WHERE entity_type = 'Coverage' AND origin_entity_id = 'coverage-new'
    `).run()

    const page = await db.replicationIndependentRoots.scan({
      entityType: 'Coverage',
      changedAtOnOrAfter: '2026-09-17T03:00:00+02:00',
      limit: 100,
    })
    assert.deepEqual(
      page.items.map(item => item.originEntityId),
      ['coverage-new'],
    )
    assert.equal(page.done, true)
  } finally {
    db.close()
  }
})


test('Current-State Root restores gzip-compressed SourceRecord payload from canonical storage', async () => {
  const db = await storage()
  try {
    const now = '2026-09-17T03:00:00.000Z'
    await db.repositories.hosts.put({
      id: 'host-source-record',
      name: 'source-record-host',
      platform: 'linux',
      arch: 'x64',
      createdAt: now,
      lastSeenAt: now,
    })
    await db.repositories.installations.putProduct({
      id: 'product-source-record',
      name: 'Source Product',
    })
    await db.repositories.installations.put({
      id: 'install-source-record',
      hostId: 'host-source-record',
      productId: 'product-source-record',
      firstSeenAt: now,
      lastSeenAt: now,
    })
    const payload = { text: 'compressible-source-record-'.repeat(400) }
    await db.repositories.sourceRecords.put({
      id: 'source-record-compressed',
      sourceId: 'pi',
      installationId: 'install-source-record',
      nativeType: 'event',
      capturedAt: now,
      locator: { kind: 'file', path: '/tmp/source-record.jsonl' },
      payload,
      parserVersion: 'parser-1',
    })

    const raw = db.db.prepare(`
      SELECT payload_json AS payloadJson, payload_encoding AS payloadEncoding
      FROM source_records
      WHERE id = 'source-record-compressed'
    `).get() as { payloadJson: string; payloadEncoding: string }
    assert.equal(raw.payloadEncoding, 'gzip-json')
    assert.equal(raw.payloadJson, 'null')

    const root = await db.replicationIndependentRoots.get(
      'SourceRecord',
      'source-record-compressed',
    )
    assert.equal(root?.entityType, 'SourceRecord')
    if (root?.entityType === 'SourceRecord') {
      assert.deepEqual(root.entity.payload, payload)
    }
  } finally {
    db.close()
  }
})
