import type { StorageHealth, StorageService } from '@agent-lens/core'
import {
  mergeStorageDiagnosticSnapshots,
  parseStorageDiagnosticSnapshot,
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

export async function captureStorageDiagnosticSnapshot(
  storage: Pick<StorageService, 'diagnostics' | 'checkpoints'>,
): Promise<StorageDiagnosticSnapshotSeries | null> {
  if (!storage.diagnostics) return null

  const diagnostics = await storage.diagnostics()
  const current = currentSnapshot(diagnostics)
  if (!current) {
    throw new Error('Storage diagnostics did not return a valid current snapshot')
  }

  const existing = await storage.checkpoints.get<unknown>(
    STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
    STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
  )
  const merged = mergeStorageDiagnosticSnapshots(existing, current)
  await storage.checkpoints.set(
    STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
    STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
    merged,
  )
  return merged
}
