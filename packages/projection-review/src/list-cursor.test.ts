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

test('review list cursor rejects removed endedAt and startedAt shapes', () => {
  for (const legacy of [
    JSON.stringify({ endedAt: '2026-08-19T09:00:00.000Z', logicalSessionId: 'session-ended' }),
    JSON.stringify({ startedAt: '2026-08-18T09:00:00.000Z', logicalSessionId: 'session-started' }),
  ]) {
    assert.throws(
      () => reviewProjectionInternals.decodeReviewListCursor(legacy),
      /Invalid review list cursor/,
    )
  }
})

test('review detail cursor rejects an unknown direction', () => {
  const invalid = JSON.stringify({
    mode: 'timeline',
    direction: 'sideways',
    timelineCursor: 'timeline-cursor',
    ordinal: 2,
  })
  assert.throws(
    () => reviewProjectionInternals.decodeReviewCursor(invalid),
    /Invalid review cursor/,
  )
})
