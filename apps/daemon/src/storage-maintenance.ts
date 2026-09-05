import type { JsonValue } from '@agent-lens/core'

export interface SourceRecordCompressionBatch {
  scanned: number
  compressed: number
  plain: number
  rawBytes: number
  storedBytes: number
  savedBytes: number
  cursor?: string
  hasMore: boolean
}

export interface SourceRecordCompressionMaintenance {
  compressSourceRecords(limit?: number, afterId?: string): Promise<SourceRecordCompressionBatch>
}

export interface DeferredIndexMaintenanceResult {
  created: string[]
  existing: string[]
}

export interface DeferredIndexMaintenance {
  ensureDeferredIndexes(): Promise<DeferredIndexMaintenanceResult>
}

export interface MaintenanceIdleGate {
  wait(signal: AbortSignal): Promise<void>
}

export interface SourceRecordCompressionRunResult {
  scanned: number
  compressed: number
  plain: number
  savedBytes: number
  batches: number
  cursor?: string
  aborted: boolean
}

function progressRecord(progress: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return progress && typeof progress === 'object' && !Array.isArray(progress)
    ? progress as Record<string, JsonValue>
    : undefined
}

function progressNumber(progress: JsonValue | undefined, key: string): number {
  const value = progressRecord(progress)?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function progressCursor(progress: JsonValue | undefined): string | undefined {
  const value = progressRecord(progress)?.cursor
  return typeof value === 'string' && value ? value : undefined
}

export async function ensureDeferredStorageIndexes(
  maintenance: DeferredIndexMaintenance | undefined,
  gate: MaintenanceIdleGate,
  signal: AbortSignal,
): Promise<DeferredIndexMaintenanceResult | null> {
  if (!maintenance || signal.aborted) return null
  await gate.wait(signal)
  if (signal.aborted) return null
  return maintenance.ensureDeferredIndexes()
}

export async function compressLegacySourceRecords(
  maintenance: SourceRecordCompressionMaintenance | undefined,
  gate: MaintenanceIdleGate,
  signal: AbortSignal,
  options: {
    initialProgress?: JsonValue
    batchSize?: number
    onBatch?: (batch: SourceRecordCompressionBatch) => void
    report?: (progress: JsonValue) => Promise<boolean>
    yieldControl?: () => Promise<void>
  } = {},
): Promise<SourceRecordCompressionRunResult> {
  let cursor = progressCursor(options.initialProgress)
  const result: SourceRecordCompressionRunResult = {
    scanned: progressNumber(options.initialProgress, 'scanned'),
    compressed: progressNumber(options.initialProgress, 'compressed'),
    plain: progressNumber(options.initialProgress, 'plain'),
    savedBytes: progressNumber(options.initialProgress, 'savedBytes'),
    batches: progressNumber(options.initialProgress, 'batches'),
    ...(cursor ? { cursor } : {}),
    aborted: false,
  }
  if (!maintenance) return result

  const batchSize = Math.max(1, Math.min(options.batchSize ?? 250, 2000))
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => setImmediate(resolve)))

  while (!signal.aborted) {
    await gate.wait(signal)
    if (signal.aborted) break

    const batch = await maintenance.compressSourceRecords(batchSize, cursor)
    result.scanned += batch.scanned
    result.compressed += batch.compressed
    result.plain += batch.plain
    result.savedBytes += batch.savedBytes
    result.batches += 1
    cursor = batch.cursor ?? cursor
    if (cursor) result.cursor = cursor
    options.onBatch?.(batch)

    const accepted = await options.report?.({
      scanned: result.scanned,
      compressed: result.compressed,
      plain: result.plain,
      savedBytes: result.savedBytes,
      batches: result.batches,
      ...(cursor ? { cursor } : {}),
    })
    if (accepted === false) break
    if (!batch.hasMore || batch.scanned === 0) break
    await yieldControl()
  }
  result.aborted = signal.aborted
  return result
}

export const storageMaintenanceInternals = {
  progressRecord,
  progressNumber,
  progressCursor,
}
