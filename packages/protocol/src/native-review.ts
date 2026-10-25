import type { ReviewInteractionDto } from './review'

/** Metadata-only native catalog records; never expose Source-owned file locators. */
export interface NativeSessionSummaryDto {
  id: string
  sourceId: string
  installationId: string
  nativeSessionId: string
  locationKind: 'native' | 'archive'
  lastActivityAt: string
  title?: string
}

export interface NativeSessionCatalogResponseDto {
  items: NativeSessionSummaryDto[]
  hasMore: boolean
  nextCursor?: string
}

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
  observationCount: number
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
