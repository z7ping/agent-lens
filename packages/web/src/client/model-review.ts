import type { LiveUpdateArea, LiveUpdateEventDto, ReviewDetailFilter, ReviewResponseDto, ReviewSessionDetailDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'
import { type QueryFilters, type ReviewFilters } from './api'
import { AgentLensIntegrationModel } from './model-integration'
import { INITIAL_REVIEW_LIMIT } from './model-base'

const REVIEW_PAGE_SIZE = 20
const REVIEW_DETAIL_PAGE_SIZE = 10
export const REVIEW_DETAIL_WINDOW_SIZE = 30
const REVIEW_SEARCH_DEBOUNCE_MS = 250
function mergeReviewDetail(current: ReviewSessionDetailDto, next: ReviewSessionDetailDto): ReviewSessionDetailDto {
  const interactions = new Map(current.interactions.map(item => [item.id, item]))
  for (const interaction of next.interactions) interactions.set(interaction.id, interaction)
  const ordered = [...interactions.values()].sort((a, b) => a.ordinal - b.ordinal)
  const windowed = ordered.length <= REVIEW_DETAIL_WINDOW_SIZE
    ? ordered
    : next.page.direction === 'backward'
      ? ordered.slice(0, REVIEW_DETAIL_WINDOW_SIZE)
      : ordered.slice(-REVIEW_DETAIL_WINDOW_SIZE)
  return {
    ...current,
    interactions: windowed,
    page: next.page,
  }
}

function mergeReviewTail(current: ReviewSessionDetailDto, next: ReviewSessionDetailDto): ReviewSessionDetailDto {
  const interactions = new Map(current.interactions.map(item => [item.id, item]))
  for (const interaction of next.interactions) interactions.set(interaction.id, interaction)
  const ordered = [...interactions.values()].sort((a, b) => a.ordinal - b.ordinal)
  return {
    ...current,
    ...next,
    interactions: ordered.slice(-REVIEW_DETAIL_WINDOW_SIZE),
    page: current.page,
  }
}

function reviewSummaryMatchesFilters(item: ReviewSessionSummaryDto, filters: ReviewFilters): boolean {
  if (item.sessionActivity === 'system-activity') return false
  if (filters.sourceIds !== null && !item.sourceIds.some(sourceId => filters.sourceIds!.includes(sourceId))) return false
  if (filters.projectId && item.projectId !== filters.projectId) return false
  if (filters.status === 'with-errors' && !item.hasErrors) return false
  if (filters.status === 'clean' && item.hasErrors) return false

  const endedAt = Date.parse(item.endedAt)
  if (filters.range !== 'all' && Number.isFinite(endedAt)) {
    const now = new Date()
    if (filters.range === 'today') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      if (endedAt < start) return false
    } else {
      const days = filters.range === '7d' ? 7 : 30
      if (endedAt < now.getTime() - days * 86_400_000) return false
    }
  }

  const search = filters.search.trim().toLowerCase()
  if (search) {
    const haystack = [
      item.title,
      item.preview,
      item.projectName,
      item.workspacePath,
      ...item.sourceIds,
    ].filter(Boolean).join('\n').toLowerCase()
    if (!haystack.includes(search)) return false
  }
  return true
}

function sortReviewSummaries(items: ReviewSessionSummaryDto[]): ReviewSessionSummaryDto[] {
  return items.sort((left, right) =>
    right.endedAt.localeCompare(left.endedAt) || left.id.localeCompare(right.id)
  )
}

export abstract class AgentLensReviewModel extends AgentLensIntegrationModel {
  setReviewActive(active: boolean): void {
    this.reviewActive = active
    if (!active) {
      if (this.refreshTimer) clearTimeout(this.refreshTimer)
      this.refreshTimer = null
      this.reviewRefreshDueAt = null
      return
    }
    if (this.reviewLiveDirty) this.scheduleReviewRefresh(0)
  }

