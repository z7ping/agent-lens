import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteStorageService } from './storage'
import { largePayloadProfile, sourceActivityPayloadBytesBetween } from './storage-diagnostics'
import {
  STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
  STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
  type StorageDiagnosticSnapshot,
} from './storage-diagnostic-snapshots'

test('health 保持轻量，diagnostics 区分物理占用、采集活动与真实增长', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  await storage.maintenance.ensureDeferredIndexes()
  try {
    const health = await storage.health()
    const healthDetails = health.details as {
      unknownObservations?: unknown
      coverage?: unknown
      storageBreakdown?: unknown
      capturedActivity?: unknown
      dataGrowth: {
        totals?: unknown
        last7Days?: unknown
        freelistBytes: number
        sqliteTempAllocatedBytes: number
        capacity: {
          scope: string
          longTermTotalLimitBytes: number | null
        }
      }
    }
    assert.equal(healthDetails.unknownObservations, undefined)
    assert.equal(healthDetails.coverage, undefined)
    assert.equal(healthDetails.storageBreakdown, undefined)
    assert.equal(healthDetails.capturedActivity, undefined)
    assert.equal(healthDetails.dataGrowth.totals, undefined)
    assert.equal(healthDetails.dataGrowth.last7Days, undefined)
    assert.equal(healthDetails.dataGrowth.capacity.scope, 'hot-sqlite')
    assert.equal(healthDetails.dataGrowth.capacity.longTermTotalLimitBytes, null)
    assert.equal(typeof healthDetails.dataGrowth.freelistBytes, 'number')
    assert.equal(typeof healthDetails.dataGrowth.sqliteTempAllocatedBytes, 'number')

    const diagnostics = await storage.diagnostics()
    const details = diagnostics.details as {
      unknownObservations: { total: number, groups: unknown[] }
      coverage: { summary: unknown }
      storageBreakdown: {
        available: boolean
        basis: string
        excludesFreelist: boolean
        categories: {
          canonical: {
            usefulPayloadBytes: number
            unusedBytes: number
            allocatedBytes: number
            tableAllocatedBytes: number
            indexAllocatedBytes: number
          }
          projection: { allocatedBytes: number }
          replication: { allocatedBytes: number }
        }
        objects: unknown[]
      }
      spaceRecovery: {
        freelist: {
          bytes: number
          reusableInsideDatabase: boolean
          shrinksDatabaseFileWithoutCompaction: boolean
        }
        wal: { bytes: number, releaseDependsOnCheckpoint: boolean }
        projection: { allocatedBytes: number, rebuildable: boolean }
        sourceRaw: { state: string }
        estimatedBytes?: number
      }
      capturedActivity: {
        basis: string
        timeIndexes: {
          sourceRecords: boolean
          observations: boolean
          evidence: boolean
          sessions: boolean
        }
        bySource: unknown[]
        byAgent: unknown[]
        trend: { last7Days: unknown[], last30Days: unknown[] }
        canonical: { available: boolean }
      }
      replicationJournal: {
        available: boolean
        totalChanges: number
        byEntityType: unknown[]
      }
      storageSnapshot: {
        retentionDays: number
        current: {
          day: string
          capturedAt: string
          version: number
          sourceActivity: {
            originalPayloadBytesCumulative: number
            recordsCumulative: number
          }
        }
        history: { count: number }
        sourceActivityInterval: { state: string, records: number, originalPayloadBytes: number }
      }
      growthMetrics: {
        canonicalGrowthRate: { state: string }
        storageAmplificationRate: { state: string }
      }
      dataGrowth: {
        totals: { sourceRecords: number }
        last7Days: { sessions: number | null }
        last30Days: { sessions: number | null }
      }
    }

    assert.equal(details.unknownObservations.total, 0)
    assert.deepEqual(details.unknownObservations.groups, [])
    assert.ok(details.coverage.summary)
    assert.equal(details.storageBreakdown.available, true)
    assert.equal(details.storageBreakdown.basis, 'sqlite-dbstat-btree-aggregate')
    assert.equal(details.storageBreakdown.excludesFreelist, true)
    assert.equal(typeof details.storageBreakdown.categories.canonical.usefulPayloadBytes, 'number')
    assert.equal(typeof details.storageBreakdown.categories.canonical.indexAllocatedBytes, 'number')
    assert.equal(typeof details.storageBreakdown.categories.projection.allocatedBytes, 'number')
    assert.ok(Array.isArray(details.storageBreakdown.objects))

    assert.equal(typeof details.spaceRecovery.freelist.bytes, 'number')
    assert.equal(details.spaceRecovery.freelist.reusableInsideDatabase, true)
    assert.equal(details.spaceRecovery.freelist.shrinksDatabaseFileWithoutCompaction, false)
    assert.equal(details.spaceRecovery.wal.releaseDependsOnCheckpoint, true)
    assert.equal(details.spaceRecovery.projection.rebuildable, true)
    assert.equal(details.spaceRecovery.sourceRaw.state, 'not-assessed')
    assert.equal(details.spaceRecovery.estimatedBytes, undefined)

    assert.equal(details.capturedActivity.basis, 'captured-activity-not-net-storage-growth')
    assert.equal(details.capturedActivity.timeIndexes.sourceRecords, true)
    assert.equal(details.capturedActivity.timeIndexes.observations, true)
    assert.equal(details.capturedActivity.timeIndexes.evidence, true)
    assert.equal(details.capturedActivity.timeIndexes.sessions, true)
    assert.equal(details.capturedActivity.canonical.available, true)
    assert.equal(details.capturedActivity.trend.last7Days.length, 7)
    assert.equal(details.capturedActivity.trend.last30Days.length, 30)
    assert.deepEqual(details.capturedActivity.bySource, [])
    assert.deepEqual(details.capturedActivity.byAgent, [])

    assert.equal(details.replicationJournal.available, true)
    assert.equal(details.replicationJournal.totalChanges, 0)
    assert.deepEqual(details.replicationJournal.byEntityType, [])
    assert.equal(details.storageSnapshot.retentionDays, 35)
    assert.equal(details.storageSnapshot.current.version, 2)
    assert.equal(details.storageSnapshot.current.day.length, 10)
    assert.equal(typeof details.storageSnapshot.current.capturedAt, 'string')
    assert.equal(details.storageSnapshot.current.sourceActivity.originalPayloadBytesCumulative, 0)
    assert.equal(details.storageSnapshot.current.sourceActivity.recordsCumulative, 0)
    assert.equal(details.storageSnapshot.sourceActivityInterval.state, 'baseline')
    assert.equal(details.storageSnapshot.history.count, 0)
    assert.equal(details.growthMetrics.canonicalGrowthRate.state, 'insufficient-history')
    assert.equal(details.growthMetrics.storageAmplificationRate.state, 'insufficient-history')

    assert.equal(typeof details.dataGrowth.totals.sourceRecords, 'number')
    assert.equal(typeof details.dataGrowth.last7Days.sessions, 'number')
    assert.equal(typeof details.dataGrowth.last30Days.sessions, 'number')
  } finally {
    await storage.close()
  }
})

