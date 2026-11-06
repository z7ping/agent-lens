import type { NativeBodySearchHitDto, NativeReviewTurnIndexResponseDto } from '@agent-lens/protocol'

/** The search endpoint reports only a candidate; the existing Source-backed
 * sparse turn index is the authority. Never navigate on the candidate alone. */
export function verifiedNativeSearchHitTurn(
  hit: NativeBodySearchHitDto,
  index: NativeReviewTurnIndexResponseDto,
): number | undefined {
  const candidate = hit.turn
  if (!candidate || index.state !== 'available'
    || !Number.isSafeInteger(candidate.ordinal) || candidate.ordinal < 1
    || !candidate.nativeEventId || !candidate.recordFingerprint
    || !Number.isSafeInteger(candidate.recordOffset) || candidate.recordOffset < 0) return undefined
  const matches = index.items.filter(item =>
    item.ordinal === candidate.ordinal
    && item.nativeEventId === candidate.nativeEventId
    && Boolean(item.cursor))
  // The server additionally verifies recordOffset+SHA-256 before emitting
  // a locator; the client must not decode or reinterpret opaque Source cursors.
  return matches.length === 1 ? candidate.ordinal : undefined
}
