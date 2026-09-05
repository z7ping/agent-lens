export interface SourceRecordCompressionBatch {
  scanned: number
  compressed: number
  plain: number
  rawBytes: number
  storedBytes: number
  savedBytes: number
  hasMore: boolean
}

export interface SourceRecordCompressionMaintenance {
  compressSourceRecords(limit?: number): Promise<SourceRecordCompressionBatch>
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
  aborted: boolean
}

export async function compressLegacySourceRecords(
  maintenance: SourceRecordCompressionMaintenance | undefined,
  gate: MaintenanceIdleGate,
  signal: AbortSignal,
  options: {
    batchSize?: number
    onBatch?: (batch: SourceRecordCompressionBatch) => void
    yieldControl?: () => Promise<void>
  } = {},
): Promise<SourceRecordCompressionRunResult> {
  const result: SourceRecordCompressionRunResult = {
    scanned: 0,
    compressed: 0,
    plain: 0,
    savedBytes: 0,
    batches: 0,
    aborted: false,
  }
  if (!maintenance) return result

  const batchSize = Math.max(1, Math.min(options.batchSize ?? 250, 2000))
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => setImmediate(resolve)))

  while (!signal.aborted) {
    await gate.wait(signal)
    if (signal.aborted) break

    const batch = await maintenance.compressSourceRecords(batchSize)
    result.scanned += batch.scanned
    result.compressed += batch.compressed
    result.plain += batch.plain
    result.savedBytes += batch.savedBytes
    result.batches += 1
    options.onBatch?.(batch)

    if (!batch.hasMore || batch.scanned === 0) break
    await yieldControl()
  }
  result.aborted = signal.aborted
  return result
}
