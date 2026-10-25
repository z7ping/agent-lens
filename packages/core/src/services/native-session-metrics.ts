/**
 * ADR-0024 B: compact, disposable numerical projection of Source-owned facts.
 * One row per native session plus at most 256 per-tool aggregates. No event
 * IDs, prompts, arguments, outputs, raw errors, evidence, or payload JSON.
 */
export interface NativeSessionMetricTool {
  nativeToolName: string
  callCount: number
  resultCount: number
  errorCount: number
  totalDurationMs: number
}

export interface NativeSessionMetricSnapshot {
  sourceId: string
  installationId: string
  nativeSessionId: string
  /** Bound to the exact current native Catalog revision, never a body copy. */
  fileIdentity: string
  fileSize: number
  fileMtimeMs: number
  parserVersion: string
  projectionVersion: string
  /** Partial observations must never be silently treated as session totals. */
  coverage: 'complete' | 'partial'
  interactionCount: number
  toolCallCount: number
  toolResultCount: number
  toolErrorCount: number
  errorCount: number
  /** Null means not observed, NOT zero. */
  inputTokens: number | null
  outputTokens: number | null
  computedAt: string
  tools: NativeSessionMetricTool[]
}

export type NativeSessionMetricReadResult =
  | { state: 'available'; snapshot: NativeSessionMetricSnapshot }
  | { state: 'missing' | 'stale' }

export interface NativeSessionMetricsStore {
  /** Atomically replace the derived snapshot only for a Catalog-matching revision. */
  replace(snapshot: NativeSessionMetricSnapshot): Promise<boolean>
  /** Never serve stale metrics as current after a known source revision change. */
  get(identity: {
    sourceId: string; installationId: string; nativeSessionId: string
  }): Promise<NativeSessionMetricReadResult>
  /** Explicit invalidation on source/parse/policy change or user deletion. */
  invalidate(identity: {
    sourceId: string; installationId: string; nativeSessionId: string
  }): Promise<void>
}
