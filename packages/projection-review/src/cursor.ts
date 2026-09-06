import type { ReviewDetailDirection, ReviewDetailFilter } from '@agent-lens/protocol'

type TimelineReviewCursor = {
  mode: 'timeline'
  direction: ReviewDetailDirection
  timelineCursor: string
  ordinal: number
}

type FilterReviewCursor = {
  mode: 'filter'
  filter: Exclude<ReviewDetailFilter, 'all' | 'latest'>
  ordinal: number
}

export type ReviewCursorPayload = TimelineReviewCursor | FilterReviewCursor

export interface ReviewListCursor {
  activeAt: string
  logicalSessionId: string
}

export function encodeReviewListCursor(value: ReviewListCursor): string {
  return JSON.stringify(value)
}

export function decodeReviewListCursor(value: string): ReviewListCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Invalid review list cursor')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid review list cursor')
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.activeAt !== 'string' || !record.activeAt
    || typeof record.logicalSessionId !== 'string' || !record.logicalSessionId) {
    throw new Error('Invalid review list cursor')
  }
  return { activeAt: record.activeAt, logicalSessionId: record.logicalSessionId }
}

export function encodeReviewCursor(value: ReviewCursorPayload): string {
  return JSON.stringify(value)
}

export function decodeReviewCursor(value: string): ReviewCursorPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Invalid review cursor')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid review cursor')
  }
  const record = parsed as Record<string, unknown>

  if (record.mode === 'filter') {
    if (record.filter !== 'errors' && record.filter !== 'latency') throw new Error('Invalid review cursor')
    if (!validOrdinal(record.ordinal)) throw new Error('Invalid review cursor')
    return { mode: 'filter', filter: record.filter, ordinal: record.ordinal }
  }

  if (record.mode !== 'timeline') throw new Error('Invalid review cursor')
  if (record.direction !== 'forward' && record.direction !== 'backward') throw new Error('Invalid review cursor')
  if (typeof record.timelineCursor !== 'string' || !record.timelineCursor) throw new Error('Invalid review cursor')
  if (!validOrdinal(record.ordinal)) throw new Error('Invalid review cursor')
  return {
    mode: 'timeline',
    direction: record.direction,
    timelineCursor: record.timelineCursor,
    ordinal: record.ordinal,
  }
}

function validOrdinal(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}
