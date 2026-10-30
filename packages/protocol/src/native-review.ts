import type { ReviewInteractionDto } from './review'
import type { TaskFileChangeDto } from './task-file-changes'

/** Metadata-only native catalog records; never expose Source-owned file locators. */
export interface NativeSessionSummaryDto {
  id: string
  sourceId: string
  installationId: string
  nativeSessionId: string
  locationKind: 'native' | 'archive'
  lastActivityAt: string
  title?: string
  /** Source-native labels are not proof of an explicit or AI-generated title. */
  titleProvenance?: 'native' | 'explicit' | 'generated' | 'unknown'
  /** Slim-only indexed association; workspace path comes from verified Source metadata. */
  projectId?: string
  projectName?: string
  workspacePath?: string
  /** Only a certified "complete" status may justify a clean-session verdict. */
  metricsState?: 'missing' | 'stale' | 'partial' | 'complete'
  metrics?: {
    interactionCount: number
    toolCallCount: number
    toolResultCount: number
    toolErrorCount: number
    errorCount: number
    inputTokens: number | null
    outputTokens: number | null
  }
}

export interface NativeSessionCatalogResponseDto {
  items: NativeSessionSummaryDto[]
  hasMore: boolean
  nextCursor?: string
}

/** Progressive source-owned text search: one native Catalog session/page per request.
 * Empty items with hasMore=true is NOT a completed search or no-match result.
 */
export interface NativeBodySearchHitDto {
  sessionId: string
  sourceId: string
  installationId: string
  nativeSessionId: string
  lastActivityAt: string
  title?: string
  observationId: string
  kind: string
  at: string
  excerpt: string
}

export type NativeBodySearchResponseDto =
  | {
      state: 'available'
      coverage: 'bounded'
      items: NativeBodySearchHitDto[]
      scannedSessions: number
      scannedObservations: number
      hasMore: boolean
      pendingTail: boolean
      nextCursor?: string
    }
  | { state: 'unavailable' | 'drifted' | 'unsupported'; reason: string }

/** A lightweight per-session status for lazy Native-only metric refresh. */
export type NativeMetricStatusDto = {
  state:'available'|'missing'|'stale'|'unsupported'|'unavailable'|'drifted'
  reason?:string
}

/** SQL-only numerical projection. No event rows or local file locations. */
export interface NativeMetricOverviewSourceDto {
  sourceId:string
  eligibleSessions:number
  readySessions:number
  missingSessions:number
  staleSessions:number
  partialSessions:number
  totals:{
    interactionCount:number;toolCallCount:number;toolResultCount:number
    toolErrorCount:number;errorCount:number
    inputTokens:number|null;outputTokens:number|null
  }
  tools:Array<{
    nativeToolName:string;callCount:number;resultCount:number
    errorCount:number;totalDurationMs:number;sessionCount:number
    durationSampleCount?:number;maxDurationMs?:number|null
  }>
  toolsTruncated:boolean
}
export type NativeMetricOverviewResponseDto =
  | {
      state:'available'
      coverage:'complete'|'partial'
      items:NativeMetricOverviewSourceDto[]
      totals:{
        eligibleSessions:number;readySessions:number
        missingSessions:number;staleSessions:number;partialSessions:number
      }
    }
  | {state:'unavailable'|'unsupported';reason:string}

/** Explicit contribution from currently verified Native-only sessions.
 * This is NOT silently added to Legacy summary totals.
 */
export type NativeMetricContributionDto =
  | {
      state:'available'
      coverage:'complete'|'partial'
      eligibleSessions:number
      readySessions:number
      missingSessions:number
      staleSessions:number
      partialSessions:number
      /** Exact for ready native sessions only; others are excluded. */
      interactionCount:number
      toolCallCount:number
      errorCount:number
      inputTokens:number|null
      outputTokens:number|null
      /** Lower-bound native-file observations from partial sessions; never merged into certified totals. */
      observed?:{
        interactionCount:number
        toolCallCount:number
        errorCount:number
        tools?:Array<{
          sourceId:string
          nativeToolName:string
          callCount:number
          resultCount:number
          errorCount:number
          sessionCount:number
          durationSampleCount?:number
          averageDurationMs?:number|null
          maxDurationMs?:number|null
        }>
        toolsTruncated?:boolean
      }
      /** Optional bounded, per-Source numerical tool totals for Usage UI. */
      tools?:Array<{
        sourceId:string
        nativeToolName:string
        callCount:number
        resultCount:number
        errorCount:number
        sessionCount:number
      }>
      toolsTruncated?:boolean
    }
  | {state:'unavailable'|'unsupported';reason:string}

export type NativeReviewWindowResponseDto =
  | NativeReviewWindowDto
  | { state: 'unavailable' | 'drifted' | 'unsupported'; reason: string }


/**
 * Review-format view of an original Agent session page. No SQL observation
 * IDs, source file locators or persisted Evidence relationships are implied.
 */
export interface NativeReviewWindowDto {
  state: 'available'
  sourceId: string
  installationId: string
  nativeSessionId: string
  /** Synthetic, deterministic across requests for a single native session. */
  sessionId: string
  interactions: ReviewInteractionDto[]
  /** Optional opt-in paging mode; the default mode remains raw native windows. */
  pagingUnit?: 'interaction'
  /** A bounded fragment of a single semantic turn; partial never proves completion. */
  turnFragment?: 'partial' | 'complete' | undefined
  observationCount: number
  /** File mutation evidence from the returned complete user-turn window only. */
  observedFileChanges?: TaskFileChangeDto[]
  fileChangesTruncated?: boolean
  /** True when the supplementary Hook lane reaches its bounded read limit.
   * A partial Hook lane is never a complete user-turn history.
   */
  hookEventsTruncated?: boolean
  /** Some Hook facts were left on the standalone lane because exact turn identity is not proven. */
  hookFactsPartial?: boolean
  hasMore: boolean
  pendingTail: boolean
  nextCursor: string
  /**
   * A source byte window may split a tool call/result or a user turn.
   * "complete" means the returned logical interactions have safe boundaries,
   * not necessarily that the entire native session has been exhausted.
   */
  boundaryIntegrity: 'complete' | 'partial'
}

/** Sparse, source-validated native turn index. No message, tool or evidence text. */
export interface NativeReviewTurnLocatorDto {
  ordinal: number
  /** Opaque, Source-owned record-boundary cursor accepted by native Review. */
  cursor: string
  at?: string
}

export type NativeReviewTurnIndexResponseDto =
  | {
      state: 'available'
      coverage: 'partial' | 'complete'
      knownTurns: number
      /** Exact only after scanning the native source to a verified EOF. */
      totalTurns?: number
      scannedOffset: number
      items: NativeReviewTurnLocatorDto[]
      hasMore: boolean
    }
  | { state: 'unavailable' | 'unsupported' | 'drifted'; reason: string }