test('diagnostics 按 Source / Agent 展示近 7/30 天 Raw 活动，并暴露 Replication 写放大', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  await storage.maintenance.ensureDeferredIndexes()
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
    await storage.repositories.sourceRecords.put({
      id: 'source-record:1',
      sourceId: 'pi',
      installationId: 'pi:local',
      sourceSessionNativeId: 'native:1',
      nativeType: 'message',
      nativeId: 'native-message:1',
      capturedAt: now,
      locator: { kind: 'file', path: 'session.jsonl' },
      payload: { role: 'assistant', content: 'raw payload' },
      parserVersion: 'test',
    })
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
          canonical: { allocatedBytes: number }
          evidence: { allocatedBytes: number }
          sourceRaw: { allocatedBytes: number }
          replication: { allocatedBytes: number }
        }
      }
      capturedActivity: {
        sourceRaw: {
          last7Days: { records: number, storedPayloadBytesApprox: number }
          last30Days: { records: number, storedPayloadBytesApprox: number }
        }
        canonical: {
          available: boolean
          last7Days: { records: number, logicalPayloadBytesApprox: number } | null
        }
        evidence: {
          available: boolean
          last7Days: { records: number, logicalPayloadBytesApprox: number } | null
        }
        bySource: Array<{
          sourceId: string
          last30Days: { records: number, storedPayloadBytesApprox: number }
        }>
        byAgent: Array<{
          productId: string
          productName: string | null
          last30Days: { records: number, storedPayloadBytesApprox: number }
        }>
        rates: {
          canonicalCaptured: {
            available: boolean
            last7Days?: { observationsPerDay: number }
          }
        }
      }
      replicationJournal: {
        available: boolean
        totalChanges: number
        distinctEntities: number
        extraChangesBeyondFirst: number
        changesPerDistinctEntity: number | null
        extraChangesPerDistinctEntity: number | null
        byEntityType: Array<{
          entityType: string
          changes: number
          distinctEntities: number
          extraChangesBeyondFirst: number
          changesPerDistinctEntity: number | null
          extraChangesPerDistinctEntity: number | null
        }>
      }
      growthMetrics: {
        canonicalGrowthRate: { state: string }
        storageAmplificationRate: { state: string }
      }
    }

    assert.equal(details.capturedActivity.bySource[0]?.sourceId, 'pi')
    assert.equal(details.capturedActivity.bySource[0]?.last30Days.records, 1)
    assert.ok((details.capturedActivity.bySource[0]?.last30Days.storedPayloadBytesApprox ?? 0) > 0)
    assert.equal(details.capturedActivity.byAgent[0]?.productId, 'pi')
    assert.equal(details.capturedActivity.byAgent[0]?.productName, 'Pi')
    assert.equal(details.capturedActivity.sourceRaw.last7Days.records, 1)
    assert.equal(details.capturedActivity.sourceRaw.last30Days.records, 1)
    assert.ok(details.capturedActivity.sourceRaw.last30Days.storedPayloadBytesApprox > 0)
    assert.equal(details.capturedActivity.canonical.available, true)
    assert.equal(details.capturedActivity.canonical.last7Days?.records, 1)
    assert.equal(details.capturedActivity.evidence.available, true)
    assert.equal(details.capturedActivity.evidence.last7Days?.records, 1)
    assert.equal(details.capturedActivity.rates.canonicalCaptured.available, true)
    assert.ok((details.capturedActivity.rates.canonicalCaptured.last7Days?.observationsPerDay ?? 0) > 0)

    assert.equal(details.replicationJournal.available, true)
    assert.ok(details.replicationJournal.totalChanges >= 7)
    assert.ok(details.replicationJournal.distinctEntities >= 7)
    assert.ok((details.replicationJournal.changesPerDistinctEntity ?? 0) >= 1)
    assert.ok(details.replicationJournal.extraChangesBeyondFirst >= 0)
    assert.ok((details.replicationJournal.extraChangesPerDistinctEntity ?? 0) >= 0)
    const sourceRecordJournal = details.replicationJournal.byEntityType.find(
      item => item.entityType === 'SourceRecord',
    )
    assert.ok(sourceRecordJournal)
    assert.ok((sourceRecordJournal?.extraChangesBeyondFirst ?? 0) >= 1)
    assert.ok((sourceRecordJournal?.extraChangesPerDistinctEntity ?? 0) >= 1)
    assert.ok(details.replicationJournal.byEntityType.some(item => item.entityType === 'SourceRecord'))
    assert.ok(details.replicationJournal.byEntityType.some(item => item.entityType === 'CanonicalObservation'))
    assert.ok(details.replicationJournal.byEntityType.some(item => item.entityType === 'Evidence'))

    assert.ok(details.storageBreakdown.categories.sourceRaw.allocatedBytes > 0)
    assert.ok(details.storageBreakdown.categories.canonical.allocatedBytes > 0)
    assert.ok(details.storageBreakdown.categories.evidence.allocatedBytes > 0)
    assert.ok(details.storageBreakdown.categories.replication.allocatedBytes > 0)
    assert.equal(details.growthMetrics.canonicalGrowthRate.state, 'insufficient-history')
    assert.equal(details.growthMetrics.storageAmplificationRate.state, 'insufficient-history')
  } finally {
    await storage.close()
  }
})


