import assert from 'node:assert/strict'
import test from 'node:test'
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

test('matches by product id and returns advertised operations', () => {
  assert.deepEqual(
    projectReviewLiveInteraction({ productId: 'alpha' }, [product({ capabilities: ['resume'] })]),
    {
      liveId: 'alpha-live',
      displayName: 'Alpha',
      canResume: true,
      canFork: false,
    },
  )
})

test('history capabilities are not gated on transient adapter availability', () => {
  assert.deepEqual(
    projectReviewLiveInteraction(
      { productId: 'alpha' },
      [product({ availability: { available: false, reason: 'temporary probe failure' } })],
    ),
    {
      liveId: 'alpha-live',
      displayName: 'Alpha',
      canResume: true,
      canFork: true,
    },
  )
  assert.equal(projectReviewLiveInteraction({ productId: 'other' }, [product()]), null)
})

test('ambiguous product mappings are rejected instead of guessing an adapter', () => {
  assert.equal(
    projectReviewLiveInteraction({ productId: 'alpha' }, [
      product(),
      product({ liveId: 'alpha-live-2' }),
    ]),
    null,
  )
})
