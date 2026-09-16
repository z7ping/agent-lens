export const STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE = 'storage-diagnostics'
export const STORAGE_DIAGNOSTIC_SNAPSHOT_KEY = 'rolling-snapshots-v1'
export const STORAGE_DIAGNOSTIC_SNAPSHOT_RETENTION_DAYS = 35

export interface StorageDiagnosticSnapshot {
  version: 1
  day: string
  capturedAt: string
  hotFootprintBytes: number
  databaseBytes: number
  walBytes: number
  counts: {
    sourceRecords: number
    observations: number
    evidence: number
    sessions: number
  }
  categoryAllocatedBytes: {
    canonical: number
    evidence: number
    sourceRaw: number
    projection: number
    replication: number
    operational: number
  }
  replicationChanges: number
}

export interface StorageDiagnosticSnapshotSeries {
  version: 1
  snapshots: StorageDiagnosticSnapshot[]
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value)
  return number !== null && number >= 0 ? number : null
}

function snapshotFromUnknown(value: unknown): StorageDiagnosticSnapshot | null {
  const row = record(value)
  if (!row || row.version !== 1) return null
  if (typeof row.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)) return null
  if (typeof row.capturedAt !== 'string' || !Number.isFinite(Date.parse(row.capturedAt))) return null

  const counts = record(row.counts)
  const categories = record(row.categoryAllocatedBytes)
  if (!counts || !categories) return null

  const hotFootprintBytes = nonNegativeNumber(row.hotFootprintBytes)
  const databaseBytes = nonNegativeNumber(row.databaseBytes)
  const walBytes = nonNegativeNumber(row.walBytes)
  const sourceRecords = nonNegativeNumber(counts.sourceRecords)
  const observations = nonNegativeNumber(counts.observations)
  const evidence = nonNegativeNumber(counts.evidence)
  const sessions = nonNegativeNumber(counts.sessions)
  const canonical = nonNegativeNumber(categories.canonical)
  const evidenceBytes = nonNegativeNumber(categories.evidence)
  const sourceRaw = nonNegativeNumber(categories.sourceRaw)
  const projection = nonNegativeNumber(categories.projection)
  const replication = nonNegativeNumber(categories.replication)
  const operational = nonNegativeNumber(categories.operational)
  const replicationChanges = nonNegativeNumber(row.replicationChanges)

  if ([
    hotFootprintBytes,
    databaseBytes,
    walBytes,
    sourceRecords,
    observations,
    evidence,
    sessions,
    canonical,
    evidenceBytes,
    sourceRaw,
    projection,
    replication,
    operational,
    replicationChanges,
  ].some(item => item === null)) return null

  return {
    version: 1,
    day: row.day,
    capturedAt: row.capturedAt,
    hotFootprintBytes: hotFootprintBytes!,
    databaseBytes: databaseBytes!,
    walBytes: walBytes!,
    counts: {
      sourceRecords: sourceRecords!,
      observations: observations!,
      evidence: evidence!,
      sessions: sessions!,
    },
    categoryAllocatedBytes: {
      canonical: canonical!,
      evidence: evidenceBytes!,
      sourceRaw: sourceRaw!,
      projection: projection!,
      replication: replication!,
      operational: operational!,
    },
    replicationChanges: replicationChanges!,
  }
}

export function parseStorageDiagnosticSnapshot(
  value: unknown,
): StorageDiagnosticSnapshot | null {
  return snapshotFromUnknown(value)
}

export function parseStorageDiagnosticSnapshotSeries(
  value: unknown,
): StorageDiagnosticSnapshotSeries {
  const row = record(value)
  if (!row || row.version !== 1 || !Array.isArray(row.snapshots)) {
    return { version: 1, snapshots: [] }
  }
  const byDay = new Map<string, StorageDiagnosticSnapshot>()
  for (const item of row.snapshots) {
    const snapshot = snapshotFromUnknown(item)
    if (!snapshot) continue
    const existing = byDay.get(snapshot.day)
    if (!existing || Date.parse(snapshot.capturedAt) >= Date.parse(existing.capturedAt)) {
      byDay.set(snapshot.day, snapshot)
    }
  }
  return {
    version: 1,
    snapshots: [...byDay.values()].sort(
      (left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt),
    ),
  }
}

export function mergeStorageDiagnosticSnapshots(
  value: unknown,
  current: StorageDiagnosticSnapshot,
  retentionDays = STORAGE_DIAGNOSTIC_SNAPSHOT_RETENTION_DAYS,
): StorageDiagnosticSnapshotSeries {
  const parsed = parseStorageDiagnosticSnapshotSeries(value)
  const cutoff = Date.parse(current.capturedAt) - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000
  const byDay = new Map<string, StorageDiagnosticSnapshot>()
  for (const snapshot of parsed.snapshots) {
    if (Date.parse(snapshot.capturedAt) < cutoff) continue
    byDay.set(snapshot.day, snapshot)
  }
  byDay.set(current.day, current)
  return {
    version: 1,
    snapshots: [...byDay.values()]
      .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt))
      .slice(-Math.max(1, retentionDays)),
  }
}

