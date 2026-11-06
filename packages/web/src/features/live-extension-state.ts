import type { LiveEventDto } from '@agent-lens/protocol'

export type LiveExtensionState = Extract<LiveEventDto, { type: 'ui.state' }>

/** Pi setStatus/setWidget replace by (kind,key), and undefined clears.
 * This is UI state, never a transcript or a notification. */
export function reduceLiveExtensionState(
  current: readonly LiveExtensionState[],
  next: LiveExtensionState,
): LiveExtensionState[] {
  const index = current.findIndex(item => item.kind === next.kind && item.key === next.key)
  const cleared = next.kind === 'status'
    ? next.text === null || next.text === ''
    : next.lines === null || next.lines.length === 0
  if (cleared) return index < 0 ? [...current] : current.filter((_, i) => i !== index)
  if (index < 0) return [...current, next]
  const updated = [...current]
  updated[index] = next
  return updated
}

/** Unknown widget payloads stay readable without interpreting their meaning:
 * a `PREFIX:{json}` line collapses to the JSON's own `kind` (or just the
 * prefix), and the untouched payload remains in the raw inspector drawer. */
export function extensionWidgetSummary(lines: readonly string[] | null | undefined): string {
  const joined = (lines ?? []).join(' · ').trim()
  if (!joined) return ''
  const match = /^([A-Za-z0-9_.-]+):\s*(\{[\s\S]*)$/.exec(joined)
  if (!match) return joined.slice(0, 220)
  const prefix = match[1]!
  let payload: unknown
  try { payload = JSON.parse(match[2]!) } catch { return prefix }
  if (payload && typeof payload === 'object' && 'kind' in payload) {
    const kind = (payload as { kind: unknown }).kind
    if (typeof kind === 'string' && kind.trim()) return kind.trim()
  }
  return prefix
}
