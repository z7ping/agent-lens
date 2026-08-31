import type {
  AgentOverviewResponseDto,
  CapturePolicyResponseDto,
  FacetResponseDto,
  HealthResponseDto,
  LiveUpdateArea,
  LiveUpdateEventDto,
  ReviewDetailFilter,
  ReviewResponseDto,
  ReviewSessionDetailDto,
  SessionRelationshipResponseDto,
  SourceRecordResponseDto,
  ToolAssetUsageResponseDto,
} from '@agent-lens/protocol'
import { AgentLensApi, type QueryFilters, type ReviewFilters } from './api'

export interface ClientSnapshot {
  health: HealthResponseDto | null
  facets: FacetResponseDto | null
  agents: AgentOverviewResponseDto | null
  capturePolicy: CapturePolicyResponseDto | null
  agentsHasNewData: boolean
  liveConnected: boolean
  review: {
    filters: ReviewFilters
    response: ReviewResponseDto | null
    detail: ReviewSessionDetailDto | null
    relationships: SessionRelationshipResponseDto | null
    selectedId: string
    limit: number
    loading: boolean
    loadingMore: boolean
    detailLoading: boolean
    detailLoadingMore: boolean
    detailHasNewData: boolean
    error: string
  }
  usage: {
    filters: QueryFilters
    response: ToolAssetUsageResponseDto | null
    loading: boolean
    hasNewData: boolean
    error: string
  }
}

type Listener = () => void
const initialQuery: QueryFilters = { sourceId: '', projectId: '', range: '7d' }
const INITIAL_REVIEW_LIMIT = 40
const REVIEW_PAGE_SIZE = 40
const REVIEW_DETAIL_PAGE_SIZE = 20
const REVIEW_SEARCH_DEBOUNCE_MS = 250

function mergeReviewDetail(current: ReviewSessionDetailDto, next: ReviewSessionDetailDto): ReviewSessionDetailDto {
  const interactions = new Map(current.interactions.map(item => [item.id, item]))
  for (const interaction of next.interactions) interactions.set(interaction.id, interaction)
  return {
    ...current,
    interactions: [...interactions.values()].sort((a, b) => a.ordinal - b.ordinal),
    page: next.page,
  }
}

function mergeReviewTail(current: ReviewSessionDetailDto, tail: ReviewSessionDetailDto): ReviewSessionDetailDto {
  const interactions = new Map(current.interactions.map(item => [item.id, item]))
  for (const interaction of tail.interactions) interactions.set(interaction.id, interaction)
  const lastOrdinal = Math.max(0, ...tail.interactions.map(item => item.ordinal))
  return {
    ...current,
    endedAt: tail.endedAt > current.endedAt ? tail.endedAt : current.endedAt,
    durationMs: Math.max(current.durationMs, tail.durationMs),
    observationCount: Math.max(current.observationCount, tail.observationCount),
    interactionCount: Math.max(current.interactionCount, tail.interactionCount, lastOrdinal),
    toolCount: Math.max(current.toolCount, tail.toolCount),
    errorCount: Math.max(current.errorCount, tail.errorCount),
    hasErrors: current.hasErrors || tail.hasErrors,
    interactions: [...interactions.values()].sort((a, b) => a.ordinal - b.ordinal),
    page: current.page,
  }
}

export class AgentLensClientModel {
  private snapshot: ClientSnapshot = {
    health: null,
    facets: null,
    agents: null,
    capturePolicy: null,
    agentsHasNewData: false,
    liveConnected: false,
    review: {
      filters: { ...initialQuery, status: 'all', search: '' },
      response: null,
      detail: null,
      relationships: null,
      selectedId: '',
      limit: INITIAL_REVIEW_LIMIT,
      loading: true,
      loadingMore: false,
      detailLoading: false,
      detailLoadingMore: false,
      detailHasNewData: false,
      error: '',
    },
    usage: {
      filters: { ...initialQuery },
      response: null,
      loading: true,
      hasNewData: false,
      error: '',
    },
  }
  private readonly listeners = new Set<Listener>()
  private notifyQueued = false
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private detailTimer: ReturnType<typeof setTimeout> | null = null
  private reviewSearchTimer: ReturnType<typeof setTimeout> | null = null
  private reviewInFlight: Promise<void> | null = null
  private reviewRequestDirty = false
  private reviewLiveDirty = false
  private reviewActive = false
  private visibilityListener: (() => void) | null = null
  private unsubscribeLive: (() => void) | null = null
  private reviewGeneration = 0
  private detailGeneration = 0
  private usageGeneration = 0
  private agentsGeneration = 0
  private usageInvalidation = 0
  private agentsInvalidation = 0

