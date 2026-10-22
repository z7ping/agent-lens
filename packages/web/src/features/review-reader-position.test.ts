import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldAutoFollowReviewTail } from './review-reader-position'

test('latest native Review session follows new records without requiring Live CLI', () => {
  assert.equal(shouldAutoFollowReviewTail({ page: {
    direction: 'backward', filter: 'all',
  } } as Parameters<typeof shouldAutoFollowReviewTail>[0]), true)
  assert.equal(shouldAutoFollowReviewTail({ page: {
    direction: 'forward', filter: 'all',
  } } as Parameters<typeof shouldAutoFollowReviewTail>[0]), false)
  assert.equal(shouldAutoFollowReviewTail({ page: {
    direction: 'backward', filter: 'errors',
  } } as Parameters<typeof shouldAutoFollowReviewTail>[0]), false)
  assert.equal(shouldAutoFollowReviewTail(null), false)
})
