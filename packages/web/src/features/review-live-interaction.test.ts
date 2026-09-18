import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveProductDto } from '@agent-lens/protocol'
import { projectReviewLiveInteraction } from './review-live-interaction'

function liveProduct(overrides: Partial<LiveProductDto> = {}): LiveProductDto {
  return {
    liveId: 'pi',
    productId: 'pi',
    displayName: 'Pi Live',
    capabilities: ['resume', 'fork'],
    inputCapabilities: {
      text: 'native',
      largeText: 'transform',
      image: 'native',
      file: 'unsupported',
      multiline: 'native',
    },
    startCapabilities: {
      workspace: 'required',
      title: 'optional',
    },
    availability: { available: true },
    runtimes: [],
    ...overrides,
  }
}

test('history interaction capability is not erased by a transient Live availability failure', () => {
  const interaction = projectReviewLiveInteraction(
    { productId: 'pi' },
    [liveProduct({ availability: { available: false, reason: 'temporary probe failure' } })],
  )

  assert.deepEqual(interaction, {
    liveId: 'pi',
    displayName: 'Pi Live',
    canResume: true,
    canFork: true,
  })
})

test('history interaction still requires a matching product capability', () => {
  assert.equal(projectReviewLiveInteraction(
    { productId: 'pi' },
    [liveProduct({ productId: 'other' })],
  ), null)

  assert.equal(projectReviewLiveInteraction(
    { productId: 'pi' },
    [liveProduct({ capabilities: ['create'] })],
  ), null)
})
