import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type LiveUpdateEventDto,
  type ReviewInteractionDto,
  type ReviewResponseDto,
  type ReviewSessionDetailDto,
  type ReviewSessionSummaryDto,
  type SessionRelationshipResponseDto,
} from '@agent-lens/protocol'
import { AgentLensApi, type ReviewFilters } from './api'
import { AgentLensClientModel, REVIEW_DETAIL_WINDOW_SIZE } from './model'

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

function interaction(ordinal: number): ReviewInteractionDto {
  const at = new Date(Date.UTC(2026, 8, 1, 0, ordinal)).toISOString()
  return { id: `interaction-${ordinal}`, ordinal, trigger: 'user', startedAt: at, endedAt: at, nodes: [] }
}

function detailPage(start: number, direction: 'forward' | 'backward', hasMore = true): ReviewSessionDetailDto {
  const ordinals = Array.from({ length: 10 }, (_, index) => start + index)
  return {
    ...summary(1),
    interactionCount: 80,
    interactions: ordinals.map(interaction),
    interactionIndex: Array.from({ length: 80 }, (_, index) => {
      const item = interaction(index + 1)
      return { ...item, hasError: false }
    }),
    page: { count: 10, hasMore, ...(hasMore ? { nextCursor: `cursor-${start}` } : {}), direction, filter: 'all' },
  }
}

test('review 首屏先展示 1 个会话和最新 10 个轮次，再补载到 10 个会话', async () => {
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
  assert.deepEqual(detailLimits, [10])

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

test('review 后台刷新保持已加载窗口且不重新进入首屏 loading', async () => {
  const reviewLimits: number[] = []

  class BackgroundRefreshApi extends AgentLensApi {
    override review(_filters: ReviewFilters, limit = 40): Promise<ReviewResponseDto> {
      reviewLimits.push(limit)
      return Promise.resolve(response(limit === 1 ? 1 : 10))
    }

    override reviewDetail(): Promise<ReviewSessionDetailDto> {
      return Promise.resolve({
        ...summary(1),
        interactions: [],
        page: { count: 0, hasMore: false, direction: 'backward', filter: 'all' },
      })
    }

    override relationships(): Promise<SessionRelationshipResponseDto> {
      return Promise.resolve({
        items: [],
        meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: '2026-09-01T00:00:00.000Z' },
      })
    }
  }

  const model = new AgentLensClientModel(new BackgroundRefreshApi())
  await model.refreshReview()
  const loadingStates: boolean[] = []
  const unsubscribe = model.subscribe(() => loadingStates.push(model.getSnapshot().review.loading))

  await model.refreshReview({ preserveDetail: true })
  await Promise.resolve()
  unsubscribe()

  assert.deepEqual(reviewLimits, [1, 10, 10])
  assert.equal(model.getSnapshot().review.response?.items.length, 10)
  assert.equal(model.getSnapshot().review.loading, false)
  assert.equal(loadingStates.includes(true), false)
})

test('review 连续补载时正文窗口保持固定上限，完整轻量索引不被截断', async () => {
  let page = 0
  class WindowedApi extends AgentLensApi {
    override review(): Promise<ReviewResponseDto> { return Promise.resolve(response(1)) }
    override reviewDetail(): Promise<ReviewSessionDetailDto> {
      const result = detailPage(1 + page * 10, 'forward', page < 5)
      page += 1
      return Promise.resolve(result)
    }
    override relationships(): Promise<SessionRelationshipResponseDto> {
      return Promise.resolve({ items: [], meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: '2026-09-01T00:00:00.000Z' } })
    }
  }

  const model = new AgentLensClientModel(new WindowedApi())
  await model.refreshReview()
  for (let index = 0; index < 4; index += 1) await model.loadMoreReviewDetail()

  const detail = model.getSnapshot().review.detail
  assert.ok(detail)
  assert.equal(detail.interactions.length, REVIEW_DETAIL_WINDOW_SIZE)
  assert.deepEqual(detail.interactions.map(item => item.ordinal), Array.from({ length: 30 }, (_, index) => index + 21))
  assert.equal(detail.interactionIndex?.length, 80)
})

