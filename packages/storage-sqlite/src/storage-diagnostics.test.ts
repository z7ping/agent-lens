import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('health 不返回全量聚合，diagnostics 显式提供 Unknown/Coverage/增长统计', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const health = await storage.health()
    const healthDetails = health.details as Record<string, any>
    assert.equal(healthDetails.unknownObservations, undefined)
    assert.equal(healthDetails.coverage, undefined)
    assert.equal(healthDetails.dataGrowth.totals, undefined)
    assert.equal(healthDetails.dataGrowth.last7Days, undefined)

    const diagnostics = await storage.diagnostics()
    const details = diagnostics.details as Record<string, any>
    assert.equal(details.unknownObservations.total, 0)
    assert.deepEqual(details.unknownObservations.groups, [])
    assert.ok(details.coverage.summary)
    assert.equal(typeof details.dataGrowth.totals.sourceRecords, 'number')
    assert.equal(typeof details.dataGrowth.last7Days.sessions, 'number')
  } finally {
    await storage.close()
  }
})
