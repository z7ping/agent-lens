import type { NativeReviewTurnIndex } from './native-review-turn-index-http'

/** A Live event may link to one Source-verified original-session turn.
 * The Live adapter must attest the native file path; all source identity,
 * checkpoint completeness, uniqueness and file revision checks stay on the
 * common Source-backed index service.
 */
export async function matchIndexedNativeReviewTurn(
  index: Pick<NativeReviewTurnIndex,'findByNativeEventId'>,
  historySessionId: string,
  live: {ordinal:number;nativeEventId?:string},
  nativeSessionFilePath: string,
): Promise<{historySessionId:string;cursor:string;ordinal:number}|undefined> {
  if(!/^native:[a-f0-9]{32}$/.test(historySessionId)
    ||!Number.isSafeInteger(live.ordinal)||live.ordinal<1
    ||!live.nativeEventId||live.nativeEventId.length>256
    ||!nativeSessionFilePath)return undefined
  const match=await index.findByNativeEventId(
    historySessionId,live.nativeEventId,nativeSessionFilePath)
  if(!match||match.nativeEventId!==live.nativeEventId
    ||!Number.isSafeInteger(match.ordinal)||match.ordinal<1||!match.cursor)return undefined
  return {historySessionId,cursor:match.cursor,ordinal:match.ordinal}
}