test('diagnostics 使用持久快照把 Canonical Growth Rate 从历史不足切换为可计算', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  await storage.maintenance.ensureDeferredIndexes()
  try {
    const first = await storage.diagnostics()
    const firstDetails = first.details as {
      storageSnapshot: { current: StorageDiagnosticSnapshot }
      growthMetrics: { canonicalGrowthRate: { state: string } }
    }
    assert.equal(firstDetails.growthMetrics.canonicalGrowthRate.state, 'insufficient-history')

    const current = firstDetails.storageSnapshot.current
    const baselineAt = new Date(Date.parse(current.capturedAt) - 8 * 24 * 60 * 60 * 1000)
    const baseline: StorageDiagnosticSnapshot = {
      ...current,
      day: baselineAt.toISOString().slice(0, 10),
      capturedAt: baselineAt.toISOString(),
    }
    await storage.checkpoints.set(
      STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
      STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
      { version: 2, snapshots: [baseline] },
    )

    const second = await storage.diagnostics()
    const secondDetails = second.details as {
      growthMetrics: {
        canonicalGrowthRate: {
          state: string
          last7Days: {
            state: string
            intervalDays: number | null
            canonical?: {
              observationsDelta: number
              allocatedBytesDelta: number
            }
          }
        }
      }
    }
    assert.equal(secondDetails.growthMetrics.canonicalGrowthRate.state, 'ready')
    assert.equal(secondDetails.growthMetrics.canonicalGrowthRate.last7Days.state, 'ready')
    assert.ok((secondDetails.growthMetrics.canonicalGrowthRate.last7Days.intervalDays ?? 0) >= 8)
    assert.equal(
      secondDetails.growthMetrics.canonicalGrowthRate.last7Days.canonical?.observationsDelta,
      0,
    )
  } finally {
    await storage.close()
  }
})


