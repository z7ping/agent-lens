/**
 * ADR-0024 B: compact, disposable numerical projection of Source-owned facts.
 * One row per native session plus at most 256 per-tool aggregates. No event
 * IDs, prompts, arguments, outputs, raw errors, evidence, or payload JSON.
 */
/** A projection rule change requires rebuilding the affected Source sessions. */
export const NATIVE_SESSION_METRIC_PROJECTION_VERSION='native-source-metrics-v3'

export interface NativeSessionMetricOverviewQuery {
  sourceId:string
  /** The current registered Source parser, not a remembered DB version. */
  parserVersion:string
  /** Must be explicitly attested by the current Source. Missing means unverified. */
  coverageCertified?:boolean
  installationId?:string
  /** Slim-only project attribution; never infer it from legacy event bodies. */
  projectId?:string
  /** Optional exact tool name for SQL-indexed drilldown; not an event search. */
  nativeToolName?:string
  from?:string
  to?:string
  /** Optional, bounded daily attribution by session last activity; no event timestamps. */
  includeTrend?:boolean
}
export interface NativeSessionMetricToolTotal {
  nativeToolName:string
  callCount:number
  resultCount:number
  errorCount:number
  totalDurationMs:number
  /** Count of result events with an explicitly observed duration. */
  durationSampleCount?:number
  /** Null when no duration can be observed; zero is a valid duration. */
  maxDurationMs?:number|null
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
  /** Observed facts in partial sessions are lower bounds, never certified full totals. */
  observed?:{
    interactionCount:number
    toolCallCount:number
    errorCount:number
    tools:NativeSessionMetricToolTotal[]
    toolsTruncated:boolean
  }
  /** Counts for verified sessions grouped by their last-activity date (UTC).
   * Not a per-event timestamp series; partial/missing/stale sessions excluded.
   */
  trend?:Array<{date:string;sessionCount:number;interactionCount:number;toolCallCount:number;errorCount:number}>
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
  durationSampleCount?: number
  maxDurationMs?: number | null
}

/** Explicit, compact, recomputable source error fact; NEVER raw event output. */
export interface NativeErrorIndexQuery {
  sourceId:string
  parserVersion:string
  projectId?:string
  toolName?:string
  from?:string
  to?:string
  search?:string
  fingerprint?:string
  limit:number
  offset:number
}
export interface NativeErrorIndexResult {
  indexedSessions:number
  total:number
  hasMore:boolean
  items:Array<NativeErrorIndexEntry & {
    sessionId:string
    sourceId:string
    coverage:'complete'|'partial'
  }>
}

export interface NativeErrorIndexEntry {
  eventKey:string
  occurredAt:string
  nativeEventId:string|null
  /** Null until source-specific branch/turn identity has been verified. */
  turnOrdinal:number|null
  toolName:string|null
  kind:'tool'|'runtime'
  errorCode:string|null
  summary:string
  fingerprint:string
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
  /** Bounded staging batches; rows remain invisible until a matching revision publishes. */
  stageErrors?(identity:{sourceId:string;installationId:string;nativeSessionId:string},
    generation:string,errors:readonly NativeErrorIndexEntry[]):Promise<void>
  publishErrors?(snapshot:NativeSessionMetricSnapshot,generation:string):Promise<boolean>
  /** Indexed source-only errors; query scope must match the current parser. */
  queryErrors?(query:NativeErrorIndexQuery):Promise<NativeErrorIndexResult>
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
