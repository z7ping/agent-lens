import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

async function storage() {
  const value = new SqliteStorageService({ path: ':memory:' })
  await value.migrate()
  return value
}

test('Entity Head keeps latest revision metadata while Independent Root body comes from Canonical tables', async () => {
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

test('Independent Root Snapshot uses durable Entity Head changedAt for from-now filtering', async () => {
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
      changedAtOnOrAfter: '2026-09-17T01:00:00.000Z',
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
