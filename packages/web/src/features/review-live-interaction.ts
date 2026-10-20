import type { LiveProductDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'

export interface ReviewLiveInteraction {
  liveId: string
  displayName: string
  canResume: boolean
  canSend: boolean
  canFork: boolean
  canForkAt: boolean
}

/**
 * Historical facts identify their Product while the Live adapter advertises
 * operations. Capability presence decides whether resume/fork exists; a
 * transient availability probe must not erase an operation the adapter owns.
 * Source ids never decide whether a control is shown.
 */
export function projectReviewLiveInteraction(
  session: Pick<ReviewSessionSummaryDto, 'productId'> | null | undefined,
  products: readonly Pick<LiveProductDto, 'liveId' | 'productId' | 'displayName' | 'capabilities'>[],
): ReviewLiveInteraction | null {
  if (!session?.productId) return null
  const candidates = products.filter(product =>
    product.productId === session.productId
    && (product.capabilities.includes('resume') || product.capabilities.includes('fork') || product.capabilities.includes('fork-at')),
  )
  if (candidates.length !== 1) return null
  const product = candidates[0]!
  return {
    liveId: product.liveId,
    displayName: product.displayName,
    canResume: product.capabilities.includes('resume'),
    canSend: product.capabilities.includes('send'),
    canFork: product.capabilities.includes('fork'),
    canForkAt: product.capabilities.includes('fork-at'),
  }
}
