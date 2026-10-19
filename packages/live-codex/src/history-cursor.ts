/** Codex native history anchor: stable by turn+item, independent of opaque pagination cursors. */
export interface CodexItemAnchor {
  turnId: string
  itemId: string
  /** Native backwardsCursor points to this item when switching from desc to asc. */
  backwardsCursor: string
}
const ITEM_PREFIX = 'codex-item:'
const PAGE_PREFIX = 'codex-page:'
const MAX_CURSOR_LENGTH = 8192

export function encodeCodexItemAnchor(value: CodexItemAnchor): string {
  if (!value.turnId || !value.itemId || !value.backwardsCursor) throw new Error('Codex item anchor requires turn and item IDs')
  return ITEM_PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function encodeCodexPageCursor(cursor: string): string {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH) throw new Error('Invalid Codex pagination cursor')
  return PAGE_PREFIX + Buffer.from(cursor, 'utf8').toString('base64url')
}

export type CodexHistoryCursor =
  | { kind: 'item', anchor: CodexItemAnchor }
  | { kind: 'page', cursor: string }

export function decodeCodexHistoryCursor(value: string): CodexHistoryCursor {
  if (!value || value.length > MAX_CURSOR_LENGTH) throw new Error('Invalid Codex history cursor')
  if (value.startsWith(PAGE_PREFIX)) {
    const cursor = Buffer.from(value.slice(PAGE_PREFIX.length), 'base64url').toString('utf8')
    if (!cursor) throw new Error('Empty Codex page cursor')
    return { kind: 'page', cursor }
  }
  if (value.startsWith(ITEM_PREFIX)) {
    try {
      const raw: unknown = JSON.parse(Buffer.from(value.slice(ITEM_PREFIX.length), 'base64url').toString('utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const row = raw as Record<string, unknown>
        if (typeof row.turnId === 'string' && row.turnId
          && typeof row.itemId === 'string' && row.itemId
          && typeof row.backwardsCursor === 'string' && row.backwardsCursor) {
          return { kind: 'item', anchor: { turnId: row.turnId, itemId: row.itemId, backwardsCursor: row.backwardsCursor } }
        }
      }
    } catch { /* invalid anchor */ }
  }
  throw new Error('Unsupported Codex history cursor; a full snapshot is required')
}
