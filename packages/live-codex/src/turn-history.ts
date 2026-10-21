import type { LiveRuntimeState, LiveSnapshot, LiveSnapshotWindow } from '@agent-lens/core'
import type { CodexRpc } from './transport.js'
import { codexRecord, codexSnapshotEntries, codexText } from './events.js'

const PREFIX = 'codex-turn-history:'
const MAX_CURSOR_LENGTH = 8192
type Direction = 'asc' | 'desc'
type TurnCursor =
  | { kind: 'page', direction: Direction, cursor?: string, skip: number }
  | { kind: 'anchor', turnId: string, itemId: string, backwardsCursor: string }

type TurnItem = { turnId: string, item: unknown }

export function isCodexTurnHistoryCursor(value?: string): boolean {
  return Boolean(value?.startsWith(PREFIX))
}

function encodeCursor(value: TurnCursor): string {
  const encoded = PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  if (encoded.length > MAX_CURSOR_LENGTH) throw new Error('Codex turn history cursor is too long')
  return encoded
}

function decodeCursor(value: string): TurnCursor {
  if (!value.startsWith(PREFIX) || value.length > MAX_CURSOR_LENGTH) {
    throw new Error('Invalid Codex turn history cursor')
  }
  try {
    const valueRecord: unknown = JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString('utf8'))
    const row = codexRecord(valueRecord)
    if (row.kind === 'anchor' && typeof row.turnId === 'string' && row.turnId
      && typeof row.itemId === 'string' && row.itemId
      && typeof row.backwardsCursor === 'string' && row.backwardsCursor) {
      return { kind: 'anchor', turnId: row.turnId, itemId: row.itemId, backwardsCursor: row.backwardsCursor }
    }
    if (row.kind === 'page' && (row.direction === 'asc' || row.direction === 'desc')
      && Number.isSafeInteger(row.skip) && Number(row.skip) >= 0
      && (row.cursor === undefined || typeof row.cursor === 'string')) {
      return { kind: 'page', direction: row.direction, skip: Number(row.skip),
        ...(typeof row.cursor === 'string' ? { cursor: row.cursor } : {}) }
    }
  } catch { /* Invalid user-supplied cursor */ }
  throw new Error('Invalid Codex turn history cursor')
}

/** Legacy Codex thread stores cannot page items, but can return full items in turn pages.
 * Keep each response bounded and retain a cursor into an oversized native turn page.
 * No second transcript is stored by AgentLens.
 */
export async function snapshotCodexTurnHistory(
  rpc: Pick<CodexRpc, 'request'>,
  state: LiveRuntimeState,
  since?: string,
  window?: LiveSnapshotWindow,
): Promise<LiveSnapshot> {
  const limit = Math.max(1, Math.min(500, Math.floor(window?.limit ?? 120)))
  const requested = since ?? window?.after ?? window?.before
  // Old item-level checkpoints are not valid after falling back to turn pagination.
  // Recover from the latest page rather than sending an incompatible native cursor.
  const selector = requested && isCodexTurnHistoryCursor(requested) ? decodeCursor(requested) : undefined
  const anchor = selector?.kind === 'anchor' ? selector : undefined
  const page = selector?.kind === 'page' ? selector : undefined
  const direction: Direction = anchor ? 'asc' : page?.direction
    ?? (window?.edge === 'earliest' ? 'asc' : 'desc')
  const nativeCursor = anchor?.backwardsCursor ?? page?.cursor
  const response = await rpc.request('thread/turns/list', {
    threadId: state.nativeSessionId ?? state.runtimeSessionId,
    limit: Math.min(32, Math.max(1, Math.ceil(limit / 3))),
    sortDirection: direction, itemsView: 'full',
    ...(nativeCursor ? { cursor: nativeCursor } : {}),
  })
  const turns = Array.isArray(response.data) ? response.data : []
  const rows: TurnItem[] = turns.flatMap(raw => {
    const turn = codexRecord(raw)
    const items = Array.isArray(turn.items) ? turn.items : []
    const ordered = direction === 'desc' ? [...items].reverse() : items
    return ordered.map(item => ({ turnId: codexText(turn.id), item }))
  })
  let offset = page?.skip ?? 0
  if (anchor) {
    const found = rows.findIndex(row => row.turnId === anchor.turnId
      && codexText(codexRecord(row.item).id) === anchor.itemId)
    if (found < 0) {
      throw new Error('Codex turn history anchor is unavailable; reload the latest snapshot')
    }
    offset = found + 1
  }
  // A persisted tool may produce two shared entries, so budget native items accordingly.
  const budget = Math.max(1, Math.floor(limit / 2))
  const selected = rows.slice(offset, offset + budget)
  const chronological = direction === 'asc' ? selected : [...selected].reverse()
  const { entries } = codexSnapshotEntries(chronological.map(row => ({ items: [row.item] })), Math.max(2, limit))
  const nextCursor = codexText(response.nextCursor)
  const backwardsCursor = codexText(response.backwardsCursor)
  const next = offset + selected.length < rows.length
    ? encodeCursor({ kind: 'page', direction, ...(nativeCursor ? { cursor: nativeCursor } : {}), skip: offset + selected.length })
    : nextCursor ? encodeCursor({ kind: 'page', direction, cursor: nextCursor, skip: 0 }) : undefined

  const last = chronological.at(-1)
  const lastItemId = codexText(codexRecord(last?.item).id)
  let leafId: string | undefined
  if (direction === 'desc' && !window?.before && last?.turnId && lastItemId && backwardsCursor) {
    leafId = encodeCursor({ kind: 'anchor', turnId: last.turnId, itemId: lastItemId, backwardsCursor })
  } else if (direction === 'asc' && !next && last?.turnId && lastItemId) {
    const latest = await rpc.request('thread/turns/list', {
      threadId: state.nativeSessionId ?? state.runtimeSessionId,
      limit: 1, sortDirection: 'desc', itemsView: 'full',
    }).catch((): Record<string, unknown> => ({}))
    const first = codexRecord(Array.isArray(latest.data) ? latest.data[0] : undefined)
    const firstItems = Array.isArray(first.items) ? first.items : []
    const actualLast = codexRecord(firstItems.at(-1))
    if (codexText(first.id) === last.turnId && codexText(actualLast.id) === lastItemId
      && codexText(latest.backwardsCursor)) {
      leafId = encodeCursor({
        kind: 'anchor', turnId: last.turnId, itemId: lastItemId,
        backwardsCursor: codexText(latest.backwardsCursor),
      })
    }
  }
  if (!leafId && anchor && since) leafId = since

  return {
    state, entries, ...(leafId ? { leafId } : {}),
    page: {
      hasEarlier: direction === 'asc' ? Boolean(selector) : Boolean(next),
      ...(direction === 'desc' && next ? { before: next } : {}),
      ...(direction === 'asc' && selector && backwardsCursor
        ? { before: encodeCursor({ kind: 'page', direction: 'desc', cursor: backwardsCursor, skip: 0 }) } : {}),
      hasLater: direction === 'asc' ? Boolean(next) : Boolean(window?.before),
      ...(direction === 'asc' && next ? { after: next } : {}),
      ...(direction === 'desc' && window?.before && backwardsCursor
        ? { after: encodeCursor({ kind: 'page', direction: 'asc', cursor: backwardsCursor, skip: 0 }) } : {}),
    },
  }
}
