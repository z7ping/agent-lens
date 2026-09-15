export interface StablePiLiveHistoryRoundProps<T> {
  projection: T
  showAllEvents: boolean
  eager: boolean
  estimate: number
}

/**
 * Explicit React.memo boundary for settled history. Composer draft state is not
 * part of this contract, so local typing cannot invalidate a stable round.
 */
export function sameStablePiLiveHistoryRoundProps<T>(
  previous: StablePiLiveHistoryRoundProps<T>,
  next: StablePiLiveHistoryRoundProps<T>,
): boolean {
  return previous.projection === next.projection
    && previous.showAllEvents === next.showAllEvents
    && previous.eager === next.eager
    && previous.estimate === next.estimate
}
