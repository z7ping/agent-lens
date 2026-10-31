import type { NativeReviewTurnIndex } from './native-review-turn-index-http'

/** Links one Live user entry to an already indexed native Review record.
 * Source Catalog authorization and unique Live->historySessionId resolution
 * happen at the caller; only the Source-validated sparse index owns cursors.
 * This is a *bounded* local seek, never an invented full-session alignment.
 */
export async function matchIndexedNativeReviewTurn(
  index: Pick<NativeReviewTurnIndex,'query'>,
  historySessionId: string,
  live: {ordinal:number;nativeEventId?:string},
): Promise<{historySessionId:string;cursor:string;ordinal:number}|undefined> {
  if (!/^native:[a-f0-9]{32}$/.test(historySessionId)
    || !Number.isSafeInteger(live.ordinal) || live.ordinal<1
    || !live.nativeEventId || live.nativeEventId.length>256) return undefined
  // Index lookup is metadata-only; a branch may insert other file turns.
  // The interval is a hint, never an ordinal equality assertion.
  const result=await index.query(historySessionId,{
    from:Math.max(1,live.ordinal-59),limit:120,
    expectedNativeEventId:live.nativeEventId,
  })
  if (result.state!=='available' || result.items.length!==1) return undefined
  const [item]=result.items
  if (!item || item.nativeEventId!==live.nativeEventId
    || !Number.isSafeInteger(item.ordinal) || item.ordinal<1
    || !item.cursor) return undefined
  // Even partial indexes may safely expose a verified known prefix; no
  // absence outside the scanned prefix is ever inferred.
  return {historySessionId,cursor:item.cursor,ordinal:item.ordinal}
}
