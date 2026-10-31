/** Session-scoped native user-turn identity is shared by Live and original
 * session indexes. Their ordinals are not interchangeable across branches. */
export interface NativeTurnAnchor {
  ordinal: number
  nativeEventId?: string | undefined
}

/** Callers must establish these proofs using the Source/Runtime authority.
 * A metadata-only equality check cannot verify an SDK parent chain. */
export interface NativeTurnAlignmentProof {
  sameNativeSession: boolean
  /** True only when both indexes refer to the same verified history view:
   * a complete native journal, or an explicitly verified ancestor path. */
  sameTurnViewVerified: boolean
  sourceIndexComplete: boolean
  liveIndexComplete: boolean
}

export type NativeTurnAlignment =
  | { state: 'verified'; items: Array<{ nativeEventId: string; liveOrdinal: number; sourceOrdinal: number }> }
  | { state: 'unavailable'; reason: 'scope-unverified' | 'incomplete-index' | 'missing-identity' | 'duplicate-identity' | 'missing-anchor' | 'out-of-order' }

/** Fail closed rather than assuming the Nth file turn is the Nth active turn.
 * Inactive file branches may be skipped only after ancestry is proven. */
export function alignVerifiedNativeTurns(
  liveTurns: readonly NativeTurnAnchor[],
  sourceTurns: readonly NativeTurnAnchor[],
  proof: NativeTurnAlignmentProof,
): NativeTurnAlignment {
  if (!proof.sameNativeSession || !proof.sameTurnViewVerified) {
    return { state: 'unavailable', reason: 'scope-unverified' }
  }
  if (!proof.sourceIndexComplete || !proof.liveIndexComplete) {
    return { state: 'unavailable', reason: 'incomplete-index' }
  }
  const sourceById = new Map<string, number>()
  let lastIndexedOrdinal = 0
  for (const source of sourceTurns) {
    if (!Number.isSafeInteger(source.ordinal) || source.ordinal < 1 || !source.nativeEventId) {
      return { state: 'unavailable', reason: 'missing-identity' }
    }
    if (sourceById.has(source.nativeEventId)) {
      return { state: 'unavailable', reason: 'duplicate-identity' }
    }
    if (source.ordinal <= lastIndexedOrdinal) {
      return { state: 'unavailable', reason: 'out-of-order' }
    }
    lastIndexedOrdinal = source.ordinal
    sourceById.set(source.nativeEventId, source.ordinal)
  }
  const items: Extract<NativeTurnAlignment, { state: 'verified' }>['items'] = []
  const seen = new Set<string>()
  let lastSourceOrdinal = 0
  let lastLiveOrdinal = 0
  for (const live of liveTurns) {
    if (!Number.isSafeInteger(live.ordinal) || live.ordinal <= lastLiveOrdinal || !live.nativeEventId) {
      return { state: 'unavailable', reason: 'missing-identity' }
    }
    if (seen.has(live.nativeEventId)) {
      return { state: 'unavailable', reason: 'duplicate-identity' }
    }
    seen.add(live.nativeEventId)
    const sourceOrdinal = sourceById.get(live.nativeEventId)
    if (sourceOrdinal === undefined) return { state: 'unavailable', reason: 'missing-anchor' }
    if (sourceOrdinal <= lastSourceOrdinal) return { state: 'unavailable', reason: 'out-of-order' }
    items.push({ nativeEventId: live.nativeEventId, liveOrdinal: live.ordinal, sourceOrdinal })
    lastSourceOrdinal = sourceOrdinal
    lastLiveOrdinal = live.ordinal
  }
  return { state: 'verified', items }
}