test('source activity 字节统计同时覆盖 plain JSON 与 gzip JSON，且不需要解压', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const capturedAt = '2026-09-16T12:00:00.000Z'
    storage.db.prepare(`
      INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
      VALUES ('host:activity', 'local', 'test', 'test', ?, ?)
    `).run(capturedAt, capturedAt)
    storage.db.prepare(`
      INSERT INTO agent_products(id, name)
      VALUES ('pi', 'Pi')
    `).run()
    storage.db.prepare(`
      INSERT INTO agent_installations(
        id, host_id, product_id, first_seen_at, last_seen_at
      ) VALUES ('pi:activity', 'host:activity', 'pi', ?, ?)
    `).run(capturedAt, capturedAt)

    const smallPayload = { text: 'small' }
    const largePayload = { text: 'x'.repeat(8_000) }
    await storage.repositories.sourceRecords.put({
      id: 'source-record:small',
      sourceId: 'pi',
      installationId: 'pi:activity',
      nativeType: 'message',
      nativeId: 'small',
      capturedAt,
      locator: { kind: 'file', path: 'small.jsonl' },
      payload: smallPayload,
      parserVersion: 'test',
    })
    await storage.repositories.sourceRecords.put({
      id: 'source-record:large',
      sourceId: 'pi',
      installationId: 'pi:activity',
      nativeType: 'message',
      nativeId: 'large',
      capturedAt,
      locator: { kind: 'file', path: 'large.jsonl' },
      payload: largePayload,
      parserVersion: 'test',
    })

    const encodings = storage.db.prepare(`
      SELECT id, payload_encoding AS payloadEncoding
      FROM source_records
      ORDER BY id
    `).all() as Array<{ id: string, payloadEncoding: string }>
    assert.deepEqual(
      encodings.map(item => [item.id, item.payloadEncoding]),
      [
        ['source-record:large', 'gzip-json'],
        ['source-record:small', 'plain-json'],
      ],
    )

    const measured = sourceActivityPayloadBytesBetween(
      storage.db,
      '2026-09-16T11:59:59.999Z',
      '2026-09-16T12:00:00.001Z',
    )
    assert.equal(measured.state, 'complete')
    assert.equal(measured.records, 2)
    assert.equal(measured.unknownEncodingRecords, 0)
    assert.equal(measured.invalidPayloadRecords, 0)
    assert.equal(
      measured.originalPayloadBytes,
      Buffer.byteLength(JSON.stringify(smallPayload), 'utf8')
        + Buffer.byteLength(JSON.stringify(largePayload), 'utf8'),
    )
  } finally {
    await storage.close()
  }
})


