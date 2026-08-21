import type {
  AgentOverviewResponseDto,
  FacetResponseDto,
  HealthResponseDto,
  LiveUpdateArea,
  LiveUpdateEventDto,
  ReviewResponseDto,
  ReviewSessionDetailDto,
  SessionRelationshipResponseDto,
  ToolAssetUsageResponseDto,
} from '@agent-lens/protocol'
import { AgentLensApi, type QueryFilters, type ReviewFilters } from './api'

export interface ClientSnapshot {
  health: HealthResponseDto | null
  facets: FacetResponseDto | null
  agents: AgentOverviewResponseDto | null
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
    error: string
  }
  usage: {
    filters: QueryFilters
    response: ToolAssetUsageResponseDto | null
    loading: boolean
    error: string
  }
}

type Listener = () => void
const initialQuery: QueryFilters = { sourceId: '', projectId: '', range: '7d' }
const INITIAL_REVIEW_LIMIT = 40
const REVIEW_PAGE_SIZE = 40
const MAX_REVIEW_LIMIT = 500

export class AgentLensClientModel {
  private snapshot: ClientSnapshot = {
    health: null,
    facets: null,
    agents: null,
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
      error: '',
    },
    usage: {
      filters: { ...initialQuery },
      response: null,
      loading: true,
      error: '',
    },
  }
  private readonly listeners = new Set<Listener>()
  private notifyQueued = false
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private usageTimer: ReturnType<typeof setTimeout> | null = null
  private agentsTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeLive: (() => void) | null = null
  private reviewGeneration = 0
  private detailGeneration = 0
  private usageGeneration = 0
  private agentsGeneration = 0

  constructor(private readonly api = new AgentLensApi()) {}

  getSnapshot = (): ClientSnapshot => this.snapshot

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

    const health = await this.api.health().catch(() => null)
    if (health) this.patch({ health })
    await Promise.all([
      this.refreshFacetsAndAgents(),
      this.refreshReview(),
      this.refreshUsage(),
    ])
  }

  stop(): void {
    this.unsubscribeLive?.()
    this.unsubscribeLive = null
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.usageTimer) clearTimeout(this.usageTimer)
    if (this.agentsTimer) clearTimeout(this.agentsTimer)
    this.refreshTimer = null
    this.usageTimer = null
    this.agentsTimer = null
  }

  async refreshFacetsAndAgents(): Promise<void> {
    const generation = ++this.agentsGeneration
    const [facets, agents] = await Promise.allSettled([
      this.api.facets(),
      this.api.agents(),
    ])
    if (generation !== this.agentsGeneration) return
    this.patch({
      ...(facets.status === 'fulfilled' ? { facets: facets.value } : {}),
      ...(agents.status === 'fulfilled' ? { agents: agents.value } : {}),
    })
  }

  setReviewFilters(patch: Partial<ReviewFilters>): void {
    const filters = { ...this.snapshot.review.filters, ...patch }
    this.publish({
      ...this.snapshot,
      review: { ...this.snapshot.review, filters, limit: INITIAL_REVIEW_LIMIT },
    })
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
    if (current.loading || current.loadingMore || !current.response?.meta.hasMore) return
    const nextLimit = Math.min(current.limit + REVIEW_PAGE_SIZE, MAX_REVIEW_LIMIT)
    if (nextLimit === current.limit) return
    this.publish({
      ...this.snapshot,
      review: { ...current, limit: nextLimit, loadingMore: true, error: '' },
    })
    await this.refreshReview({ preserveDetail: true, loadingMore: true })
  }

  async refreshReview(options: { preserveDetail?: boolean; loadingMore?: boolean } = {}): Promise<void> {
    const generation = ++this.reviewGeneration
    const current = this.snapshot.review
    this.publish({
      ...this.snapshot,
      review: {
        ...current,
        loading: options.loadingMore ? current.loading : true,
        loadingMore: options.loadingMore ?? false,
        error: '',
      },
    })
    try {
      const response = await this.api.review(current.filters, current.limit)
      if (generation !== this.reviewGeneration) return
      let selectedId = this.snapshot.review.selectedId
      if (!selectedId || !response.items.some(item => item.id === selectedId)) {
        selectedId = response.items[0]?.id ?? ''
      }
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          response,
          selectedId,
          loading: false,
          loadingMore: false,
          error: '',
        },
      })
      if (selectedId && (!options.preserveDetail || this.snapshot.review.detail?.id !== selectedId)) {
        await this.selectReviewSession(selectedId)
      } else if (!selectedId) {
        this.publish({
          ...this.snapshot,
          review: {
            ...this.snapshot.review,
            detail: null,
            relationships: null,
          },
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
    this.publish({
      ...this.snapshot,
      review: { ...this.snapshot.review, selectedId: id },
    })
    try {
      const [detail, relationships] = await Promise.all([
        this.api.reviewDetail(id),
        this.api.relationships(id),
      ])
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== id) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          detail,
          relationships,
          error: '',
        },
      })
    } catch (error) {
      if (generation !== this.detailGeneration) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  async refreshUsage(): Promise<void> {
    const generation = ++this.usageGeneration
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

  private onLiveEvent(event: LiveUpdateEventDto): void {
    const affected: readonly LiveUpdateArea[] = event.affected
    if (affected.includes('review')) {
      if (this.refreshTimer) clearTimeout(this.refreshTimer)
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null
        void this.refreshReview({ preserveDetail: true })
      }, 140)
    }
    if (affected.includes('usage')) {
      if (this.usageTimer) clearTimeout(this.usageTimer)
      this.usageTimer = setTimeout(() => {
        this.usageTimer = null
        void this.refreshUsage()
      }, 800)
    }
    if (affected.includes('agents')) {
      if (this.agentsTimer) clearTimeout(this.agentsTimer)
      this.agentsTimer = setTimeout(() => {
        this.agentsTimer = null
        void this.refreshFacetsAndAgents()
      }, 250)
    }
  }
}

export const clientModel = new AgentLensClientModel()
