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
