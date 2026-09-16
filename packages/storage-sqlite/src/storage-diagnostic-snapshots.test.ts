import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeStorageDiagnosticSnapshots,
  parseStorageDiagnosticSnapshotSeries,
  storageGrowthMetricsFromSnapshots,
  type StorageDiagnosticSnapshot,
} from './storage-diagnostic-snapshots'

const ACTIVITY_EPOCH = '2026-08-01T00:00:00.000Z'

function snapshot(
  day: string,
  input: Partial<StorageDiagnosticSnapshot> = {},
): StorageDiagnosticSnapshot {
  const capturedAt = `${day}T12:00:00.000Z`
  return {
    version: 2,
    day,
    capturedAt,
    hotFootprintBytes: 100,
    databaseBytes: 90,
    persistentRetainedBytes: 90,
    persistentRetainedScope: 'sqlite-main',
    walBytes: 10,
    counts: {
      sourceRecords: 10,
      observations: 10,
      evidence: 10,
      sessions: 1,
    },
    categoryAllocatedBytes: {
      canonical: 40,
      evidence: 10,
      sourceRaw: 20,
      projection: 10,
      replication: 10,
      operational: 10,
    },
    replicationChanges: 10,
    sourceActivity: {
      epochCapturedAt: ACTIVITY_EPOCH,
      originalPayloadBytesCumulative: 100,
      recordsCumulative: 10,
    },
    ...input,
  }
}

test('rolling snapshot 同一天覆盖且忽略损坏历史', () => {
  const first = snapshot('2026-09-16')
  const later = snapshot('2026-09-16', {
    capturedAt: '2026-09-16T18:00:00.000Z',
    hotFootprintBytes: 150,
  })
  const merged = mergeStorageDiagnosticSnapshots({
    version: 2,
    snapshots: [
      { invalid: true },
      first,
    ],
  }, later)

  assert.equal(merged.snapshots.length, 1)
  assert.equal(merged.snapshots[0]?.capturedAt, later.capturedAt)
  assert.equal(merged.snapshots[0]?.hotFootprintBytes, 150)
})

test('rolling snapshot 最多保留指定天数', () => {
  let state: unknown = null
  for (let day = 1; day <= 10; day += 1) {
    state = mergeStorageDiagnosticSnapshots(
      state,
      snapshot(`2026-09-${String(day).padStart(2, '0')}`),
      5,
    )
  }
  const parsed = parseStorageDiagnosticSnapshotSeries(state)
  assert.deepEqual(
    parsed.snapshots.map(item => item.day),
    ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'],
  )
})