test('重复触碰既有 SourceRecord 时重置活动统计纪元，避免把重扫算成新活动', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  await storage.maintenance.ensureDeferredIndexes()
  try {
    const now = new Date()
    const capturedAt = now.toISOString()
    storage.db.prepare(`
      INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
      VALUES ('host:rescan', 'local', 'test', 'test', ?, ?)
    `).run(capturedAt, capturedAt)
    storage.db.prepare(`
      INSERT INTO agent_products(id, name)
      VALUES ('pi', 'Pi')
    `).run()
    storage.db.prepare(`
      INSERT INTO agent_installations(
        id, host_id, product_id, first_seen_at, last_seen_at
      ) VALUES ('pi:rescan', 'host:rescan', 'pi', ?, ?)
    `).run(capturedAt, capturedAt)
    await storage.repositories.sourceRecords.put({
      id: 'source-record:rescan',
      sourceId: 'pi',
      installationId: 'pi:rescan',
      nativeType: 'message',
      nativeId: 'rescan',
      capturedAt,
      locator: { kind: 'file', path: 'session.jsonl' },
      payload: { text: 'same native event' },
      parserVersion: 'test',
    })

    const first = await storage.diagnostics()
    const firstDetails = first.details as {
      storageSnapshot: { current: StorageDiagnosticSnapshot }
    }
    const baselineAt = new Date(Date.parse(capturedAt) - 8 * 24 * 60 * 60 * 1000)
    const baseline: StorageDiagnosticSnapshot = {
      ...firstDetails.storageSnapshot.current,
      day: baselineAt.toISOString().slice(0, 10),
      capturedAt: baselineAt.toISOString(),
      sourceActivity: {
        epochCapturedAt: baselineAt.toISOString(),
        originalPayloadBytesCumulative: 0,
        recordsCumulative: 0,
      },
    }
    await storage.checkpoints.set(
      STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
      STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
      { version: 2, snapshots: [baseline] },
    )

    // Re-capture the same SourceRecord identity with a newer capture timestamp.
    await storage.repositories.sourceRecords.put({
      id: 'source-record:rescan',
      sourceId: 'pi',
      installationId: 'pi:rescan',
      nativeType: 'message',
      nativeId: 'rescan',
      capturedAt: new Date().toISOString(),
      locator: { kind: 'file', path: 'session.jsonl' },
      payload: { text: 'same native event' },
      parserVersion: 'test',
    })

    const second = await storage.diagnostics()
    const details = second.details as {
      storageSnapshot: {
        current: StorageDiagnosticSnapshot
        sourceActivityInterval: {
          state: string
          records: number
          netNewSourceRecords: number
          reason?: string
        }
      }
      growthMetrics: {
        storageAmplificationRate: {
          state: string
          last7Days?: { state: string }
        }
      }
    }

    assert.equal(details.storageSnapshot.sourceActivityInterval.records, 1)
    assert.equal(details.storageSnapshot.sourceActivityInterval.netNewSourceRecords, 0)
    assert.equal(details.storageSnapshot.sourceActivityInterval.state, 'partial')
    assert.equal(
      details.storageSnapshot.sourceActivityInterval.reason,
      'recent-source-records-do-not-match-net-new-records',
    )
    assert.equal(
      details.storageSnapshot.current.sourceActivity.originalPayloadBytesCumulative,
      0,
    )
    assert.equal(details.growthMetrics.storageAmplificationRate.state, 'insufficient-history')
    assert.equal(
      details.growthMetrics.storageAmplificationRate.last7Days?.state,
      'insufficient-activity-history',
    )
  } finally {
    await storage.close()
  }
})


