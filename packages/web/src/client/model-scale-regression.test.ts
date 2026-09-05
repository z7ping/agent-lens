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
import { AgentLensClientModel, type ClientSnapshot } from './model'

function summary(index: number): ReviewSessionSummaryDto {
  const at = new Date(Date.UTC(2026, 8, 1, 0, 0, index % 60)).toISOString()
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
    interactionCount: 1,
    toolCount: 0,
    errorCount: 0,
    hasErrors: false,
  }
}

function detail(id: string): ReviewSessionDetailDto {
  return {
    ...summary(1),
    id,
    interactions: [],
    page: { count: 0, hasMore: false, direction: 'backward', filter: 'all' },
  }
}

function page(total: number, offset: number, requestedLimit: number): ReviewResponseDto {
  const limit = Math.min(requestedLimit, 500)
  const end = Math.min(total, offset + limit)
  const items = Array.from({ length: end - offset }, (_, index) => summary(offset + index + 1))
  return {
    items,
    meta: {
      protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
      count: items.length,
      hasMore: end < total,
      ...(end < total ? { nextCursor: String(end) } : {}),
      generatedAt: '2026-09-05T00:00:00.000Z',
    },
  }
}

test('review 后台刷新会沿 cursor 补齐超过服务端 500 上限的已加载窗口', async () => {
  const calls: Array<{ limit: number; cursor?: string }> = []

  class CappedApi extends AgentLensApi {
    override review(_filters: ReviewFilters, limit = 40, cursor?: string): Promise<ReviewResponseDto> {
      calls.push({ limit, ...(cursor ? { cursor } : {}) })
      return Promise.resolve(page(700, cursor ? Number(cursor) : 0, limit))
    }
  }

  const model = new AgentLensClientModel(new CappedApi())
  const current = model.getSnapshot()
  ;(model as unknown as { snapshot: ClientSnapshot }).snapshot = {
    ...current,
    review: {
      ...current.review,
      response: page(700, 0, 650),
      selectedId: 'session-1',
      detail: detail('session-1'),
      limit: 650,
      loading: false,
    },
  }

  await model.refreshReview({ preserveDetail: true })

  assert.equal(model.getSnapshot().review.response?.items.length, 650)
  assert.equal(model.getSnapshot().review.limit, 650)
  assert.equal(model.getSnapshot().review.response?.meta.hasMore, true)
  assert.equal(model.getSnapshot().review.response?.meta.nextCursor, '650')
  assert.deepEqual(calls, [
    { limit: 650 },
    { limit: 150, cursor: '500' },
  ])
})

test('relationships 失败时仍发布 Review 正文并单独记录辅助错误', async () => {
  class RelationshipFailureApi extends AgentLensApi {
    override reviewDetail(id: string): Promise<ReviewSessionDetailDto> {
      return Promise.resolve(detail(id))
    }

    override relationships(): Promise<SessionRelationshipResponseDto> {
      return Promise.reject(new Error('关系索引暂不可用'))
    }
  }

  const model = new AgentLensClientModel(new RelationshipFailureApi())
  await model.selectReviewSession('session-42')

  const review = model.getSnapshot().review
  assert.equal(review.detail?.id, 'session-42')
  assert.equal(review.detailLoading, false)
  assert.equal(review.error, '')
  assert.equal(review.relationships, null)
  assert.equal(review.relationshipError, '关系索引暂不可用')
})