test('snapshot delta 计算 Canonical / hot SQLite / Replication 与存储放大率', () => {
  const baseline7 = snapshot('2026-09-09', {
    hotFootprintBytes: 1_000,
    databaseBytes: 900,
    persistentRetainedBytes: 900,
    counts: {
      sourceRecords: 100,
      observations: 80,
      evidence: 90,
      sessions: 10,
    },
    categoryAllocatedBytes: {
      canonical: 400,
      evidence: 100,
      sourceRaw: 200,
      projection: 100,
      replication: 100,
      operational: 100,
    },
    replicationChanges: 1_000,
    sourceActivity: {
      epochCapturedAt: ACTIVITY_EPOCH,
      originalPayloadBytesCumulative: 1_000,
      recordsCumulative: 100,
    },
  })
  const baseline30 = snapshot('2026-08-17', {
    hotFootprintBytes: 500,
    databaseBytes: 400,
    persistentRetainedBytes: 400,
    counts: {
      sourceRecords: 40,
      observations: 20,
      evidence: 30,
      sessions: 5,
    },
    categoryAllocatedBytes: {
      canonical: 100,
      evidence: 50,
      sourceRaw: 100,
      projection: 50,
      replication: 100,
      operational: 100,
    },
    replicationChanges: 100,
    sourceActivity: {
      epochCapturedAt: ACTIVITY_EPOCH,
      originalPayloadBytesCumulative: 0,
      recordsCumulative: 0,
    },
  })
  const current = snapshot('2026-09-16', {
    hotFootprintBytes: 1_700,
    databaseBytes: 1_600,
    persistentRetainedBytes: 1_600,
    counts: {
      sourceRecords: 150,
      observations: 150,
      evidence: 160,
      sessions: 20,
    },
    categoryAllocatedBytes: {
      canonical: 750,
      evidence: 150,
      sourceRaw: 300,
      projection: 150,
      replication: 250,
      operational: 100,
    },
    replicationChanges: 1_700,
    sourceActivity: {
      epochCapturedAt: ACTIVITY_EPOCH,
      originalPayloadBytesCumulative: 3_000,
      recordsCumulative: 150,
    },
  })

  const metrics = storageGrowthMetricsFromSnapshots(current, {
    version: 2,
    snapshots: [baseline30, baseline7],
  })

  assert.equal(metrics.canonicalGrowthRate.state, 'ready')
  if (!('last7Days' in metrics.canonicalGrowthRate)) {
    assert.fail('Canonical growth windows should be available')
  }
  const last7Days = metrics.canonicalGrowthRate.last7Days
  const last30Days = metrics.canonicalGrowthRate.last30Days
  assert.equal(last7Days.state, 'ready')
  assert.equal(last30Days.state, 'ready')
  if (last7Days.state !== 'ready' || last30Days.state !== 'ready') {
    assert.fail('Expected ready 7/30 day snapshot deltas')
  }
  assert.equal(last7Days.canonical.observationsDelta, 70)
  assert.equal(last7Days.canonical.allocatedBytesDelta, 350)
  assert.equal(last7Days.canonical.observationsPerDay, 10)
  assert.equal(last7Days.hotSqlite.footprintBytesDelta, 700)
  assert.equal(last7Days.replication.changesDelta, 700)
  assert.equal(last30Days.canonical.observationsDelta, 130)

  assert.equal(metrics.storageAmplificationRate.state, 'ready')
  assert.equal(metrics.storageAmplificationRate.last7Days.state, 'ready')
  assert.equal(metrics.storageAmplificationRate.last30Days.state, 'ready')
  if (
    metrics.storageAmplificationRate.last7Days.state !== 'ready'
    || metrics.storageAmplificationRate.last30Days.state !== 'ready'
  ) {
    assert.fail('Expected ready storage amplification windows')
  }
  assert.equal(
    metrics.storageAmplificationRate.last7Days.originalActivityBytesDelta,
    2_000,
  )
  assert.equal(
    metrics.storageAmplificationRate.last7Days.persistentRetainedBytesDelta,
    700,
  )
  assert.equal(
    metrics.storageAmplificationRate.last7Days.persistentBytesPerOriginalActivityByte,
    0.35,
  )
  assert.equal(
    metrics.storageAmplificationRate.last30Days.persistentBytesPerOriginalActivityByte,
    0.4,
  )
})

test('没有足够历史时不伪造增长率或放大率', () => {
  const current = snapshot('2026-09-16')
  const metrics = storageGrowthMetricsFromSnapshots(current, null)

  assert.equal(metrics.canonicalGrowthRate.state, 'insufficient-history')
  if (!('last7Days' in metrics.canonicalGrowthRate)) {
    assert.fail('Insufficient-history metrics should still expose requested windows')
  }
  assert.equal(metrics.canonicalGrowthRate.last7Days.state, 'insufficient-history')
  assert.equal(metrics.canonicalGrowthRate.last30Days.state, 'insufficient-history')
  assert.equal(metrics.storageAmplificationRate.state, 'insufficient-history')
  assert.equal(metrics.storageAmplificationRate.last7Days.state, 'insufficient-history')
})

test('原始活动统计纪元变化时不跨断点计算放大率', () => {
  const baseline = snapshot('2026-09-09', {
    sourceActivity: {
      epochCapturedAt: ACTIVITY_EPOCH,
      originalPayloadBytesCumulative: 1_000,
      recordsCumulative: 100,
    },
  })
  const current = snapshot('2026-09-16', {
    sourceActivity: {
      epochCapturedAt: '2026-09-12T00:00:00.000Z',
      originalPayloadBytesCumulative: 500,
      recordsCumulative: 20,
    },
  })

  const metrics = storageGrowthMetricsFromSnapshots(current, {
    version: 2,
    snapshots: [baseline],
  })

  assert.equal(metrics.storageAmplificationRate.state, 'insufficient-history')
  assert.equal(
    metrics.storageAmplificationRate.last7Days.state,
    'insufficient-activity-history',
  )
})