test('新增 SourceRecord 经滚动快照累计后可得到 Storage Amplification Rate', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  await storage.maintenance.ensureDeferredIndexes()
  try {
    const first = await storage.diagnostics()
    const firstDetails = first.details as {
      storageSnapshot: { current: StorageDiagnosticSnapshot }
    }
    const baselineAt = new Date(Date.parse(firstDetails.storageSnapshot.current.capturedAt) - 8 * 24 * 60 * 60 * 1000)
    const baseline: StorageDiagnosticSnapshot = {
      ...firstDetails.storageSnapshot.current,
      day: baselineAt.toISOString().slice(0, 10),
      capturedAt: baselineAt.toISOString(),
      sourceActivity: {
        epochCapturedAt: baselineAt.toISOString(),
        originalPayloadBytesCumulative: 0,
        recordsCumulative: 0,
      },
    }
    await storage.checkpoints.set(
      STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
      STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
      { version: 2, snapshots: [baseline] },
    )

    const capturedAt = new Date().toISOString()
    storage.db.prepare(`
      INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
      VALUES ('host:amplification', 'local', 'test', 'test', ?, ?)
    `).run(capturedAt, capturedAt)
    storage.db.prepare(`
      INSERT INTO agent_products(id, name)
      VALUES ('pi', 'Pi')
    `).run()
    storage.db.prepare(`
      INSERT INTO agent_installations(
        id, host_id, product_id, first_seen_at, last_seen_at
      ) VALUES ('pi:amplification', 'host:amplification', 'pi', ?, ?)
    `).run(capturedAt, capturedAt)

    const payload = { text: 'x'.repeat(2_000) }
    await storage.repositories.sourceRecords.put({
      id: 'source-record:amplification',
      sourceId: 'pi',
      installationId: 'pi:amplification',
      nativeType: 'message',
      nativeId: 'amplification',
      capturedAt,
      locator: { kind: 'file', path: 'session.jsonl' },
      payload,
      parserVersion: 'test',
    })

    const second = await storage.diagnostics()
    const details = second.details as {
      storageSnapshot: {
        current: StorageDiagnosticSnapshot
        sourceActivityInterval: {
          state: string
          records: number
          netNewSourceRecords: number
          originalPayloadBytes: number
        }
      }
      growthMetrics: {
        storageAmplificationRate: {
          state: string
          last7Days?: {
            state: string
            originalActivityBytesDelta?: number
            persistentBytesPerOriginalActivityByte?: number
          }
        }
      }
    }

    const expectedBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    assert.equal(details.storageSnapshot.sourceActivityInterval.state, 'complete')
    assert.equal(details.storageSnapshot.sourceActivityInterval.records, 1)
    assert.equal(details.storageSnapshot.sourceActivityInterval.netNewSourceRecords, 1)
    assert.equal(details.storageSnapshot.sourceActivityInterval.originalPayloadBytes, expectedBytes)
    assert.equal(
      details.storageSnapshot.current.sourceActivity.originalPayloadBytesCumulative,
      expectedBytes,
    )
    assert.equal(details.growthMetrics.storageAmplificationRate.state, 'ready')
    assert.equal(details.growthMetrics.storageAmplificationRate.last7Days?.state, 'ready')
    assert.equal(
      details.growthMetrics.storageAmplificationRate.last7Days?.originalActivityBytesDelta,
      expectedBytes,
    )
    assert.equal(
      typeof details.growthMetrics.storageAmplificationRate.last7Days?.persistentBytesPerOriginalActivityByte,
      'number',
    )
    assert.ok(Number.isFinite(
      details.growthMetrics.storageAmplificationRate.last7Days?.persistentBytesPerOriginalActivityByte,
    ))
  } finally {
    await storage.close()
  }
})


