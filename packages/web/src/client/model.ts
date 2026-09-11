import type {
  AgentOverviewResponseDto,
  AgentRescanResponseDto,
  CapturePolicyResponseDto,
  FacetResponseDto,
  HealthResponseDto,
  IntegrationAuthorizationCapabilityDto,
  IntegrationAuthorizationResponseDto,
  IntegrationEnabledUpdateResponseDto,
  IntegrationManagementResponseDto,
  IntegrationPreferenceUpdateRequestDto,
  IntegrationPreferencesResponseDto,
  IntegrationToolDiscoveryResponseDto,
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
import { translateProduct } from '../i18n/runtime'

export interface ClientSnapshot {
  health: HealthResponseDto | null
  facets: FacetResponseDto | null
  agents: AgentOverviewResponseDto | null
  capturePolicy: CapturePolicyResponseDto | null
  agentsLoading: boolean
  agentsError: string
  agentsHasNewData: boolean
  agentsRescanning: boolean
  agentsRescanResult: AgentRescanResponseDto | null
  agentsRescanError: string
  integrationDiscovery: IntegrationToolDiscoveryResponseDto | null
  integrationManagement: IntegrationManagementResponseDto | null
  integrationManagementLoading: boolean
  integrationManagementError: string
  integrationDiscoveryLoading: boolean
  integrationDiscoveryRescanning: boolean
  integrationDiscoveryError: string
  liveConnected: boolean
  review: {
    filters: ReviewFilters
    response: ReviewResponseDto | null
    detail: ReviewSessionDetailDto | null
    relationships: SessionRelationshipResponseDto | null
    relationshipError: string
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
const initialQuery: QueryFilters = { sourceIds: null, projectId: '', range: '7d' }
const INITIAL_REVIEW_LIMIT = 20
const REVIEW_PAGE_SIZE = 20
const REVIEW_DETAIL_PAGE_SIZE = 10
export const REVIEW_DETAIL_WINDOW_SIZE = 30
const REVIEW_SEARCH_DEBOUNCE_MS = 250
const INTEGRATION_DISCOVERY_POLL_MS = 500
const INTEGRATION_DISCOVERY_MAX_POLLS = 20

function discoveryFromManagement(
  management: IntegrationManagementResponseDto,
): IntegrationToolDiscoveryResponseDto {
  return {
    status: management.discovery.status,
    items: management.items.flatMap(item => item.tool ? [{ ...item.tool }] : []),
    ...(management.discovery.startedAt ? { startedAt: management.discovery.startedAt } : {}),
    ...(management.discovery.completedAt ? { completedAt: management.discovery.completedAt } : {}),
    generatedAt: management.discovery.generatedAt,
    meta: { protocolVersion: management.meta.protocolVersion },
  }
}

function applyManagementPreferences(
  management: IntegrationManagementResponseDto,
  preferences: IntegrationManagementResponseDto['preferences'],
): IntegrationManagementResponseDto {
  const index = new Map(preferences.displayOrder.map((id, position) => [id, position]))
  const acknowledged = new Set(preferences.acknowledgedIntegrationIds)
  const items = management.items
    .map(item => ({
      ...item,
      isNew: preferences.onboarding.completed
        && (item.tool?.presence === 'present' || item.tool?.presence === 'data-only')
        && !acknowledged.has(item.integrationId),
      displayOrder: index.get(item.integrationId) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) =>
      left.displayOrder - right.displayOrder
      || left.integrationId.localeCompare(right.integrationId)
    )
  return { ...management, preferences, items }
}

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

export class AgentLensClientModel {
  private snapshot: ClientSnapshot = {
    health: null,
    facets: null,
    agents: null,
    capturePolicy: null,
    agentsLoading: false,
    agentsError: '',
    agentsHasNewData: false,
    agentsRescanning: false,
    agentsRescanResult: null,
    agentsRescanError: '',
    integrationDiscovery: null,
    integrationManagement: null,
    integrationManagementLoading: false,
    integrationManagementError: '',
    integrationDiscoveryLoading: false,
    integrationDiscoveryRescanning: false,
    integrationDiscoveryError: '',
    liveConnected: false,
    review: {
      filters: { sourceIds: null, projectId: '', range: '7d', status: 'all', search: '' },
      response: null,
      detail: null,
      relationships: null,
      relationshipError: '',
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
  private integrationDiscoveryTimer: ReturnType<typeof setTimeout> | null = null
  private reviewInFlight: Promise<void> | null = null
  private reviewRequestDirty = false
  private reviewLiveDirty = false
  private reviewActive = false
  private facetsInFlight: Promise<void> | null = null
  private agentsInFlight: Promise<void> | null = null
  private agentsRescanInFlight: Promise<AgentRescanResponseDto> | null = null
  private integrationDiscoveryInFlight: Promise<IntegrationToolDiscoveryResponseDto> | null = null
  private integrationManagementInFlight: Promise<void> | null = null
  private integrationDiscoveryPolls = 0
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

    const health = await this.api.health().catch(() => null)
    if (health) this.patch({ health })
  }

  stop(): void {
    this.unsubscribeLive?.()
    this.unsubscribeLive = null
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.detailTimer) clearTimeout(this.detailTimer)
    if (this.reviewSearchTimer) clearTimeout(this.reviewSearchTimer)
    if (this.integrationDiscoveryTimer) clearTimeout(this.integrationDiscoveryTimer)
    if (this.visibilityListener && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityListener)
    this.refreshTimer = null
    this.detailTimer = null
    this.reviewSearchTimer = null
    this.integrationDiscoveryTimer = null
    this.integrationDiscoveryPolls = 0
    this.visibilityListener = null
    this.reviewActive = false
  }

  async refreshFacets(): Promise<void> {
    try {
      const facets = await this.api.facets()
      this.patch({ facets })
    } catch {
      // Route data can still load independently.
    }
  }

  ensureFacets(): Promise<void> {
    if (this.snapshot.facets) return Promise.resolve()
    if (this.facetsInFlight) return this.facetsInFlight
    const pending = this.refreshFacets().finally(() => {
      if (this.facetsInFlight === pending) this.facetsInFlight = null
    })
    this.facetsInFlight = pending
    return pending
  }

  async refreshAgents(): Promise<void> {
    const generation = ++this.agentsGeneration
    const invalidation = this.agentsInvalidation
    this.patch({
      agentsLoading: true,
      agentsError: '',
      integrationManagementLoading: true,
      integrationManagementError: '',
      integrationDiscoveryLoading: true,
    })
    try {
      const [agents, capturePolicy, management] = await Promise.all([
        this.api.agents(),
        this.api.capturePolicy().catch(() => null),
        this.api.integrations().then(
          value => ({ value, error: '' }),
          error => ({ value: null, error: error instanceof Error ? error.message : String(error) }),
        ),
      ])
      if (generation !== this.agentsGeneration) return

      let discovery = this.snapshot.integrationDiscovery
      let discoveryError = ''
      if (management.value) {
        discovery = discoveryFromManagement(management.value)
      } else {
        const fallback = await this.api.integrationDiscovery().then(
          value => ({ value, error: '' }),
          error => ({ value: null, error: error instanceof Error ? error.message : String(error) }),
        )
        discovery = fallback.value ?? discovery
        discoveryError = fallback.error
      }

      this.patch({
        agents,
        capturePolicy,
        agentsLoading: false,
        agentsHasNewData: this.agentsInvalidation !== invalidation,
        integrationManagement: management.value ?? this.snapshot.integrationManagement,
        integrationManagementLoading: false,
        integrationManagementError: management.error,
        integrationDiscovery: discovery,
        integrationDiscoveryLoading: false,
        integrationDiscoveryError: discoveryError,
      })

      if (discovery?.status === 'idle' || discovery?.status === 'scanning') {
        this.scheduleIntegrationDiscoveryRefresh()
      } else if (discovery?.status === 'complete') {
        this.integrationDiscoveryPolls = 0
      }
    } catch {
      // Existing data remains visible on refresh failure.
      if (generation !== this.agentsGeneration) return
      this.patch({
        agentsLoading: false,
        agentsError: translateProduct('errors:agentsOverviewFailed'),
        integrationManagementLoading: false,
        integrationDiscoveryLoading: false,
      })
    }
  }

  rescanAgents(): Promise<AgentRescanResponseDto> {
    if (this.agentsRescanInFlight) return this.agentsRescanInFlight
    const generation = ++this.agentsGeneration
    this.patch({ agentsRescanning: true, agentsRescanError: '' })
    const pending = this.api.rescanAgents().then(
      result => {
        if (generation === this.agentsGeneration) {
          this.patch({
            agents: result.agents,
            facets: result.facets,
            agentsLoading: false,
            agentsHasNewData: false,
            agentsRescanning: false,
            agentsRescanResult: result,
            agentsRescanError: '',
          })
        }
        return result
      },
      error => {
        if (generation === this.agentsGeneration) {
          this.patch({
            agentsRescanning: false,
            agentsRescanError: error instanceof Error ? error.message : String(error),
          })
        }
        throw error
      },
    ).finally(() => {
      if (this.agentsRescanInFlight === pending) this.agentsRescanInFlight = null
    })
    this.agentsRescanInFlight = pending
    return pending
  }

  private scheduleIntegrationDiscoveryRefresh(): void {
    if (this.integrationDiscoveryTimer || this.integrationDiscoveryPolls >= INTEGRATION_DISCOVERY_MAX_POLLS) return
    this.integrationDiscoveryTimer = setTimeout(() => {
      this.integrationDiscoveryTimer = null
      this.integrationDiscoveryPolls += 1
      void this.refreshIntegrationDiscovery()
    }, INTEGRATION_DISCOVERY_POLL_MS)
  }

  private async refreshIntegrationDiscovery(): Promise<void> {
    try {
      const management = await this.api.integrations()
      const discovery = discoveryFromManagement(management)
      this.patch({
        integrationManagement: management,
        integrationManagementLoading: false,
        integrationManagementError: '',
        integrationDiscovery: discovery,
        integrationDiscoveryLoading: false,
        integrationDiscoveryError: '',
      })
      if (discovery.status === 'idle' || discovery.status === 'scanning') {
        this.scheduleIntegrationDiscoveryRefresh()
      } else {
        this.integrationDiscoveryPolls = 0
      }
    } catch (managementError) {
      try {
        const result = await this.api.integrationDiscovery()
        this.patch({
          integrationManagementLoading: false,
          integrationManagementError: managementError instanceof Error ? managementError.message : String(managementError),
          integrationDiscovery: result,
          integrationDiscoveryLoading: false,
          integrationDiscoveryError: '',
        })
        if (result.status === 'idle' || result.status === 'scanning') {
          this.scheduleIntegrationDiscoveryRefresh()
        } else {
          this.integrationDiscoveryPolls = 0
        }
      } catch (error) {
        this.patch({
          integrationManagementLoading: false,
          integrationManagementError: managementError instanceof Error ? managementError.message : String(managementError),
          integrationDiscoveryLoading: false,
          integrationDiscoveryError: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  refreshIntegrationManagement(): Promise<void> {
    if (this.integrationManagementInFlight) return this.integrationManagementInFlight
    this.patch({ integrationManagementLoading: true, integrationManagementError: '' })
    const pending = this.api.integrations().then(
      management => {
        const discovery = discoveryFromManagement(management)
        this.patch({
          integrationManagement: management,
          integrationManagementLoading: false,
          integrationManagementError: '',
          integrationDiscovery: discovery,
          integrationDiscoveryLoading: false,
          integrationDiscoveryError: '',
        })
      },
      error => {
        this.patch({
          integrationManagementLoading: false,
          integrationManagementError: error instanceof Error ? error.message : String(error),
        })
        throw error
      },
    ).finally(() => {
      if (this.integrationManagementInFlight === pending) this.integrationManagementInFlight = null
    })
    this.integrationManagementInFlight = pending
    return pending
  }

  async updateIntegrationPreferences(
    input: IntegrationPreferenceUpdateRequestDto,
  ): Promise<IntegrationPreferencesResponseDto> {
    const result = await this.api.updateIntegrationPreferences(input)
    const current = this.snapshot.integrationManagement
    if (current) {
      const management = applyManagementPreferences({
        ...current,
        meta: { ...current.meta, generatedAt: result.meta.generatedAt },
      }, result.preferences)
      this.patch({ integrationManagement: management })
    }
    return result
  }

  async setIntegrationEnabled(
    integrationId: string,
    enabled: boolean,
  ): Promise<IntegrationEnabledUpdateResponseDto> {
    const result = await this.api.setIntegrationEnabled(integrationId, enabled)
    const current = this.snapshot.integrationManagement
    if (current) {
      this.patch({
        integrationManagement: {
          ...current,
          items: current.items.map(item => item.integrationId === integrationId
            ? { ...item, enabled: result.enabled }
            : item),
          meta: { ...current.meta, generatedAt: result.meta.generatedAt },
        },
      })
    }
    return result
  }

  rescanIntegrationDiscovery(): Promise<IntegrationToolDiscoveryResponseDto> {
    if (this.integrationDiscoveryInFlight) return this.integrationDiscoveryInFlight
    this.patch({ integrationDiscoveryRescanning: true, integrationDiscoveryError: '' })
    const pending = this.api.rescanIntegrationDiscovery().then(
      async result => {
        if (this.integrationDiscoveryTimer) {
          clearTimeout(this.integrationDiscoveryTimer)
          this.integrationDiscoveryTimer = null
        }
        this.integrationDiscoveryPolls = 0
        this.patch({
          integrationDiscovery: result,
          integrationDiscoveryLoading: false,
          integrationDiscoveryRescanning: false,
          integrationDiscoveryError: '',
        })
        await this.refreshIntegrationManagement().catch(() => undefined)
        return result
      },
      error => {
        this.patch({
          integrationDiscoveryRescanning: false,
          integrationDiscoveryError: error instanceof Error ? error.message : String(error),
        })
        throw error
      },
    ).finally(() => {
      if (this.integrationDiscoveryInFlight === pending) this.integrationDiscoveryInFlight = null
    })
    this.integrationDiscoveryInFlight = pending
    return pending
  }

  async rescanAgentEnvironment(): Promise<void> {
    const results = await Promise.allSettled([
      this.rescanIntegrationDiscovery(),
      this.rescanAgents(),
    ])
    if (results.every(result => result.status === 'rejected')) {
      const failure = results[0]
      throw failure.status === 'rejected' ? failure.reason : new Error('Agent environment rescan failed')
    }
  }

  async setSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    const current = this.snapshot.capturePolicy
    if (!current) throw new Error(translateProduct('errors:capturePolicyNotLoaded'))
    const next = new Set(current.settings.configuredEnabledSources)
    if (enabled) next.add(sourceId)
    else next.delete(sourceId)
    const capturePolicy = await this.api.updateCaptureSources([...next])
    this.patch({ capturePolicy })
  }

  async authorizeIntegration(
    productId: string,
    capabilities: readonly IntegrationAuthorizationCapabilityDto[],
  ): Promise<IntegrationAuthorizationResponseDto> {
    const result = await this.api.authorizeIntegration(productId, capabilities)
    await this.refreshAgents()
    return result
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
    if (this.snapshot.agents) return Promise.resolve()
    if (this.agentsInFlight) return this.agentsInFlight
    const pending = this.refreshAgents().finally(() => {
      if (this.agentsInFlight === pending) this.agentsInFlight = null
    })
    this.agentsInFlight = pending
    return pending
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

  async jumpToReviewInteraction(ordinal: number): Promise<void> {
    const current = this.snapshot.review
    if (!current.selectedId || ordinal < 1) return
    if (current.detail?.interactions.some(item => item.ordinal === ordinal)) return
    const selectedId = current.selectedId
    const generation = ++this.detailGeneration
    this.publish({ ...this.snapshot, review: { ...current, detailLoading: true, detailLoadingMore: false, error: '' } })
    try {
      const detail = await this.api.reviewDetail(selectedId, { ordinal })
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

  private async fetchReviewWindow(filters: ReviewFilters, targetLimit: number): Promise<ReviewResponseDto> {
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

  private async executeReviewRefresh(generation: number, preserveDetail: boolean): Promise<void> {
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
        relationshipError: '',
        ...(changingSession ? { detail: null, relationships: null } : {}),
      },
    })
    try {
      const detailRequest = this.api.reviewDetail(id, { direction: 'backward', limit: REVIEW_DETAIL_PAGE_SIZE })
        .then(detail => detail.interactions.length > 0 || !detail.interactionIndex?.length
          ? detail
          : this.api.reviewDetail(id, { direction: 'forward', limit: REVIEW_DETAIL_PAGE_SIZE }))
      const relationshipsRequest = this.api.relationships(id).then(
        relationships => ({ relationships, relationshipError: '' }),
        reason => ({
          relationships: null,
          relationshipError: reason instanceof Error ? reason.message : String(reason),
        }),
      )
      const [detail, relationshipState] = await Promise.all([detailRequest, relationshipsRequest])
      if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== id) return
      this.publish({
        ...this.snapshot,
        review: {
          ...this.snapshot.review,
          detail,
          relationships: relationshipState.relationships,
          relationshipError: relationshipState.relationshipError,
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
    if (!current.selectedId || current.detailHasNewData) return
    this.publish({
      ...this.snapshot,
      review: { ...current, detailHasNewData: true },
    })
  }

  private onLiveEvent(event: LiveUpdateEventDto): void {
    const affected: readonly LiveUpdateArea[] = event.affected
    if (affected.includes('review')) {
      const updatesSelectedSession = this.reviewActive
        && event.type === 'observation.committed'
        && Boolean(event.logicalSessionId)
        && event.logicalSessionId === this.snapshot.review.selectedId
      if (updatesSelectedSession) {
        if (this.detailTimer) clearTimeout(this.detailTimer)
        this.detailTimer = setTimeout(() => {
          this.detailTimer = null
          if (this.reviewActive) void this.refreshSelectedTailIncremental()
        }, 160)
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
      if (!this.snapshot.agentsHasNewData) this.patch({ agentsHasNewData: true })
    }
  }
}

export const clientModel = new AgentLensClientModel()