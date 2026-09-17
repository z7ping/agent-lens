import type { LiveProductDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'

export interface ReviewLiveInteraction {
  liveId: string
  displayName: string
  canResume: boolean
  canFork: boolean
}

/**
 * Review interaction availability is a Product projection: historical facts
 * identify their product, while the active Live adapter advertises operations.
 * Source ids never decide whether a control is shown.
 */
export function projectReviewLiveInteraction(
  session: Pick<ReviewSessionSummaryDto, 'productId'> | null | undefined,
  products: readonly LiveProductDto[],
): ReviewLiveInteraction | null {
  if (!session?.productId) return null
  const candidates = products.filter(product =>
    product.productId === session.productId
    && product.availability.available
    && (product.capabilities.includes('resume') || product.capabilities.includes('fork')),
  )
  if (candidates.length !== 1) return null
  const product = candidates[0]!
  return {
    liveId: product.liveId,
    displayName: product.displayName,
    canResume: product.capabilities.includes('resume'),
    canFork: product.capabilities.includes('fork'),
  }
}
