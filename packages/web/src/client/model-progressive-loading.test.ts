import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type ReviewResponseDto,
  type ReviewSessionDetailDto,
  type ReviewSessionSummaryDto,
  type SessionRelationshipResponseDto,
} from '@agent-lens/protocol'
import { AgentLensApi, type ReviewFilters } from './api'
import { AgentLensClientModel } from './model'

function summary(index: number): ReviewSessionSummaryDto {
  const at = new Date(Date.UTC(2026, 8, 1, 0, 0, 10 - index)).toISOString()
  return {
    id: `session-${index}`,
    installationId: 'installation-1',
    productId: 'codex',
    sourceIds: ['codex'],
    title: `会话 ${index}`,
    startedAt: at,
    endedAt: at,
    durationMs: 0,
    observationCount: 1,
    interactionCount: 12,
    toolCount: 0,
    errorCount: 0,
    hasErrors: false,
  }
}

function response(count: number): ReviewResponseDto {
  return {
    items: Array.from({ length: count }, (_, index) => summary(index + 1)),
    meta: {
      protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
      count,
      hasMore: true,
      nextCursor: `cursor-${count}`,
      generatedAt: '2026-09-01T00:00:00.000Z',
    },
  }
}

test('review 首屏先展示 1 个会话和最新 3 个轮次，再补载到 10 个会话', async () => {
  let releaseDetail!: (value: ReviewSessionDetailDto) => void
  const detailPending = new Promise<ReviewSessionDetailDto>(resolve => { releaseDetail = resolve })
  const reviewLimits: number[] = []
  const detailLimits: number[] = []

  class ProgressiveApi extends AgentLensApi {
    override review(_filters: ReviewFilters, limit = 40): Promise<ReviewResponseDto> {
      reviewLimits.push(limit)
      return Promise.resolve(response(limit === 1 ? 1 : 10))
    }

    override reviewDetail(_id: string, options: { limit?: number } = {}): Promise<ReviewSessionDetailDto> {
      detailLimits.push(options.limit ?? 0)
      return detailPending
    }

    override relationships(): Promise<SessionRelationshipResponseDto> {
      return Promise.resolve({
        items: [],
        meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: '2026-09-01T00:00:00.000Z' },
      })
    }
  }

  const model = new AgentLensClientModel(new ProgressiveApi())
  const refreshing = model.refreshReview()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(model.getSnapshot().review.response?.items.length, 1)
  assert.equal(model.getSnapshot().review.selectedId, 'session-1')
  assert.deepEqual(reviewLimits, [1])
  assert.deepEqual(detailLimits, [3])

  releaseDetail({
    ...summary(1),
    interactions: [],
    page: { count: 0, hasMore: true, nextCursor: 'older-rounds', direction: 'backward', filter: 'all' },
  })
  await refreshing

  assert.deepEqual(reviewLimits, [1, 10])
  assert.equal(model.getSnapshot().review.response?.items.length, 10)
  assert.equal(model.getSnapshot().review.selectedId, 'session-1')
})
