import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseInsightsQuery,
  parseReviewDetailQuery,
  parseReviewQuery,
  parseTimelineQuery,
  parseUsageQuery,
} from './query-params'

function params(value: string): URLSearchParams {
  return new URLSearchParams(value)
}

test('Review query exposes only the current protocol fields', () => {
  const query = parseReviewQuery(params(
    'cursor=next&sourceId=codex&projectId=p1&from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-02T00%3A00%3A00.000Z&status=with-errors&search=parser&limit=25&q=legacy&installationId=old&logicalSessionId=old-session',
  ))

  assert.deepEqual(query, {
    cursor: 'next',
    sourceId: 'codex',
    projectId: 'p1',
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-02T00:00:00.000Z',
    status: 'with-errors',
    search: 'parser',
    limit: 25,
  })
})

test('Review detail accepts only the formal direction and filters', () => {
  assert.deepEqual(
    parseReviewDetailQuery(params('ordinal=3&direction=backward&filter=latest&limit=1')),
    { ordinal: 3, direction: 'backward', filter: 'latest', limit: 1 },
  )

  assert.throws(() => parseReviewDetailQuery(params('direction=sideways')), /Unknown review detail direction/)
  assert.throws(() => parseReviewDetailQuery(params('filter=tools')), /Unknown review detail filter/)
  assert.throws(() => parseReviewDetailQuery(params('ordinal=0')), /ordinal must be a positive integer/)
})

test('Timeline validates kind, direction, range and limit at the HTTP boundary', () => {
  const query = parseTimelineQuery(params('kind=tool.call&direction=forward&limit=100'))
  assert.deepEqual(query, { kind: 'tool.call', direction: 'forward', limit: 100 })

  assert.throws(() => parseTimelineQuery(params('kind=not-real')), /Unknown timeline kind/)
  assert.throws(() => parseTimelineQuery(params('direction=sideways')), /Unknown timeline direction/)
  assert.throws(() => parseTimelineQuery(params('limit=0')), /Limit must be an integer between 1 and 1000/)
  assert.throws(
    () => parseTimelineQuery(params('from=2026-09-02T00%3A00%3A00.000Z&to=2026-09-01T00%3A00%3A00.000Z')),
    /Timeline from must be earlier than or equal to to/,
  )
})

test('Usage and Insights share strict timestamp ordering without sharing DTO fields', () => {
  assert.deepEqual(
    parseUsageQuery(params('installationId=i1&toolName=read_file&sourceId=codex&limit=50')),
    { installationId: 'i1', toolName: 'read_file', sourceId: 'codex', limit: 50 },
  )
  assert.deepEqual(
    parseInsightsQuery(params('logicalSessionId=s1&projectId=p1&sourceId=pi')),
    { logicalSessionId: 's1', projectId: 'p1', sourceId: 'pi' },
  )
  assert.throws(
    () => parseUsageQuery(params('from=bad-date')),
    /Invalid from timestamp/,
  )
  assert.throws(
    () => parseInsightsQuery(params('from=2026-09-03T00%3A00%3A00.000Z&to=2026-09-02T00%3A00%3A00.000Z')),
    /Insights from must be earlier than or equal to to/,
  )
})
