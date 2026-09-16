import assert from 'node:assert/strict'
import test from 'node:test'
import type { StorageService } from '@agent-lens/core'
import {
  STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
  STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
  type StorageDiagnosticSnapshot,
  type StorageDiagnosticSnapshotSeries,
} from '@agent-lens/storage-sqlite'
import { captureStorageDiagnosticSnapshot } from './storage-diagnostic-snapshots'

function snapshot(
  day: string,
  capturedAt = `${day}T12:00:00.000Z`,
): StorageDiagnosticSnapshot {
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
      epochCapturedAt: '2026-09-01T00:00:00.000Z',
      originalPayloadBytesCumulative: 100,
      recordsCumulative: 10,
    },
  }
}

test('captureStorageDiagnosticSnapshot 复用 checkpoint 并按日覆盖', async () => {
  let persisted: StorageDiagnosticSnapshotSeries | null = {
    version: 2,
    snapshots: [snapshot('2026-09-15')],
  }
  const current = snapshot('2026-09-16')
  const storage = {
    checkpoints: {
      async get(scope: string, key: string) {
        assert.equal(scope, STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE)
        assert.equal(key, STORAGE_DIAGNOSTIC_SNAPSHOT_KEY)
        return persisted
      },
      async set(scope: string, key: string, value: StorageDiagnosticSnapshotSeries) {
        assert.equal(scope, STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE)
        assert.equal(key, STORAGE_DIAGNOSTIC_SNAPSHOT_KEY)
        persisted = value
      },
    },
    async diagnostics() {
      return {
        ok: true,
        details: {
          storageSnapshot: { current },
        },
      }
    },
  } as unknown as Pick<StorageService, 'diagnostics' | 'checkpoints'>

  const result = await captureStorageDiagnosticSnapshot(storage, {
    now: '2026-09-16T13:00:00.000Z',
  })
  assert.equal(result?.captured, true)
  assert.equal(result?.nextDueInMs, 24 * 60 * 60 * 1000)
  assert.equal(result?.series.snapshots.length, 2)
  assert.equal(result?.series.snapshots.at(-1)?.day, '2026-09-16')
  assert.deepEqual(persisted, result?.series)
})

test('captureStorageDiagnosticSnapshot 没有 diagnostics 能力时跳过', async () => {
  const storage = {
    checkpoints: {},
  } as unknown as Pick<StorageService, 'diagnostics' | 'checkpoints'>

  assert.equal(await captureStorageDiagnosticSnapshot(storage), null)
})


test('captureStorageDiagnosticSnapshot 24 小时内直接复用最近快照，不调用 diagnostics', async () => {
  const existing = {
    version: 2,
    snapshots: [snapshot('2026-09-16', '2026-09-16T05:00:00.000Z')],
  } satisfies StorageDiagnosticSnapshotSeries
  let diagnosticsCalls = 0
  let writes = 0
  const storage = {
    checkpoints: {
      async get() {
        return existing
      },
      async set() {
        writes += 1
      },
    },
    async diagnostics() {
      diagnosticsCalls += 1
      return {
        ok: true,
        details: {
          storageSnapshot: { current: snapshot('2026-09-16', '2026-09-16T06:00:00.000Z') },
        },
      }
    },
  } as unknown as Pick<StorageService, 'diagnostics' | 'checkpoints'>

  const result = await captureStorageDiagnosticSnapshot(storage, {
    now: '2026-09-16T06:30:00.000Z',
  })

  assert.equal(result?.captured, false)
  assert.equal(result?.nextDueInMs, 22.5 * 60 * 60 * 1000)
  assert.deepEqual(result?.series, existing)
  assert.equal(diagnosticsCalls, 0)
  assert.equal(writes, 0)
})
