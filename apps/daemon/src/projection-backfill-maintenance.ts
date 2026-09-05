import type { JsonValue } from '@agent-lens/core'

export interface ProjectionBackfillBatch {
  scanned: number
  written: number
  cursor?: string
  hasMore: boolean
}

export interface ProjectionBackfillMaintenance {
  backfillUnknownObservations(after?: string, limit?: number): Promise<ProjectionBackfillBatch>
  backfillToolUsageFacts(after?: string, limit?: number): Promise<ProjectionBackfillBatch>
}

export interface ProjectionBackfillIdleGate {
  wait(signal: AbortSignal): Promise<void>
}

export interface ProjectionBackfillRunResult {
  scanned: number
  written: number
  batches: number
  cursor?: string
  aborted: boolean
}

function cursorFromProgress(progress: JsonValue | undefined): string | undefined {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return undefined
  const cursor = (progress as Record<string, JsonValue>).cursor
  return typeof cursor === 'string' && cursor ? cursor : undefined
}

async function runBatches(
  execute: (after?: string, limit?: number) => Promise<ProjectionBackfillBatch>,
  gate: ProjectionBackfillIdleGate,
  signal: AbortSignal,
  options: {
    initialProgress?: JsonValue
    batchSize?: number
    report?: (progress: JsonValue) => Promise<boolean>
    yieldControl?: () => Promise<void>
  } = {},
): Promise<ProjectionBackfillRunResult> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 250, 1000))
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => setImmediate(resolve)))
  let cursor = cursorFromProgress(options.initialProgress)
  let scanned = 0
  let written = 0
  let batches = 0

  while (!signal.aborted) {
    await gate.wait(signal)
    if (signal.aborted) break

    const batch = await execute(cursor, batchSize)
    scanned += batch.scanned
    written += batch.written
    batches += 1
    cursor = batch.cursor ?? cursor

    const accepted = await options.report?.({
      scanned,
      written,
      batches,
      ...(cursor ? { cursor } : {}),
    })
    if (accepted === false) break
    if (!batch.hasMore || batch.scanned === 0) break
    await yieldControl()
  }

  return {
    scanned,
    written,
    batches,
    ...(cursor ? { cursor } : {}),
    aborted: signal.aborted,
  }
}

export function backfillUnknownObservationProjection(
  maintenance: ProjectionBackfillMaintenance | undefined,
  gate: ProjectionBackfillIdleGate,
  signal: AbortSignal,
  options: Parameters<typeof runBatches>[3] = {},
): Promise<ProjectionBackfillRunResult> {
  if (!maintenance) return Promise.resolve({ scanned: 0, written: 0, batches: 0, aborted: signal.aborted })
  return runBatches(
    (after, limit) => maintenance.backfillUnknownObservations(after, limit),
    gate,
    signal,
    options,
  )
}

export function backfillToolUsageFactProjection(
  maintenance: ProjectionBackfillMaintenance | undefined,
  gate: ProjectionBackfillIdleGate,
  signal: AbortSignal,
  options: Parameters<typeof runBatches>[3] = {},
): Promise<ProjectionBackfillRunResult> {
  if (!maintenance) return Promise.resolve({ scanned: 0, written: 0, batches: 0, aborted: signal.aborted })
  return runBatches(
    (after, limit) => maintenance.backfillToolUsageFacts(after, limit),
    gate,
    signal,
    options,
  )
}

export const projectionBackfillInternals = {
  cursorFromProgress,
  runBatches,
}