  constructor(private readonly api = new AgentLensApi()) {}

  getSnapshot = (): ClientSnapshot => this.snapshot

  sourceRecord = (id: string): Promise<SourceRecordResponseDto> => this.api.sourceRecord(id)

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(next: ClientSnapshot): void {
    this.snapshot = next
    if (this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      for (const listener of this.listeners) listener()
    })
  }

  private patch(patch: Partial<ClientSnapshot>): void {
    this.publish({ ...this.snapshot, ...patch })
  }

  async start(): Promise<void> {
    if (!this.unsubscribeLive) {
      this.unsubscribeLive = this.api.subscribe(
        event => this.onLiveEvent(event),
        connected => this.patch({ liveConnected: connected }),
      )
    }
    if (!this.visibilityListener && typeof document !== 'undefined') {
      this.visibilityListener = () => {
        if (!document.hidden && this.reviewActive && this.reviewLiveDirty) this.scheduleReviewRefresh(0)
      }
      document.addEventListener('visibilitychange', this.visibilityListener)
    }

    const [health] = await Promise.all([
      this.api.health().catch(() => null),
      this.refreshFacets(),
    ])
    if (health) this.patch({ health })
  }

  stop(): void {
    this.unsubscribeLive?.()
    this.unsubscribeLive = null
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.detailTimer) clearTimeout(this.detailTimer)
    if (this.reviewSearchTimer) clearTimeout(this.reviewSearchTimer)
    if (this.visibilityListener && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityListener)
    this.refreshTimer = null
    this.detailTimer = null
    this.reviewSearchTimer = null
    this.visibilityListener = null
    this.reviewActive = false
  }

  async refreshFacets(): Promise<void> {
    try {
      const facets = await this.api.facets()
      this.patch({ facets })
    } catch {
      // Facets are shared navigation metadata; route data can still load independently.
    }
  }

  async refreshAgents(): Promise<void> {
    const generation = ++this.agentsGeneration
    const invalidation = this.agentsInvalidation
    try {
      const [agents, capturePolicy] = await Promise.all([
        this.api.agents(),
        this.api.capturePolicy().catch(() => null),
      ])
      if (generation !== this.agentsGeneration) return
      this.patch({ agents, capturePolicy, agentsHasNewData: this.agentsInvalidation !== invalidation })
    } catch {
      // Existing data remains visible on refresh failure.
    }
  }

  async setSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    const current = this.snapshot.capturePolicy
    if (!current) throw new Error('采集策略状态尚未加载')
    const next = new Set(current.settings.configuredEnabledSources)
    if (enabled) next.add(sourceId)
    else next.delete(sourceId)
    const capturePolicy = await this.api.updateCaptureSources([...next])
    this.patch({ capturePolicy })
  }

  async refreshFacetsAndAgents(): Promise<void> {
    await Promise.all([this.refreshFacets(), this.refreshAgents()])
  }

  ensureReview(): Promise<void> {
    return this.snapshot.review.response ? Promise.resolve() : this.refreshReview()
  }

  ensureUsage(): Promise<void> {
    return this.snapshot.usage.response ? Promise.resolve() : this.refreshUsage()
  }

  ensureAgents(): Promise<void> {
    return this.snapshot.agents ? Promise.resolve() : this.refreshAgents()
  }

  setReviewActive(active: boolean): void {
    this.reviewActive = active
    if (!active) {
      if (this.refreshTimer) clearTimeout(this.refreshTimer)
      this.refreshTimer = null
      return
    }
    if (this.reviewLiveDirty) this.scheduleReviewRefresh(0)
  }

  private scheduleReviewRefresh(delay?: number): void {
    this.reviewLiveDirty = true
    if (!this.reviewActive) return
    if (typeof document !== 'undefined' && document.hidden) return
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    const wait = delay ?? 800
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (!this.reviewActive || !this.reviewLiveDirty) return
      this.reviewLiveDirty = false
      void this.refreshReview({ preserveDetail: true })
    }, wait)
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
      const detail = await this.api.reviewDetail(selectedId, { filter, limit: REVIEW_DETAIL_PAGE_SIZE })
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
      const detail = await this.api.reviewDetail(selectedId, { direction: 'backward', limit: REVIEW_DETAIL_PAGE_SIZE })
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
      const detail = await this.api.reviewDetail(selectedId, { direction: 'forward', limit: REVIEW_DETAIL_PAGE_SIZE })
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
    this.reviewLiveDirty = false
    this.reviewGeneration += 1
    if (this.reviewInFlight) {
      this.reviewRequestDirty = true
      return this.reviewInFlight
    }

    let preserveDetail = options.preserveDetail === true
    const run = async () => {
      do {
        this.reviewRequestDirty = false
        const generation = this.reviewGeneration
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

  private async executeReviewRefresh(generation: number, preserveDetail: boolean): Promise<void> {
    const current = this.snapshot.review
    this.publish({
      ...this.snapshot,
      review: { ...current, loading: true, loadingMore: false, error: '' },
    })
    try {
      const response = await this.api.review(current.filters, INITIAL_REVIEW_LIMIT)
      if (generation !== this.reviewGeneration) return
      let selectedId = this.snapshot.review.selectedId
      if (!selectedId || !response.items.some(item => item.id === selectedId)) selectedId = response.items[0]?.id ?? ''
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          response,
          selectedId,
          limit: INITIAL_REVIEW_LIMIT,
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
          review: { ...this.snapshot.review, detail: null, relationships: null },
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

  async selectReviewSession(id: string): Promise<void> {
    if (!id) return
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
        ...(changingSession ? { detail: null, relationships: null } : {}),
      },
    })
    try {
      const [detail, relationships] = await Promise.all([
        this.api.reviewDetail(id, { direction: 'backward', limit: REVIEW_DETAIL_PAGE_SIZE }),
        this.api.relationships(id),
      ])
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== id) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          detail,
          relationships,
          detailLoading: false,
          error: '',
        },
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

  async refreshUsage(): Promise<void> {
    const generation = ++this.usageGeneration
    const invalidation = this.usageInvalidation
    const current = this.snapshot.usage
    this.publish({
      ...this.snapshot,
      usage: { ...current, loading: true, error: '' },
    })
    try {
      const response = await this.api.usage(current.filters)
      if (generation !== this.usageGeneration) return
      this.publish({
        ...this.snapshot,
        usage: {
          ...this.snapshot.usage,
          response,
          loading: false,
          hasNewData: this.usageInvalidation !== invalidation,
          error: '',
        },
      })
    } catch (error) {
      if (generation !== this.usageGeneration) return
      this.publish({
        ...this.snapshot,
        usage: {
          ...this.snapshot.usage,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private async refreshSelectedTailIncremental(): Promise<void> {
    const current = this.snapshot.review
    const detail = current.detail
    if (!current.selectedId || !detail || detail.page.filter !== 'all') {
      if (current.selectedId) {
        this.publish({ ...this.snapshot, review: { ...current, detailHasNewData: true } })
      }
      return
    }

    const includesTail = detail.page.direction === 'backward' || !detail.page.hasMore
    if (!includesTail) {
      this.publish({ ...this.snapshot, review: { ...current, detailHasNewData: true } })
      return
    }

    const selectedId = current.selectedId
    const generation = this.detailGeneration
    try {
      const tail = await this.api.reviewDetail(selectedId, { direction: 'backward', limit: 2 })
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== selectedId) return
      const latest = this.snapshot.review
      if (!latest.detail || latest.detail.page.filter !== 'all') return
      this.publish({
        ...this.snapshot,
        review: {
          ...latest,
          detail: mergeReviewTail(latest.detail, tail),
          detailHasNewData: true,
        },
      })
    } catch {
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== selectedId) return
      this.publish({
        ...this.snapshot,
        review: { ...this.snapshot.review, detailHasNewData: true },
      })
    }
  }

  private onLiveEvent(event: LiveUpdateEventDto): void {
    const affected: readonly LiveUpdateArea[] = event.affected
    if (affected.includes('review')) {
      if (this.reviewActive && event.type === 'observation.committed' && event.logicalSessionId && event.logicalSessionId === this.snapshot.review.selectedId) {
        if (this.detailTimer) clearTimeout(this.detailTimer)
        this.detailTimer = setTimeout(() => {
          this.detailTimer = null
          if (this.reviewActive) void this.refreshSelectedTailIncremental()
        }, 160)
      }
      this.scheduleReviewRefresh()
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
      if (!this.snapshot.agentsHasNewData) this.patch({ agentsHasNewData: true })
    }
  }
}

export const clientModel = new AgentLensClientModel()
