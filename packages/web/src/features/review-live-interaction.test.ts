import { describe, expect, it } from 'vitest'
import type { LiveProductDto } from '@agent-lens/protocol'
import { projectReviewLiveInteraction } from './review-live-interaction'

function product(overrides: Partial<LiveProductDto> = {}): LiveProductDto {
  return {
    liveId: 'alpha-live',
    productId: 'alpha',
    displayName: 'Alpha',
    capabilities: ['resume', 'fork'],
    inputCapabilities: {
      text: 'native',
      largeText: 'native',
      image: 'unsupported',
      file: 'unsupported',
      multiline: 'native',
    },
    startCapabilities: { workspace: 'unsupported', title: 'optional' },
    availability: { available: true },
    runtimes: [],
    ...overrides,
  }
}

describe('projectReviewLiveInteraction', () => {
  it('matches by product id and returns advertised operations', () => {
    expect(projectReviewLiveInteraction({ productId: 'alpha' }, [product({ capabilities: ['resume'] })])).toEqual({
      liveId: 'alpha-live',
      displayName: 'Alpha',
      canResume: true,
      canFork: false,
    })
  })

  it('does not use source names and hides unavailable adapters', () => {
    expect(projectReviewLiveInteraction({ productId: 'alpha' }, [product({ availability: { available: false } })])).toBeNull()
    expect(projectReviewLiveInteraction({ productId: 'other' }, [product()])).toBeNull()
  })

  it('rejects ambiguous product mappings instead of guessing an adapter', () => {
    expect(projectReviewLiveInteraction({ productId: 'alpha' }, [
      product(),
      product({ liveId: 'alpha-live-2' }),
    ])).toBeNull()
  })
})