function closestBaseline(
  snapshots: readonly StorageDiagnosticSnapshot[],
  current: StorageDiagnosticSnapshot,
  targetDays: number,
): StorageDiagnosticSnapshot | null {
  const currentAt = Date.parse(current.capturedAt)
  const targetAt = currentAt - targetDays * 24 * 60 * 60 * 1000
  let candidate: StorageDiagnosticSnapshot | null = null
  for (const snapshot of snapshots) {
    const at = Date.parse(snapshot.capturedAt)
    if (at >= currentAt || at > targetAt) continue
    if (!candidate || at > Date.parse(candidate.capturedAt)) candidate = snapshot
  }
  return candidate
}

function deltaWindow(
  current: StorageDiagnosticSnapshot,
  baseline: StorageDiagnosticSnapshot | null,
) {
  if (!baseline) {
    return {
      state: 'insufficient-history' as const,
      baselineCapturedAt: null,
      intervalDays: null,
    }
  }
  const intervalDays = (Date.parse(current.capturedAt) - Date.parse(baseline.capturedAt))
    / (24 * 60 * 60 * 1000)
  if (!(intervalDays > 0)) {
    return {
      state: 'insufficient-history' as const,
      baselineCapturedAt: baseline.capturedAt,
      intervalDays: null,
    }
  }

  const canonicalAllocatedBytesDelta = current.categoryAllocatedBytes.canonical
    - baseline.categoryAllocatedBytes.canonical
  const observationDelta = current.counts.observations - baseline.counts.observations
  const hotFootprintBytesDelta = current.hotFootprintBytes - baseline.hotFootprintBytes
  const replicationAllocatedBytesDelta = current.categoryAllocatedBytes.replication
    - baseline.categoryAllocatedBytes.replication
  const replicationChangesDelta = current.replicationChanges - baseline.replicationChanges

  return {
    state: 'ready' as const,
    baselineCapturedAt: baseline.capturedAt,
    intervalDays,
    canonical: {
      observationsDelta: observationDelta,
      allocatedBytesDelta: canonicalAllocatedBytesDelta,
      observationsPerDay: observationDelta / intervalDays,
      allocatedBytesPerDay: canonicalAllocatedBytesDelta / intervalDays,
    },
    hotSqlite: {
      footprintBytesDelta: hotFootprintBytesDelta,
      footprintBytesPerDay: hotFootprintBytesDelta / intervalDays,
    },
    replication: {
      allocatedBytesDelta: replicationAllocatedBytesDelta,
      allocatedBytesPerDay: replicationAllocatedBytesDelta / intervalDays,
      changesDelta: replicationChangesDelta,
      changesPerDay: replicationChangesDelta / intervalDays,
    },
  }
}

export function storageGrowthMetricsFromSnapshots(
  current: StorageDiagnosticSnapshot | null,
  history: unknown,
) {
  const parsed = parseStorageDiagnosticSnapshotSeries(history)
  if (!current) {
    const unavailable = {
      state: 'unavailable' as const,
      reason: 'current-physical-storage-breakdown-unavailable',
    }
    return {
      basis: 'persisted-daily-storage-snapshot-delta',
      history: {
        count: parsed.snapshots.length,
        oldestCapturedAt: parsed.snapshots[0]?.capturedAt ?? null,
        newestCapturedAt: parsed.snapshots.at(-1)?.capturedAt ?? null,
      },
      canonicalGrowthRate: unavailable,
      hotSqliteGrowthRate: unavailable,
      replicationGrowthRate: unavailable,
      storageAmplificationRate: {
        state: 'definition-required' as const,
        reason: 'Snapshot deltas provide storage growth, but original Agent activity still needs a stable uncompressed denominator before amplification can be defined.',
      },
    }
  }

  const last7Days = deltaWindow(current, closestBaseline(parsed.snapshots, current, 7))
  const last30Days = deltaWindow(current, closestBaseline(parsed.snapshots, current, 30))
  const hasCanonicalWindow = last7Days.state === 'ready' || last30Days.state === 'ready'

  return {
    basis: 'persisted-daily-storage-snapshot-delta',
    history: {
      count: parsed.snapshots.length,
      oldestCapturedAt: parsed.snapshots[0]?.capturedAt ?? null,
      newestCapturedAt: parsed.snapshots.at(-1)?.capturedAt ?? null,
    },
    canonicalGrowthRate: {
      state: hasCanonicalWindow ? 'ready' : 'insufficient-history',
      last7Days,
      last30Days,
    },
    hotSqliteGrowthRate: {
      state: hasCanonicalWindow ? 'ready' : 'insufficient-history',
      last7Days,
      last30Days,
    },
    replicationGrowthRate: {
      state: hasCanonicalWindow ? 'ready' : 'insufficient-history',
      last7Days,
      last30Days,
    },
    storageAmplificationRate: {
      state: 'definition-required',
      reason: 'Snapshot deltas provide storage growth, but original Agent activity still needs a stable uncompressed denominator before amplification can be defined.',
    },
  }
}
