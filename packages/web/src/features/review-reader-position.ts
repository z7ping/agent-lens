import type { ReviewInteractionDto } from '@agent-lens/protocol'
import { elapsed } from './review-session-format'

export interface ReviewReaderPosition {
  interactionId: string
  offset: number
  scrollTop: number
}

export function captureReviewReaderPosition(pane: HTMLElement): ReviewReaderPosition {
  const paneTop = pane.getBoundingClientRect().top
  let anchor: HTMLElement | null = null
  for (const element of pane.querySelectorAll<HTMLElement>('.virtual-round-shell[data-interaction-id]')) {
    const top = element.getBoundingClientRect().top
    if (top <= paneTop + 56) anchor = element
    else if (!anchor) {
      anchor = element
      break
    } else break
  }
  return {
    interactionId: anchor?.dataset.interactionId ?? '',
    offset: anchor ? anchor.getBoundingClientRect().top - paneTop : 0,
    scrollTop: pane.scrollTop,
  }
}

export function restoreReviewReaderPosition(pane: HTMLElement, saved: ReviewReaderPosition): boolean {
  if (!saved.interactionId) {
    pane.scrollTop = saved.scrollTop
    return true
  }
  const anchor = [...pane.querySelectorAll<HTMLElement>('.virtual-round-shell[data-interaction-id]')]
    .find(element => element.dataset.interactionId === saved.interactionId)
  if (!anchor) return false
  const paneTop = pane.getBoundingClientRect().top
  pane.scrollTop += anchor.getBoundingClientRect().top - paneTop - saved.offset
  return true
}

export function highLatencyThreshold(interactions: ReviewInteractionDto[]): number | null {
  const values = interactions.map(item => elapsed(item.startedAt, item.endedAt)).filter(value => value > 0).sort((a, b) => a - b)
  if (values.length < 2) return null
  const middle = Math.floor(values.length / 2)
  const median = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2
  const upperIndex = Math.min(values.length - 1, Math.floor((values.length - 1) * 0.75))
  const upperQuartile = values[upperIndex]!
  return Math.max(upperQuartile, median * 1.75)
}

