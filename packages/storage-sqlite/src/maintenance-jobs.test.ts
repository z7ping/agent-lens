import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('Maintenance Job persists progress and uses revision CAS', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const pending = await storage.maintenanceJobs.ensure({
      id: 'parser-replay:all',
      type: 'parser-replay',
      scope: 'all',
      priority: 50,
      progress: { records: 0 },
    })
    assert.equal(pending.state, 'pending')
    assert.equal(pending.revision, 0)

    const running = await storage.maintenanceJobs.transition(pending.id, pending.revision, {
      state: 'running',
      progress: { records: 100 },
    })
    assert.ok(running)
    assert.equal(running.state, 'running')
    assert.ok(running.revision > pending.revision)
    assert.deepEqual(running.progress, { records: 100 })

    const stale = await storage.maintenanceJobs.transition(pending.id, pending.revision, {
      state: 'completed',
    })
    assert.equal(stale, null)

    const completed = await storage.maintenanceJobs.transition(running.id, running.revision, {
      state: 'completed',
      progress: { records: 200 },
    })
    assert.equal(completed?.state, 'completed')
    assert.ok(completed?.completedAt)
    assert.deepEqual(completed?.progress, { records: 200 })
  } finally {
    await storage.close()
  }
})

test('Maintenance Job list is ordered by priority and can filter state', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    await storage.maintenanceJobs.ensure({ id: 'compression', type: 'source-record-compression', scope: 'legacy', priority: 60 })
    await storage.maintenanceJobs.ensure({ id: 'projection', type: 'projection-rebuild', scope: 'session', priority: 40 })
    await storage.maintenanceJobs.ensure({ id: 'replay', type: 'parser-replay', scope: 'all', priority: 50 })

    assert.deepEqual(
      (await storage.maintenanceJobs.list(['pending'])).map(job => job.id),
      ['projection', 'replay', 'compression'],
    )
  } finally {
    await storage.close()
  }
})
