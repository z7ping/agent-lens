import type { StorageHealth, StorageService } from '@agent-lens/core'
import {
  mergeStorageDiagnosticSnapshots,
  parseStorageDiagnosticSnapshot,
  parseStorageDiagnosticSnapshotSeries,
  STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
  STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
  type StorageDiagnosticSnapshotSeries,
} from '@agent-lens/storage-sqlite'

export const STORAGE_DIAGNOSTIC_SNAPSHOT_INITIAL_DELAY_MS = 60_000
export const STORAGE_DIAGNOSTIC_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function currentSnapshot(health: StorageHealth) {
  const details = record(health.details)
  const snapshotState = record(details?.storageSnapshot)
  return parseStorageDiagnosticSnapshot(snapshotState?.current)
}

export interface StorageDiagnosticSnapshotCaptureResult {
  captured: boolean
  series: StorageDiagnosticSnapshotSeries
}

export async function captureStorageDiagnosticSnapshot(
  storage: Pick<StorageService, 'diagnostics' | 'checkpoints'>,
  options: {
    now?: string
    minimumIntervalMs?: number
  } = {},
): Promise<StorageDiagnosticSnapshotCaptureResult | null> {
  if (!storage.diagnostics) return null

  const existingRaw = await storage.checkpoints.get<unknown>(
    STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
    STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
  )
  const existing = parseStorageDiagnosticSnapshotSeries(existingRaw)
  const nowMs = options.now === undefined ? Date.now() : Date.parse(options.now)
  if (!Number.isFinite(nowMs)) throw new Error('Storage snapshot now must be a valid timestamp')
  const minimumIntervalMs = Math.max(
    0,
    options.minimumIntervalMs ?? STORAGE_DIAGNOSTIC_SNAPSHOT_INTERVAL_MS,
  )
  const latest = existing.snapshots.at(-1)
  if (latest && nowMs - Date.parse(latest.capturedAt) < minimumIntervalMs) {
    return { captured: false, series: existing }
  }

  const diagnostics = await storage.diagnostics()
  const current = currentSnapshot(diagnostics)
  if (!current) {
    throw new Error('Storage diagnostics did not return a valid current snapshot')
  }

  const merged = mergeStorageDiagnosticSnapshots(existing, current)
  await storage.checkpoints.set(
    STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
    STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
    merged,
  )
  return { captured: true, series: merged }
}