test('large Payload profile 区分 Raw / Canonical / Tool Result 的存储字节贡献', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const now = '2026-09-16T00:00:00.000Z'
    storage.db.prepare(`
      INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
      VALUES ('host:large-payload', 'local', 'test', 'test', ?, ?)
    `).run(now, now)
    storage.db.prepare(`
      INSERT INTO agent_products(id, name) VALUES ('pi', 'Pi')
    `).run()
    storage.db.prepare(`
      INSERT INTO agent_installations(id, host_id, product_id, first_seen_at, last_seen_at)
      VALUES ('pi:large-payload', 'host:large-payload', 'pi', ?, ?)
    `).run(now, now)
    storage.db.prepare(`
      INSERT INTO logical_sessions(id, installation_id, started_at)
      VALUES ('session:large-payload', 'pi:large-payload', ?)
    `).run(now)
    storage.db.prepare(`
      INSERT INTO source_sessions(
        id, source_id, installation_id, native_session_id, logical_session_id
      ) VALUES (
        'source-session:large-payload', 'pi', 'pi:large-payload',
        'native:large-payload', 'session:large-payload'
      )
    `).run()

    const largeJson = JSON.stringify({ text: 'x'.repeat(70 * 1024) })
    storage.db.prepare(`
      INSERT INTO source_records(
        id, source_id, installation_id, native_type, captured_at,
        locator_json, payload_json, parser_version, payload_encoding
      ) VALUES (
        'raw:large-payload', 'pi', 'pi:large-payload', 'message', ?,
        '{}', ?, 'test', 'plain-json'
      )
    `).run(now, largeJson)
    storage.db.prepare(`
      INSERT INTO observations(
        id, host_id, installation_id, logical_session_id, source_session_id,
        kind, captured_at, payload_json
      ) VALUES (
        'observation:tool-result-large', 'host:large-payload', 'pi:large-payload',
        'session:large-payload', 'source-session:large-payload',
        'tool.result', ?, ?
      )
    `).run(now, largeJson)
    storage.db.prepare(`
      INSERT INTO observations(
        id, host_id, installation_id, logical_session_id, source_session_id,
        kind, captured_at, payload_json
      ) VALUES (
        'observation:small', 'host:large-payload', 'pi:large-payload',
        'session:large-payload', 'source-session:large-payload',
        'message.assistant', ?, '{"text":"small"}'
      )
    `).run(now)

    const profile = largePayloadProfile(storage.db)
    const raw64 = profile.sourceRaw.thresholds.find(item => item.threshold === '64KiB')
    const canonical64 = profile.canonical.thresholds.find(item => item.threshold === '64KiB')
    const tool64 = profile.toolResults.thresholds.find(item => item.threshold === '64KiB')
    const raw256 = profile.sourceRaw.thresholds.find(item => item.threshold === '256KiB')

    assert.equal(profile.basis, 'stored-payload-bytes-not-total-row-or-index-allocation')
    assert.equal(raw64?.records, 1)
    assert.equal(canonical64?.records, 1)
    assert.equal(tool64?.records, 1)
    assert.equal(raw256?.records, 0)
    assert.ok((raw64?.shareOfPayloadBytes ?? 0) > 0.99)
    assert.ok((tool64?.shareOfPayloadBytes ?? 0) > 0.99)
  } finally {
    await storage.close()
  }
})
