import type { LiveEventDto } from '@agent-lens/protocol'

export type LiveUiRequest = Extract<LiveEventDto, { type: 'ui.request' }>

/** A runtime can have several simultaneous native extension dialogs. */
export function enqueueLiveUiRequest(
  pending: readonly LiveUiRequest[],
  request: LiveUiRequest,
): LiveUiRequest[] {
  return pending.some(item => item.requestId === request.requestId)
    ? [...pending] : [...pending, request]
}

/** Expiry/abort/response must only dismiss the exact native request ID. */
export function dismissLiveUiRequest(
  pending: readonly LiveUiRequest[],
  requestId: string,
): LiveUiRequest[] {
  return pending.filter(item => item.requestId !== requestId)
}
