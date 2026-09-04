import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewProjectionInternals } from './projection'

test('review list cursor roundtrips recent activity time', () => {
  const encoded = reviewProjectionInternals.encodeReviewListCursor({
    activeAt: '2026-08-20T01:02:03.000Z',
    logicalSessionId: 'session-1',
  })
  assert.deepEqual(reviewProjectionInternals.decodeReviewListCursor(encoded), {
    activeAt: '2026-08-20T01:02:03.000Z',
    logicalSessionId: 'session-1',
  })
})

test('review list cursor accepts legacy endedAt and startedAt cursors during transition', () => {
  for (const legacy of [
    JSON.stringify({ endedAt: '2026-08-19T09:00:00.000Z', logicalSessionId: 'session-ended' }),
    JSON.stringify({ startedAt: '2026-08-18T09:00:00.000Z', logicalSessionId: 'session-started' }),
  ]) {
    const decoded = reviewProjectionInternals.decodeReviewListCursor(legacy)
    assert.ok(decoded.activeAt)
    assert.ok(decoded.logicalSessionId)
  }
})