test('正在阅读的会话持续写入时只提示新记录，不刷新任务列表', async () => {
  let reviewCalls = 0

  class LiveSelectedSessionApi extends AgentLensApi {
    override review(_filters: ReviewFilters, limit = 40): Promise<ReviewResponseDto> {
      reviewCalls += 1
      return Promise.resolve(response(limit === 1 ? 1 : 10))
    }

    override reviewDetail(): Promise<ReviewSessionDetailDto> {
      return Promise.resolve({
        ...summary(1),
        interactions: [],
        page: { count: 0, hasMore: false, direction: 'backward', filter: 'all' },
      })
    }

    override relationships(): Promise<SessionRelationshipResponseDto> {
      return Promise.resolve({
        items: [],
        meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: '2026-09-01T00:00:00.000Z' },
      })
    }
  }

  const model = new AgentLensClientModel(new LiveSelectedSessionApi())
  await model.refreshReview()
  model.setReviewActive(true)
  const event: LiveUpdateEventDto = {
    type: 'observation.committed',
    observationId: 'observation-1',
    logicalSessionId: 'session-1',
    affected: ['review'],
    emittedAt: '2026-09-01T00:00:01.000Z',
  }

  ;(model as unknown as { onLiveEvent(event: LiveUpdateEventDto): void }).onLiveEvent(event)
  await new Promise(resolve => setTimeout(resolve, 900))

  assert.equal(reviewCalls, 2)
  assert.equal(model.getSnapshot().review.detailHasNewData, true)
  model.stop()
})

test('后台刷新不会把摘要窗口外的当前阅读会话切回第一条', async () => {
  let detailCalls = 0

  class OutsideWindowApi extends AgentLensApi {
    override review(_filters: ReviewFilters, limit = 40): Promise<ReviewResponseDto> {
      return Promise.resolve(response(limit === 1 ? 1 : 10))
    }

    override reviewDetail(id: string): Promise<ReviewSessionDetailDto> {
      detailCalls += 1
      return Promise.resolve({
        ...summary(id === 'outside-window' ? 99 : 1),
        id,
        interactions: [],
        page: { count: 0, hasMore: false, direction: 'backward', filter: 'all' },
      })
    }

    override relationships(): Promise<SessionRelationshipResponseDto> {
      return Promise.resolve({
        items: [],
        meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: '2026-09-01T00:00:00.000Z' },
      })
    }
  }

  const model = new AgentLensClientModel(new OutsideWindowApi())
  await model.refreshReview()
  await model.selectReviewSession('outside-window')
  const callsBeforeRefresh = detailCalls

  await model.refreshReview({ preserveDetail: true })

  assert.equal(model.getSnapshot().review.selectedId, 'outside-window')
  assert.equal(model.getSnapshot().review.detail?.id, 'outside-window')
  assert.equal(detailCalls, callsBeforeRefresh)
})

test('默认最新页为空但轻量索引仍有记录时自动从头加载', async () => {
  const directions: Array<'forward' | 'backward' | undefined> = []

  class SparseLatestApi extends AgentLensApi {
    override reviewDetail(_id: string, options: { direction?: 'forward' | 'backward' } = {}): Promise<ReviewSessionDetailDto> {
      directions.push(options.direction)
      return Promise.resolve(options.direction === 'forward'
        ? detailPage(1, 'forward', false)
        : {
            ...summary(1),
            interactions: [],
            interactionIndex: [interaction(1)],
            page: { count: 0, hasMore: false, direction: 'backward', filter: 'all' },
          })
    }

    override relationships(): Promise<SessionRelationshipResponseDto> {
      return Promise.resolve({ items: [], meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: '2026-09-01T00:00:00.000Z' } })
    }
  }

  const model = new AgentLensClientModel(new SparseLatestApi())
  await model.selectReviewSession('session-1')

  assert.deepEqual(directions, ['backward', 'forward'])
  assert.equal(model.getSnapshot().review.detail?.interactions.length, 10)
  assert.equal(model.getSnapshot().review.detail?.page.direction, 'forward')
})
