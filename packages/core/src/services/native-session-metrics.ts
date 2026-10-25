/**
 * ADR-0024 B: compact, disposable numerical projection of Source-owned facts.
 * One row per native session plus at most 256 per-tool aggregates. No event
 * IDs, prompts, arguments, outputs, raw errors, evidence, or payload JSON.
 */
/** A projection rule change requires rebuilding the affected Source sessions. */
export const NATIVE_SESSION_METRIC_PROJECTION_VERSION='native-source-metrics-v1'

export interface NativeSessionMetricOverviewQuery {
  sourceId:string
  /** The current registered Source parser, not a remembered DB version. */
  parserVersion:string
  /** Must be explicitly attested by the current Source. Missing means unverified. */
  coverageCertified?:boolean
  installationId?:string
  from?:string
  to?:string
}
export interface NativeSessionMetricToolTotal {
  nativeToolName:string
  callCount:number
  resultCount:number
  errorCount:number
  totalDurationMs:number
  sessionCount:number
}
export interface NativeSessionMetricOverview {
  sourceId:string
  eligibleSessions:number
  readySessions:number
  missingSessions:number
  staleSessions:number
  partialSessions:number
  /** Only verified COMPLETE sessions contribute to these totals. */
  totals:{
    interactionCount:number
    toolCallCount:number
    toolResultCount:number
    toolErrorCount:number
    errorCount:number
    inputTokens:number|null
    outputTokens:number|null
  }
  /** Only tool names and numbers. No event ID, args or output. */
  tools:NativeSessionMetricToolTotal[]
  toolsTruncated:boolean
}

/** Bounded, metadata-only candidate for lazy numerical repair. */
export interface NativeSessionMetricRebuildCandidate {
  reviewSessionId:string
  sourceId:string
  installationId:string
  nativeSessionId:string
  /** Metadata-only keyset for fair, bounded rebuild scheduling. */
  lastActivityAt:string
}

export type NativeSessionMetricRebuildCursor = Pick<NativeSessionMetricRebuildCandidate,
  'lastActivityAt'|'installationId'|'nativeSessionId'>

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
  /** SQL-only aggregates over CURRENT complete Native-only claims.
   * Reports missing/stale/partial sessions separately, never adds old SQL
   * and native totals together for the same Source identity.
   */
  overview?(query:NativeSessionMetricOverviewQuery):Promise<NativeSessionMetricOverview>
  /** Metadata-only candidates; does not read native sessions or scan at startup. */
  findRebuildCandidates?(query:NativeSessionMetricOverviewQuery,limit:number,
    before?:NativeSessionMetricRebuildCursor):Promise<NativeSessionMetricRebuildCandidate[]>
  /** Explicit invalidation on source/parse/policy change or user deletion. */
  invalidate(identity: {
    sourceId: string; installationId: string; nativeSessionId: string
  }): Promise<void>
}