  protected scheduleReviewRefresh(delay?: number): void {
    this.reviewLiveDirty = true
    if (!this.reviewActive) return
    if (typeof document !== 'undefined' && document.hidden) return
    const wait = delay ?? 800
    const dueAt = Date.now() + wait
    // Never let a slower fallback postpone an already scheduled summary-ready refresh.
    if (this.refreshTimer && this.reviewRefreshDueAt !== null && this.reviewRefreshDueAt <= dueAt) return
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.reviewRefreshDueAt = dueAt
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.reviewRefreshDueAt = null
      if (!this.reviewActive || !this.reviewLiveDirty) return
      this.reviewLiveDirty = false
      void this.refreshReview({ preserveDetail: true })
    }, wait)
  }

  protected scheduleReviewSummaryPatch(logicalSessionId: string): void {
    if (!logicalSessionId) {
      this.scheduleReviewRefresh(0)
      return
    }
    this.pendingReviewSummaryIds.add(logicalSessionId)
    if (!this.reviewActive || !this.snapshot.review.response) {
      this.reviewLiveDirty = true
      return
    }
    if (this.pendingReviewSummaryIds.size > INITIAL_REVIEW_LIMIT) {
      this.pendingReviewSummaryIds.clear()
      this.scheduleReviewRefresh(0)
      return
    }
    if (this.reviewSummaryPatchTimer) return
    this.reviewSummaryPatchTimer = setTimeout(() => {
      this.reviewSummaryPatchTimer = null
      void this.flushReviewSummaryPatches()
    }, 100)
  }

  protected async flushReviewSummaryPatches(): Promise<void> {
    if (!this.reviewActive || !this.snapshot.review.response) {
      this.reviewLiveDirty = true
      return
    }
    if (typeof document !== 'undefined' && document.hidden) {
      this.reviewLiveDirty = true
      return
    }

    const ids = [...this.pendingReviewSummaryIds]
    this.pendingReviewSummaryIds.clear()
    if (!ids.length) return
    const filters = this.snapshot.review.filters
    const results = await Promise.allSettled(ids.map(id => this.api.reviewSummary(id)))
    if (results.some(result => result.status === 'rejected')) {
      this.scheduleReviewRefresh(0)
      return
    }

    const latest = this.snapshot.review
    if (!latest.response) return
    const items = new Map(latest.response.items.map(item => [item.id, item]))
    // 单条摘要可用于已加载会话的更新，但不具备列表的身份去重与可见性语义。
    // 未加载的 ID 必须由列表查询确认，避免历史安装副本经实时补丁重新插入。
    if (results.some((result, index) => result.status === 'fulfilled'
      && result.value && !items.has(ids[index]!)
      && reviewSummaryMatchesFilters(result.value, filters))) {
      this.scheduleReviewRefresh(0)
      return
    }
    let changed = false
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index]!
      const result = results[index]!
      const summary = result.status === 'fulfilled' ? result.value : null
      const existed = items.has(id)
      const visible = summary ? reviewSummaryMatchesFilters(summary, filters) : false
      if (summary && visible) {
        items.set(id, summary)
        changed = true
      } else if (existed) {
        items.delete(id)
        changed = true
      }
    }
    if (!changed) return

    const currentLimit = Math.max(INITIAL_REVIEW_LIMIT, latest.limit, latest.response.items.length)
    const merged = sortReviewSummaries([...items.values()]).slice(0, currentLimit)
    this.reviewPaginationDirty = true
    this.publish({
      ...this.snapshot,
      review: {
        ...latest,
        response: {
          ...latest.response,
          items: merged,
          meta: { ...latest.response.meta, count: merged.length, generatedAt: new Date().toISOString() },
        },
        limit: merged.length,
      },
    })
  }

  setReviewFilters(patch: Partial<ReviewFilters>): void {
    const filters = { ...this.snapshot.review.filters, ...patch }
    const keys = Object.keys(patch)
    const searchOnly = keys.length === 1 && keys[0] === 'search'
    this.publish({
      ...this.snapshot,
      review: { ...this.snapshot.review, filters, limit: INITIAL_REVIEW_LIMIT },
    })
    if (this.reviewSearchTimer) {
      clearTimeout(this.reviewSearchTimer)
      this.reviewSearchTimer = null
    }
    if (searchOnly) {
      this.reviewSearchTimer = setTimeout(() => {
        this.reviewSearchTimer = null
        void this.refreshReview()
      }, REVIEW_SEARCH_DEBOUNCE_MS)
      return
    }
    void this.refreshReview()
  }

  setUsageFilters(patch: Partial<QueryFilters>): void {
    const filters = { ...this.snapshot.usage.filters, ...patch }
    this.publish({
      ...this.snapshot,
      usage: { ...this.snapshot.usage, filters },
    })
    void this.refreshUsage()
  }

  async loadMoreReview(): Promise<void> {
    if (this.reviewPaginationDirty) {
      await this.refreshReview({ preserveDetail: true })
      if (this.reviewPaginationDirty) return
    }
    const current = this.snapshot.review
    const cursor = current.response?.meta.nextCursor
    if (current.loading || current.loadingMore || !current.response?.meta.hasMore || !cursor) return
    const generation = ++this.reviewGeneration
    this.publish({
      ...this.snapshot,
      review: { ...current, loadingMore: true, error: '' },
    })
    try {
      const next = await this.api.review(current.filters, REVIEW_PAGE_SIZE, cursor)
      if (generation !== this.reviewGeneration) return
      const latest = this.snapshot.review
      const items = new Map(latest.response?.items.map(item => [item.id, item]) ?? [])
      for (const item of next.items) items.set(item.id, item)
      const merged = [...items.values()]
      this.publish({
        ...this.snapshot,
        review: {
          ...latest,
          response: { ...next, items: merged, meta: { ...next.meta, count: merged.length } },
          limit: merged.length,
          loadingMore: false,
          error: '',
        },
      })
    } catch (error) {
      if (generation !== this.reviewGeneration) return
      this.publish({
        ...this.snapshot,
        review: { ...this.snapshot.review, loadingMore: false, error: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  async loadMoreReviewDetail(): Promise<void> {
    const current = this.snapshot.review
    const detail = current.detail
    if (!detail?.page.hasMore || !detail.page.nextCursor || current.detailLoading || current.detailLoadingMore) return
    const selectedId = current.selectedId
    const generation = this.detailGeneration
    this.publish({
      ...this.snapshot,
      review: { ...current, detailLoadingMore: true, error: '' },
    })
    try {
      const next = await this.api.reviewDetail(selectedId, {
        cursor: detail.page.nextCursor,
        limit: REVIEW_DETAIL_PAGE_SIZE,
        direction: detail.page.direction,
        filter: detail.page.filter,
        process: 'summary',
      })
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== selectedId) return
      const latest = this.snapshot.review
      if (!latest.detail) return
      this.publish({
        ...this.snapshot,
        review: {
          ...latest,
          detail: mergeReviewDetail(latest.detail, next),
          detailLoadingMore: false,
          error: '',
        },
      })
    } catch (error) {
      if (generation !== this.detailGeneration) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          detailLoadingMore: false,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  async selectReviewDetailFilter(filter: Exclude<ReviewDetailFilter, 'all'>): Promise<void> {
    const current = this.snapshot.review
    if (!current.selectedId) return
    const selectedId = current.selectedId
    const generation = ++this.detailGeneration
    this.publish({
      ...this.snapshot,
      review: { ...current, detailLoading: true, detailLoadingMore: false, error: '' },
    })
    try {
      const detail = await this.api.reviewDetail(selectedId, { filter, limit: REVIEW_DETAIL_PAGE_SIZE, process: 'summary' })
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== selectedId) return
      this.publish({
        ...this.snapshot,
        review: { ...this.snapshot.review, detail, detailLoading: false, detailHasNewData: false, error: '' },
      })
    } catch (error) {
      if (generation !== this.detailGeneration) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          detailLoading: false,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  async jumpToLatestReviewDetail(): Promise<void> {
    const current = this.snapshot.review
    if (!current.selectedId) return
    const selectedId = current.selectedId
    const generation = ++this.detailGeneration
    this.publish({
      ...this.snapshot,
      review: { ...current, detailLoading: true, detailLoadingMore: false, error: '' },
    })
    try {
      const detail = await this.api.reviewDetail(selectedId, { direction: 'backward', limit: REVIEW_DETAIL_PAGE_SIZE, process: 'summary' })
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== selectedId) return
      this.publish({
        ...this.snapshot,
        review: { ...this.snapshot.review, detail, detailLoading: false, detailHasNewData: false, error: '' },
      })
    } catch (error) {
      if (generation !== this.detailGeneration) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          detailLoading: false,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  async showReviewFromStart(): Promise<void> {
    const current = this.snapshot.review
    if (!current.selectedId) return
    const selectedId = current.selectedId
    const generation = ++this.detailGeneration
    this.publish({
      ...this.snapshot,
      review: { ...current, detailLoading: true, detailLoadingMore: false, error: '' },
    })
    try {
      const detail = await this.api.reviewDetail(selectedId, { direction: 'forward', limit: REVIEW_DETAIL_PAGE_SIZE, process: 'summary' })
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== selectedId) return
      this.publish({
        ...this.snapshot,
        review: { ...this.snapshot.review, detail, detailLoading: false, detailHasNewData: false, error: '' },
      })
    } catch (error) {
      if (generation !== this.detailGeneration) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          detailLoading: false,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  async jumpToReviewInteraction(ordinal: number): Promise<void> {
    const current = this.snapshot.review
    if (!current.selectedId || ordinal < 1) return
    if (current.detail?.interactions.some(item => item.ordinal === ordinal)) return
    const selectedId = current.selectedId
    const generation = ++this.detailGeneration
    this.publish({ ...this.snapshot, review: { ...current, detailLoading: true, detailLoadingMore: false, error: '' } })
    try {
      const detail = await this.api.reviewDetail(selectedId, { ordinal, process: 'summary' })
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== selectedId) return
      this.publish({ ...this.snapshot, review: { ...this.snapshot.review, detail, detailLoading: false, error: '' } })
    } catch (error) {
      if (generation !== this.detailGeneration) return
      this.publish({ ...this.snapshot, review: { ...this.snapshot.review, detailLoading: false, error: error instanceof Error ? error.message : String(error) } })
    }
  }

  acknowledgeReviewNewData(): void {
    const current = this.snapshot.review
    if (!current.detailHasNewData) return
    this.publish({
      ...this.snapshot,
      review: { ...current, detailHasNewData: false },
    })
  }

  async refreshReview(options: { preserveDetail?: boolean } = {}): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.reviewRefreshDueAt = null
    this.reviewLiveDirty = false
    if (this.reviewInFlight) {
      this.reviewRequestDirty = true
      // 同一条件的新数据刷新保留首个可用结果；筛选切换才使旧响应失效。
      if (this.reviewRequestFilterKey !== JSON.stringify(this.snapshot.review.filters)) {
        this.reviewGeneration += 1
      }
      return this.reviewInFlight
    }

    let preserveDetail = options.preserveDetail === true
    const run = async () => {
      do {
        this.reviewRequestDirty = false
        this.reviewRequestFilterKey = JSON.stringify(this.snapshot.review.filters)
        const generation = ++this.reviewGeneration
        await this.executeReviewRefresh(generation, preserveDetail)
        preserveDetail = true
      } while (this.reviewRequestDirty)
    }
    const pending = run().finally(() => {
      if (this.reviewInFlight === pending) this.reviewInFlight = null
    })
    this.reviewInFlight = pending
    return pending
  }

  protected async fetchReviewWindow(filters: ReviewFilters, targetLimit: number): Promise<ReviewResponseDto> {
    let page = await this.api.review(filters, targetLimit)
    if (page.items.length >= targetLimit || !page.meta.hasMore || !page.meta.nextCursor) return page

    const items = new Map(page.items.map(item => [item.id, item]))
    let cursor: string | undefined = page.meta.nextCursor
    while (items.size < targetLimit && page.meta.hasMore && cursor) {
      const previousCursor = cursor
      const remaining = targetLimit - items.size
      page = await this.api.review(filters, remaining, cursor)
      const before = items.size
      for (const item of page.items) items.set(item.id, item)
      cursor = page.meta.nextCursor
      if (items.size === before && (!cursor || cursor === previousCursor)) break
    }

    const merged = [...items.values()].slice(0, targetLimit)
    return {
      ...page,
      items: merged,
      meta: { ...page.meta, count: merged.length },
    }
  }

  protected async executeReviewRefresh(generation: number, preserveDetail: boolean): Promise<void> {
    const current = this.snapshot.review
    const backgroundRefresh = preserveDetail && current.response !== null
    if (!backgroundRefresh) {
      this.publish({
        ...this.snapshot,
        review: { ...current, loading: true, loadingMore: false, error: '' },
      })
    }
    try {
      const refreshLimit = backgroundRefresh
        ? Math.max(INITIAL_REVIEW_LIMIT, current.limit, current.response?.items.length ?? 0)
        : INITIAL_REVIEW_LIMIT
      const response = backgroundRefresh
        ? await this.fetchReviewWindow(current.filters, refreshLimit)
        : await this.api.review(current.filters, refreshLimit)
      if (generation !== this.reviewGeneration) return
      let selectedId = this.snapshot.review.selectedId
      if (!selectedId || (!preserveDetail && !response.items.some(item => item.id === selectedId))) {
        selectedId = response.items[0]?.id ?? ''
      }
      this.reviewPaginationDirty = false
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          response,
          selectedId,
          limit: response.items.length,
          loading: false,
          loadingMore: false,
          error: '',
        },
      })
      if (selectedId && (!preserveDetail || this.snapshot.review.detail?.id !== selectedId)) {
        await this.selectReviewSession(selectedId)
      } else if (!selectedId) {
        this.publish({
          ...this.snapshot,
          review: { ...this.snapshot.review, detail: null, relationships: null, relationshipError: '' },
        })
      }
    } catch (error) {
      if (generation !== this.reviewGeneration) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          loading: false,
          loadingMore: false,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  protected async refreshReviewFileChanges(
    id: string,
    generation = this.detailGeneration,
    loading = false,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!id) return
    if (loading && this.snapshot.review.selectedId === id) {
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          fileChangesLoading: true,
          fileChangesError: '',
        },
      })
    }
    try {
      const fileChanges = await this.api.reviewFileChanges(id, signal)
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== id) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          fileChanges,
          fileChangesLoading: false,
          fileChangesError: '',
        },
      })
    } catch (error) {
      if (signal?.aborted || generation !== this.detailGeneration || this.snapshot.review.selectedId !== id) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          fileChangesLoading: false,
          fileChangesError: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  async selectReviewSession(id: string): Promise<void> {
    if (!id) return
    // Cancel the previous selection's network reads, not just its stale UI updates.
    this.reviewSelectionAbort?.abort()
    const controller = new AbortController()
    this.reviewSelectionAbort = controller
    const generation = ++this.detailGeneration
    const changingSession = this.snapshot.review.selectedId !== id
    this.publish({
      ...this.snapshot,
      review: {
        ...this.snapshot.review,
        selectedId: id,
        detailLoading: true,
        detailLoadingMore: false,
        detailHasNewData: false,
        relationshipError: '',
        fileChangesLoading: true,
        fileChangesError: '',
        ...(changingSession ? { detail: null, relationships: null, fileChanges: null } : {}),
      },
    })
    void this.refreshReviewFileChanges(id, generation, false, controller.signal)
    try {
      const detail = await this.api.reviewDetail(id, { direction: 'backward', limit: REVIEW_DETAIL_PAGE_SIZE, process: 'summary', signal: controller.signal })
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== id) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          detail,
          detailLoading: false,
          error: '',
        },
      })
      if (!this.snapshot.review.response) {
        void this.refreshReview({ preserveDetail: true })
      }

      void this.api.relationships(id, controller.signal).then(
        relationships => {
          if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== id) return
          this.publish({
            ...this.snapshot,
            review: { ...this.snapshot.review, relationships, relationshipError: '' },
          })
        },
        reason => {
          if (controller.signal.aborted || generation !== this.detailGeneration || this.snapshot.review.selectedId !== id) return
          this.publish({
            ...this.snapshot,
            review: {
              ...this.snapshot.review,
              relationships: null,
              relationshipError: reason instanceof Error ? reason.message : String(reason),
            },
          })
        },
      )
    } catch (error) {
      if (controller.signal.aborted || generation !== this.detailGeneration) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          detailLoading: false,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  protected async refreshSelectedTailIncremental(): Promise<void> {
    const current = this.snapshot.review
    if (!current.selectedId || current.detailHasNewData) return
    this.publish({
      ...this.snapshot,
      review: { ...current, detailHasNewData: true },
    })
  }

  async refreshReviewTailIncremental(): Promise<void> {
    const current = this.snapshot.review
    const detail = current.detail
    if (
      !current.selectedId
      || !detail
      || current.detailLoading
      || current.detailLoadingMore
      || detail.page.filter !== 'all'
    ) return

    const last = detail.interactions.at(-1)
    if (!last) {
      await this.jumpToLatestReviewDetail()
      return
    }

    const selectedId = current.selectedId
    const generation = this.detailGeneration
    let merged = detail
    let cursor: string | undefined
    let caughtUp = false

    for (let page = 0; page < 5; page += 1) {
      const next = await this.api.reviewDetail(selectedId, cursor
        ? { cursor, direction: 'forward', limit: REVIEW_DETAIL_PAGE_SIZE, filter: 'all', process: 'summary' }
        : { afterOrdinal: last.ordinal, direction: 'forward', limit: REVIEW_DETAIL_PAGE_SIZE, filter: 'all', process: 'summary' })
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== selectedId) return
      merged = mergeReviewTail(merged, next)
      if (!next.page.hasMore || !next.page.nextCursor) {
        caughtUp = true
        break
      }
      cursor = next.page.nextCursor
    }

    const latest = this.snapshot.review
    if (generation !== this.detailGeneration || latest.selectedId !== selectedId) return
    this.publish({
      ...this.snapshot,
      review: {
        ...latest,
        detail: merged,
        detailHasNewData: !caughtUp,
        error: '',
      },
    })
  }

  protected onLiveEvent(event: LiveUpdateEventDto): void {
    for (const listener of this.liveEventListeners) listener(event)
    const affected: readonly LiveUpdateArea[] = event.affected
    if (affected.includes('review')) {
      if (event.type === 'session.updated') {
        // The summary is already materialized. Patch only this Session instead of
        // re-querying the complete first window.
        if (this.refreshTimer) clearTimeout(this.refreshTimer)
        this.refreshTimer = null
        this.reviewRefreshDueAt = null
        this.reviewLiveDirty = false
        this.scheduleReviewSummaryPatch(event.logicalSessionId)
        if (
          this.reviewActive
          && event.logicalSessionId === this.snapshot.review.selectedId
        ) {
          void this.refreshReviewFileChanges(event.logicalSessionId, this.detailGeneration)
        }
      } else if (event.type === 'observation.committed') {
        const updatesSelectedSession = this.reviewActive
          && Boolean(event.logicalSessionId)
          && event.logicalSessionId === this.snapshot.review.selectedId
        if (updatesSelectedSession) {
          if (this.detailTimer) clearTimeout(this.detailTimer)
          this.detailTimer = setTimeout(() => {
            this.detailTimer = null
            if (this.reviewActive) void this.refreshSelectedTailIncremental()
          }, 160)
        }
        // Summary-ready normally arrives first and replaces this timer with the
        // 100ms path. Keep a bounded fallback so projection failure cannot leave
        // the list stale forever.
        this.scheduleReviewRefresh(2_000)
      } else {
        this.scheduleReviewRefresh()
      }
    }
    if (affected.includes('usage')) {
      this.usageInvalidation += 1
      const usage = this.snapshot.usage
      if (!usage.hasNewData) {
        this.publish({ ...this.snapshot, usage: { ...usage, hasNewData: true } })
      }
    }
    if (affected.includes('agents')) {
      this.agentsInvalidation += 1
      this.patch({ agentCoverage: null, agentsHasNewData: true })
    }
  }
}
