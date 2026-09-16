import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'

test('health 不返回全量聚合，diagnostics 显式提供存储与增长基线', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const health = await storage.health()
    const healthDetails = health.details as {
      unknownObservations?: unknown
      coverage?: unknown
      storageBreakdown?: unknown
      dataGrowth: {
        totals?: unknown
        last7Days?: unknown
        capacity: {
          scope: string
          longTermTotalLimitBytes: number | null
        }
      }
    }
    assert.equal(healthDetails.unknownObservations, undefined)
    assert.equal(healthDetails.coverage, undefined)
    assert.equal(healthDetails.storageBreakdown, undefined)
    assert.equal(healthDetails.dataGrowth.totals, undefined)
    assert.equal(healthDetails.dataGrowth.last7Days, undefined)
    assert.equal(healthDetails.dataGrowth.capacity.scope, 'hot-sqlite')
    assert.equal(healthDetails.dataGrowth.capacity.longTermTotalLimitBytes, null)

    const diagnostics = await storage.diagnostics()
    const details = diagnostics.details as {
      unknownObservations: { total: number, groups: unknown[] }
      coverage: { summary: unknown }
      storageBreakdown: {
        available: boolean
        categories: {
          canonical: { payloadBytes: number, allocatedBytes: number }
          evidence: { payloadBytes: number, allocatedBytes: number }
          sourceRaw: { payloadBytes: number, allocatedBytes: number }
          projection: { payloadBytes: number, allocatedBytes: number }
        }
      }
      reclaimableSpace: {
        estimateOnly: boolean
        estimatedBytes: number
        excludesSourceRaw: boolean
      }
      dataGrowth: {
        totals: { sourceRecords: number }
        last7Days: { sessions: number }
        last30Days: { sessions: number }
        bySource: unknown[]
        byAgent: unknown[]
        trend: { last7Days: unknown[], last30Days: unknown[] }
        metrics: {
          canonicalGrowthRate: {
            last30Days: { observationsPerDay: number, approxBytesPerDay: number }
          }
          storageAmplificationRate: {
            last30Days: number | null
          }
        }
      }
    }
    assert.equal(details.unknownObservations.total, 0)
    assert.deepEqual(details.unknownObservations.groups, [])
    assert.ok(details.coverage.summary)
    assert.equal(typeof details.dataGrowth.totals.sourceRecords, 'number')
    assert.equal(typeof details.dataGrowth.last7Days.sessions, 'number')
    assert.equal(typeof details.dataGrowth.last30Days.sessions, 'number')
    assert.equal(details.dataGrowth.trend.last7Days.length, 7)
    assert.equal(details.dataGrowth.trend.last30Days.length, 30)
    assert.deepEqual(details.dataGrowth.bySource, [])
    assert.deepEqual(details.dataGrowth.byAgent, [])
    assert.equal(typeof details.storageBreakdown.categories.canonical.payloadBytes, 'number')
    assert.equal(typeof details.storageBreakdown.categories.projection.allocatedBytes, 'number')
    assert.equal(details.reclaimableSpace.estimateOnly, true)
    assert.equal(details.reclaimableSpace.excludesSourceRaw, true)
    assert.equal(typeof details.reclaimableSpace.estimatedBytes, 'number')
    assert.equal(
      typeof details.dataGrowth.metrics.canonicalGrowthRate.last30Days.observationsPerDay,
      'number',
    )
    assert.equal(details.dataGrowth.metrics.storageAmplificationRate.last30Days, null)
  } finally {
    await storage.close()
  }
})

