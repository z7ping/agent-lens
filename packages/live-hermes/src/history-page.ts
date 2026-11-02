import type { LiveSnapshotPage, LiveSnapshotWindow } from '@agent-lens/core'

/** Hermes REST messages supports offset pagination in both chronological directions. */
export interface HermesHistoryQuery {
  order: 'latest' | 'oldest'
  offset: number
  limit: number
  /** Exact boundary row identity; only latest-order offsets can drift on append. */
  anchorId?: string
  anchorOffset?: number
  direction?: 'before' | 'after'
}

const CURSOR = /^hermes-history:(latest|oldest):(0|[1-9]\d*)(?::(.+))?$/
const DEFAULT_LIMIT = 120
const MAX_LIMIT = 500

function cursor(value: string): HermesHistoryQuery {
  const match = CURSOR.exec(value)
  const offset = match ? Number(match[2]) : Number.NaN
  if (!match || !Number.isSafeInteger(offset)) {
    throw new Error('Invalid Hermes history cursor')
  }
  let anchorId: string | undefined
  try {
    anchorId = match[3] ? decodeURIComponent(match[3]) : undefined
  } catch {
    throw new Error('Invalid Hermes history anchor')
  }
  if (anchorId && anchorId.length > 400) throw new Error('Hermes history anchor is too long')
  return { order: match[1] as HermesHistoryQuery['order'], offset, limit: DEFAULT_LIMIT,
    ...(anchorId ? { anchorId } : {}) }
}

function encoded(order: HermesHistoryQuery['order'], offset: number, id?: string): string {
  return `hermes-history:${order}:${offset}${id ? `:${encodeURIComponent(id)}` : ''}`
}

/** Return a bounded native REST query. No full-session message scan is needed. */
export function hermesHistoryQuery(window: LiveSnapshotWindow = {}): HermesHistoryQuery {
  const n = window.limit
  const limit = typeof n === 'number' && Number.isFinite(n)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(n))) : DEFAULT_LIMIT
  if ((window.before && window.after) || (window.around && (window.before || window.after))) {
    throw new Error('Conflicting Hermes history window cursors')
  }
  if (window.around) throw new Error('Hermes history does not expose an around cursor')

  if (window.before) {
    const anchor = cursor(window.before)
    return anchor.order === 'latest'
      ? { order: 'latest', offset: anchor.offset, limit,
        ...(anchor.anchorId ? { anchorId: anchor.anchorId, anchorOffset: anchor.offset,
          direction: 'before' as const } : {}) }
      : { order: 'oldest', offset: Math.max(0, anchor.offset - limit + 1),
        limit: Math.min(limit, anchor.offset + 1) }
  }
  if (window.after) {
    const anchor = cursor(window.after)
    return anchor.order === 'oldest'
      ? { order: 'oldest', offset: anchor.offset, limit }
      : { order: 'latest', offset: Math.max(0, anchor.offset - limit + 1),
        limit: Math.min(limit, anchor.offset + 1),
        ...(anchor.anchorId ? { anchorId: anchor.anchorId, anchorOffset: anchor.offset,
          direction: 'after' as const } : {}) }
  }
  return { order: window.edge === 'earliest' ? 'oldest' : 'latest', offset: 0, limit }
}

/**
 * Offset cursors are exclusive boundaries for the NEXT page. Hermes returns
 * both order=latest and order=oldest pages in chronological order.
 * hasMore is checked via a one-row probe, not inferred from a full page.
 */
export function hermesHistoryPage(
  query: HermesHistoryQuery,
  rows: readonly unknown[],
  hasMore: boolean,
): LiveSnapshotPage {
  const count = rows.length
  const older = count > 0 && (query.order === 'latest' ? hasMore : query.offset > 0)
  const newer = count > 0 && (query.order === 'oldest' ? hasMore : query.offset > 0)
  const first = rows[0] as Record<string, unknown> | undefined
  const last = rows.at(-1) as Record<string, unknown> | undefined
  const rowId = (record: Record<string, unknown> | undefined) =>
    typeof record?.id === 'string' || typeof record?.id === 'number'
      ? String(record.id) : undefined
  return {
    hasEarlier: older,
    ...(older ? { before: query.order === 'latest'
      ? encoded('latest', query.offset + count, rowId(first))
      : encoded('oldest', query.offset - 1) } : {}),
    ...(rowId(first) ? { first: rowId(first) } : {}),
    ...(rowId(last) ? { last: rowId(last) } : {}),
    hasLater: newer,
    ...(newer ? { after: query.order === 'oldest'
      ? encoded('oldest', query.offset + count)
      : encoded('latest', query.offset - 1, rowId(last)) } : {}),
  }
}
