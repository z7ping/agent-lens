import type { ReviewInteractionDto } from './review'

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
  observationCount: number
  hasMore: boolean
  pendingTail: boolean
  nextCursor: string
  /**
   * A source byte window may split a tool call/result or a user turn.
   * Until adjacent windows are stitched, treat its boundaries as partial.
   */
  boundaryIntegrity: 'complete' | 'partial'
}
