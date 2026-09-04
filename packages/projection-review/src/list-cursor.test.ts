import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewProjectionInternals } from './projection'

test('review list cursor roundtrips startedAt', () => {
  const encoded = reviewProjectionInternals.encodeReviewListCursor({
    startedAt: '2026-08-20T01:02:03.000Z',
    logicalSessionId: 'session-1',
  })
  assert.deepEqual(reviewProjectionInternals.decodeReviewListCursor(encoded), {
    startedAt: '2026-08-20T01:02:03.000Z',
    logicalSessionId: 'session-1',
  })
})

test('review list cursor accepts legacy endedAt cursors during transition', () => {
  const legacy = JSON.stringify({
    endedAt: '2026-08-19T09:00:00.000Z',
    logicalSessionId: 'session-legacy',
  })
  assert.deepEqual(reviewProjectionInternals.decodeReviewListCursor(legacy), {
    startedAt: '2026-08-19T09:00:00.000Z',
    logicalSessionId: 'session-legacy',
  })
})