test('diagnostics 按 Source / Agent 统计增长并计算存储放大率', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const now = new Date().toISOString()
    storage.db.prepare(`
      INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
      VALUES ('host:local', 'local', 'test', 'test', ?, ?)
    `).run(now, now)
    storage.db.prepare(`
      INSERT INTO agent_products(id, name)
      VALUES ('pi', 'Pi')
    `).run()
    storage.db.prepare(`
      INSERT INTO agent_installations(
        id, host_id, product_id, first_seen_at, last_seen_at
      ) VALUES ('pi:local', 'host:local', 'pi', ?, ?)
    `).run(now, now)
    storage.db.prepare(`
      INSERT INTO logical_sessions(
        id, installation_id, started_at, ended_at
      ) VALUES ('session:1', 'pi:local', ?, ?)
    `).run(now, now)
    storage.db.prepare(`
      INSERT INTO source_sessions(
        id, source_id, installation_id, native_session_id, logical_session_id
      ) VALUES ('source-session:1', 'pi', 'pi:local', 'native:1', 'session:1')
    `).run()
    storage.db.prepare(`
      INSERT INTO source_records(
        id, source_id, installation_id, source_session_native_id, native_type,
        native_id, captured_at, locator_json, payload_json, parser_version
      ) VALUES (
        'source-record:1', 'pi', 'pi:local', 'native:1', 'message',
        'native-message:1', ?, '{"path":"session.jsonl"}',
        '{"role":"assistant","content":"raw payload"}', 'test'
      )
    `).run(now)
    storage.db.prepare(`
      INSERT INTO observations(
        id, host_id, installation_id, logical_session_id, source_session_id,
        kind, captured_at, payload_json
      ) VALUES (
        'observation:1', 'host:local', 'pi:local', 'session:1', 'source-session:1',
        'message.assistant', ?, '{"text":"canonical payload"}'
      )
    `).run(now)
    storage.db.prepare(`
      INSERT INTO evidence(
        id, capture_method, derivation, confidence, source_record_id,
        source_locator_json, captured_at
      ) VALUES (
        'evidence:1', 'history', 'parsed', 'high', 'source-record:1',
        '{"path":"session.jsonl","line":1}', ?
      )
    `).run(now)
    storage.db.prepare(`
      INSERT INTO observation_evidence(observation_id, evidence_id)
      VALUES ('observation:1', 'evidence:1')
    `).run()

    const diagnostics = await storage.diagnostics()
    const details = diagnostics.details as {
      storageBreakdown: {
        categories: {
          canonical: { payloadBytes: number }
          evidence: { payloadBytes: number }
          sourceRaw: { payloadBytes: number }
        }
      }
      dataGrowth: {
        bySource: Array<{
          sourceId: string
          last30Days: { records: number, approxBytes: number }
        }>
        byAgent: Array<{
          productId: string
          productName: string | null
          last30Days: { records: number, approxBytes: number }
        }>
        metrics: {
          canonicalGrowthRate: {
            last7Days: { observationsPerDay: number }
          }
          storageAmplificationRate: {
            last7Days: number | null
            last30Days: number | null
          }
        }
      }
    }

    assert.equal(details.dataGrowth.bySource[0]?.sourceId, 'pi')
    assert.ok((details.dataGrowth.bySource[0]?.last30Days.records ?? 0) >= 3)
    assert.ok((details.dataGrowth.bySource[0]?.last30Days.approxBytes ?? 0) > 0)
    assert.equal(details.dataGrowth.byAgent[0]?.productId, 'pi')
    assert.equal(details.dataGrowth.byAgent[0]?.productName, 'Pi')
    assert.ok((details.dataGrowth.byAgent[0]?.last30Days.approxBytes ?? 0) > 0)
    assert.ok(details.dataGrowth.metrics.canonicalGrowthRate.last7Days.observationsPerDay > 0)
    assert.ok((details.dataGrowth.metrics.storageAmplificationRate.last7Days ?? 0) > 0)
    assert.ok((details.dataGrowth.metrics.storageAmplificationRate.last30Days ?? 0) > 0)
    assert.ok(details.storageBreakdown.categories.sourceRaw.payloadBytes > 0)
    assert.ok(details.storageBreakdown.categories.canonical.payloadBytes > 0)
    assert.ok(details.storageBreakdown.categories.evidence.payloadBytes > 0)
  } finally {
    await storage.close()
  }
})
