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
  const at = new Date(Date.now() - index * 1_000).toISOString()
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

test('review 首屏一次读取 20 个会话并加载最新 10 个轮次', async () => {
  let releaseDetail!: (value: ReviewSessionDetailDto) => void
  const detailPending = new Promise<ReviewSessionDetailDto>(resolve => { releaseDetail = resolve })
  const reviewLimits: number[] = []
  const detailLimits: number[] = []

  class ProgressiveApi extends AgentLensApi {
    override review(_filters: ReviewFilters, limit = 40): Promise<ReviewResponseDto> {
      reviewLimits.push(limit)
      return Promise.resolve(response(limit))
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

  assert.equal(model.getSnapshot().review.response?.items.length, 20)
  assert.equal(model.getSnapshot().review.selectedId, 'session-1')
  assert.deepEqual(reviewLimits, [20])
  assert.deepEqual(detailLimits, [10])

  releaseDetail({
    ...summary(1),
    interactions: [],
    page: { count: 0, hasMore: true, nextCursor: 'older-rounds', direction: 'backward', filter: 'all' },
  })
  await refreshing

  assert.deepEqual(reviewLimits, [20])
  assert.equal(model.getSnapshot().review.response?.items.length, 20)
  assert.equal(model.getSnapshot().review.selectedId, 'session-1')
})

test('review 后台刷新保持已加载窗口且不重新进入首屏 loading', async () => {
  const reviewLimits: number[] = []

  class BackgroundRefreshApi extends AgentLensApi {
    override review(_filters: ReviewFilters, limit = 40): Promise<ReviewResponseDto> {
      reviewLimits.push(limit)
      return Promise.resolve(response(limit))
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

  assert.deepEqual(reviewLimits, [20, 20])
  assert.equal(model.getSnapshot().review.response?.items.length, 20)
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
      return Promise.resolve(response(limit))
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

  assert.equal(reviewCalls, 1)
  assert.equal(model.getSnapshot().review.detailHasNewData, true)
  model.stop()
})

test('session.updated 在摘要物化后只精准读取对应摘要', async () => {
  let reviewCalls = 0
  let summaryCalls = 0

  class SessionUpdatedApi extends AgentLensApi {
    override review(_filters: ReviewFilters, limit = 40): Promise<ReviewResponseDto> {
      reviewCalls += 1
      return Promise.resolve(response(limit))
    }

    override reviewSummary(id: string): Promise<ReviewSessionSummaryDto | null> {
      summaryCalls += 1
      return Promise.resolve({ ...summary(2), id, title: '会话 2 已更新' })
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

  const model = new AgentLensClientModel(new SessionUpdatedApi())
  await model.refreshReview()
  model.setReviewActive(true)

  ;(model as unknown as { onLiveEvent(event: LiveUpdateEventDto): void }).onLiveEvent({
    type: 'session.updated',
    logicalSessionId: 'session-2',
    affected: ['review', 'sessions'],
    emittedAt: '2026-09-01T00:00:01.000Z',
  })
  await new Promise(resolve => setTimeout(resolve, 180))

  assert.equal(reviewCalls, 1)
  assert.equal(summaryCalls, 1)
  assert.equal(model.getSnapshot().review.response?.items.find(item => item.id === 'session-2')?.title, '会话 2 已更新')
  model.stop()
})

test('session.updated 排序变化后先重新对齐分页，再按 cursor 加载且不重不漏', async () => {
  let reviewCalls = 0
  const cursors: Array<string | undefined> = []

  class PaginationPatchApi extends AgentLensApi {
    override review(_filters: ReviewFilters, limit = 40, cursor?: string): Promise<ReviewResponseDto> {
      reviewCalls += 1
      cursors.push(cursor)
      if (cursor) {
        return Promise.resolve({
          items: Array.from({ length: 20 }, (_, index) => summary(index + 21)),
          meta: {
            protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
            count: 20,
            hasMore: false,
            generatedAt: new Date().toISOString(),
          },
        })
      }
      const first = response(limit)
      return Promise.resolve({
        ...first,
        items: first.items.map(item => item.id === 'session-2'
          ? { ...item, title: reviewCalls > 1 ? '会话 2 已更新' : item.title }
          : item),
      })
    }

    override reviewSummary(id: string): Promise<ReviewSessionSummaryDto | null> {
      const newest = new Date(Date.now() + 60_000).toISOString()
      return Promise.resolve({ ...summary(2), id, title: '会话 2 已更新', startedAt: newest, endedAt: newest })
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
        meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: new Date().toISOString() },
      })
    }
  }

  const model = new AgentLensClientModel(new PaginationPatchApi())
  await model.refreshReview()
  model.setReviewActive(true)

  ;(model as unknown as { onLiveEvent(event: LiveUpdateEventDto): void }).onLiveEvent({
    type: 'session.updated',
    logicalSessionId: 'session-2',
    affected: ['review', 'sessions'],
    emittedAt: new Date().toISOString(),
  })
  await new Promise(resolve => setTimeout(resolve, 180))

  const patched = model.getSnapshot().review.response?.items ?? []
  assert.equal(patched[0]?.id, 'session-2')
  assert.equal(new Set(patched.map(item => item.id)).size, 20)

  await model.loadMoreReview()

  const loaded = model.getSnapshot().review.response?.items ?? []
  assert.equal(reviewCalls, 3)
  assert.deepEqual(cursors, [undefined, undefined, 'cursor-20'])
  assert.equal(loaded.length, 40)
  assert.equal(new Set(loaded.map(item => item.id)).size, 40)
  model.stop()
})

test('session.updated 的精准摘要更新不会被后续 Observation 兜底覆盖', async () => {
  let reviewCalls = 0

  class PrioritizedRefreshApi extends AgentLensApi {
    override review(_filters: ReviewFilters, limit = 40): Promise<ReviewResponseDto> {
      reviewCalls += 1
      return Promise.resolve(response(limit))
    }

    override reviewSummary(id: string): Promise<ReviewSessionSummaryDto | null> {
      return Promise.resolve({ ...summary(2), id })
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

  const model = new AgentLensClientModel(new PrioritizedRefreshApi())
  await model.refreshReview()
  model.setReviewActive(true)
  const emit = (event: LiveUpdateEventDto) =>
    (model as unknown as { onLiveEvent(event: LiveUpdateEventDto): void }).onLiveEvent(event)

  emit({
    type: 'session.updated',
    logicalSessionId: 'session-2',
    affected: ['review'],
    emittedAt: '2026-09-01T00:00:01.000Z',
  })
  emit({
    type: 'observation.committed',
    observationId: 'observation-after-summary',
    logicalSessionId: 'session-2',
    affected: ['review'],
    emittedAt: '2026-09-01T00:00:01.010Z',
  })

  await new Promise(resolve => setTimeout(resolve, 180))
  assert.equal(reviewCalls, 1)
  model.stop()
})

test('高频 Observation 与 Summary Ready 只合并为一次任务列表刷新', async () => {
  let reviewCalls = 0

  class BurstRefreshApi extends AgentLensApi {
    override review(_filters: ReviewFilters, limit = 40): Promise<ReviewResponseDto> {
      reviewCalls += 1
      return Promise.resolve(response(limit))
    }

    override reviewSummary(id: string): Promise<ReviewSessionSummaryDto | null> {
      return Promise.resolve({ ...summary(2), id })
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

  const model = new AgentLensClientModel(new BurstRefreshApi())
  await model.refreshReview()
  model.setReviewActive(true)
  const emit = (event: LiveUpdateEventDto) =>
    (model as unknown as { onLiveEvent(event: LiveUpdateEventDto): void }).onLiveEvent(event)

  for (let index = 0; index < 1_000; index += 1) {
    emit({
      type: 'observation.committed',
      observationId: `burst-${index}`,
      logicalSessionId: 'session-2',
      affected: ['review'],
      emittedAt: '2026-09-01T00:00:01.000Z',
    })
  }
  emit({
    type: 'session.updated',
    logicalSessionId: 'session-2',
    affected: ['review'],
    emittedAt: '2026-09-01T00:00:01.500Z',
  })

  await new Promise(resolve => setTimeout(resolve, 180))
  assert.equal(reviewCalls, 1)
  model.stop()
})

test('后台刷新不会把摘要窗口外的当前阅读会话切回第一条', async () => {
  let detailCalls = 0

  class OutsideWindowApi extends AgentLensApi {
    override review(_filters: ReviewFilters, limit = 40): Promise<ReviewResponseDto> {
      return Promise.resolve(response(limit))
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

test('默认最新页为空时 Web 不再二次 forward，尾页正确性由 Projection 保证', async () => {
  const directions: Array<'forward' | 'backward' | undefined> = []

  class SparseLatestApi extends AgentLensApi {
    override reviewDetail(_id: string, options: { direction?: 'forward' | 'backward' } = {}): Promise<ReviewSessionDetailDto> {
      directions.push(options.direction)
      return Promise.resolve(options.direction === 'forward'
        ? detailPage(1, 'forward', false)
        : {
            ...summary(1),
            interactions: [],
            interactionIndex: [{ ...interaction(1), hasError: false }],
            page: { count: 0, hasMore: false, direction: 'backward', filter: 'all' },
          })
    }

    override relationships(): Promise<SessionRelationshipResponseDto> {
      return Promise.resolve({ items: [], meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: '2026-09-01T00:00:00.000Z' } })
    }
  }

  const model = new AgentLensClientModel(new SparseLatestApi())
  await model.selectReviewSession('session-1')

  assert.deepEqual(directions, ['backward'])
  assert.equal(model.getSnapshot().review.detail?.interactions.length, 0)
  assert.equal(model.getSnapshot().review.detail?.page.direction, 'backward')
})


test('当前会话尾部增量只从最后 ordinal 开始并合并新增轮次', async () => {
  const tailQueries: Array<{ afterOrdinal?: number; cursor?: string }> = []

  class TailApi extends AgentLensApi {
    override reviewDetail(
      _id: string,
      options: { afterOrdinal?: number; cursor?: string; direction?: 'forward' | 'backward'; limit?: number } = {},
    ): Promise<ReviewSessionDetailDto> {
      if (options.afterOrdinal !== undefined || options.cursor) {
        tailQueries.push({ afterOrdinal: options.afterOrdinal, cursor: options.cursor })
        return Promise.resolve({
          ...summary(1),
          interactionCount: 12,
          interactions: [interaction(10), interaction(11), interaction(12)],
          page: { count: 3, hasMore: false, direction: 'forward', filter: 'all' },
        })
      }
      return Promise.resolve({
        ...summary(1),
        interactionCount: 10,
        interactions: Array.from({ length: 10 }, (_, index) => interaction(index + 1)),
        page: { count: 10, hasMore: true, nextCursor: 'older', direction: 'backward', filter: 'all' },
      })
    }

    override relationships(): Promise<SessionRelationshipResponseDto> {
      return Promise.resolve({
        items: [],
        meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: '2026-09-01T00:00:00.000Z' },
      })
    }
  }

  const model = new AgentLensClientModel(new TailApi())
  await model.selectReviewSession('session-1')
  ;(model.getSnapshot().review as { detailHasNewData: boolean }).detailHasNewData = true
  await model.refreshReviewTailIncremental()

  assert.deepEqual(tailQueries, [{ afterOrdinal: 10, cursor: undefined }])
  assert.deepEqual(model.getSnapshot().review.detail?.interactions.map(item => item.ordinal), [1,2,3,4,5,6,7,8,9,10,11,12])
  assert.equal(model.getSnapshot().review.detailHasNewData, false)
  model.stop()
})
