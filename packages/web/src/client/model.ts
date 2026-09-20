import type {
  AgentCoverageResponseDto,
  AgentDetailResponseDto,
  AgentEnrichmentResponseDto,
  AgentOverviewResponseDto,
  AgentRescanResponseDto,
  AgentSummaryResponseDto,
  CapturePolicyResponseDto,
  FacetResponseDto,
  HealthResponseDto,
  HostFilePreviewResponseDto,
  IntegrationAuthorizationCapabilityDto,
  IntegrationAuthorizationResponseDto,
  IntegrationEnabledUpdateResponseDto,
  IntegrationManagementResponseDto,
  IntegrationPackageOperationResponseDto,
  IntegrationPreferenceUpdateRequestDto,
  IntegrationPreferencesResponseDto,
  IntegrationToolDiscoveryResponseDto,
  LiveUpdateArea,
  ManagedAssetDirectoryResponseDto,
  ManagedAssetFilePreviewResponseDto,
  ManagedAssetRoot,
  LiveUpdateEventDto,
  ReviewDetailFilter,
  ReviewInteractionDto,
  ReviewMessageAttachmentDto,
  ReviewResponseDto,
  ReviewSessionDetailDto,
  ReviewSessionSummaryDto,
  SessionRelationshipResponseDto,
  SourceRecordResponseDto,
  TaskFileChangesResponseDto,
  ToolAssetUsageResponseDto,
} from '@agent-lens/protocol'
import { AgentLensApi, type QueryFilters, type ReviewFilters } from './api'
import { translateProduct } from '../i18n/runtime'

export interface ClientSnapshot {
  health: HealthResponseDto | null
  facets: FacetResponseDto | null
  agentSummaries: AgentSummaryResponseDto | null
  agentCoverage: AgentCoverageResponseDto | null
  agents: AgentOverviewResponseDto | null
  agentDetailLoadingSourceId: string
  agentDetailError: string
  capturePolicy: CapturePolicyResponseDto | null
  agentsLoading: boolean
  agentsError: string
  agentsHasNewData: boolean
  agentsRescanning: boolean
  agentsRescanResult: AgentRescanResponseDto | null
  agentsRescanError: string
  agentEnvironmentRescanTargetId: string
  integrationDiscovery: IntegrationToolDiscoveryResponseDto | null
  integrationPreferences: IntegrationPreferencesResponseDto | null
  integrationPreferencesLoading: boolean
  integrationPreferencesError: string
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
    fileChanges: TaskFileChangesResponseDto | null
    fileChangesLoading: boolean
    fileChangesError: string
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
type LiveEventListener = (event: LiveUpdateEventDto) => void
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

function summariesFromOverview(response: AgentOverviewResponseDto): AgentSummaryResponseDto {
  return {
    items: response.items.map(item => ({
      sourceId: item.sourceId,
      productId: item.productId,
      displayName: item.displayName,
      supported: item.supported,
      enabled: item.enabled,
      detected: item.detected,
      installationIds: item.installations.map(installation => installation.id),
      installationCount: item.installations.length,
    })),
    meta: response.meta,
  }
}

function mergeAgentDetail(
  current: AgentOverviewResponseDto | null,
  detail: AgentDetailResponseDto,
): AgentOverviewResponseDto {
  const items = new Map((current?.items ?? []).map(item => [item.sourceId, item]))
  items.set(detail.item.sourceId, detail.item)
  return {
    items: [...items.values()],
    meta: detail.meta,
  }
}

function mergeAgentEnrichment(
  current: AgentOverviewResponseDto | null,
  enrichment: AgentEnrichmentResponseDto,
): AgentOverviewResponseDto | null {
  if (!current) return current
  const item = current.items.find(agent => agent.sourceId === enrichment.sourceId)
  if (!item) return current
  return {
    items: current.items.map(agent => agent.sourceId === enrichment.sourceId
      ? {
          ...agent,
          ...(enrichment.integration ? { integration: enrichment.integration } : {}),
          capabilities: enrichment.capabilities,
          usedAssets: enrichment.usedAssets,
        }
      : agent),
    meta: enrichment.meta,
  }
}

export class AgentLensClientModel {
  private snapshot: ClientSnapshot = {
    health: null,
    facets: null,
    agentSummaries: null,
    agentCoverage: null,
    agents: null,
    agentDetailLoadingSourceId: '',
    agentDetailError: '',
    capturePolicy: null,
    agentsLoading: false,
    agentsError: '',
    agentsHasNewData: false,
    agentsRescanning: false,
    agentsRescanResult: null,
    agentsRescanError: '',
    agentEnvironmentRescanTargetId: '',
    integrationDiscovery: null,
    integrationPreferences: null,
    integrationPreferencesLoading: false,
    integrationPreferencesError: '',
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
      fileChanges: null,
      fileChangesLoading: false,
      fileChangesError: '',
      selectedId: '',
      limit: INITIAL_REVIEW_LIMIT,
      loading: false,
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
  private readonly liveEventListeners = new Set<LiveEventListener>()
  private notifyQueued = false
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private reviewRefreshDueAt: number | null = null
  private detailTimer: ReturnType<typeof setTimeout> | null = null
  private reviewSearchTimer: ReturnType<typeof setTimeout> | null = null
  private integrationDiscoveryTimer: ReturnType<typeof setTimeout> | null = null
  private reviewInFlight: Promise<void> | null = null
  private reviewRequestDirty = false
  private reviewLiveDirty = false
  private reviewPaginationDirty = false
  private readonly pendingReviewSummaryIds = new Set<string>()
  private reviewSummaryPatchTimer: ReturnType<typeof setTimeout> | null = null
  private reviewActive = false
  private facetsInFlight: Promise<void> | null = null
  private agentsInFlight: Promise<void> | null = null
  private readonly agentDetailInFlight = new Map<string, Promise<void>>()
  private readonly agentEnrichmentInFlight = new Map<string, Promise<void>>()
  private agentCoverageInFlight: Promise<void> | null = null
  private agentsRescanInFlight: Promise<AgentRescanResponseDto> | null = null
  private integrationDiscoveryInFlight: Promise<IntegrationToolDiscoveryResponseDto> | null = null
  private integrationPreferencesInFlight: Promise<void> | null = null
  private integrationManagementInFlight: Promise<void> | null = null
  private integrationDiscoveryPolls = 0
  private integrationDiscoveryActive = false
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

  reviewAttachments = (observationId: string): Promise<ReviewMessageAttachmentDto[]> =>
    this.api.reviewAttachments(observationId)

  reviewProcessDetail = (
    sessionId: string,
    ordinal: number,
    revision: string,
    signal?: AbortSignal,
  ): Promise<ReviewInteractionDto | null> =>
    this.api.reviewProcessDetail(sessionId, ordinal, revision, signal)

  sourceRecord = (id: string): Promise<SourceRecordResponseDto> => this.api.sourceRecord(id)
  sourceRecords = (ids: readonly string[]): Promise<SourceRecordResponseDto[]> => this.api.sourceRecords(ids)

  managedAssetDirectory = (
    productId: string,
    installationId: string,
    root: ManagedAssetRoot,
    path = '',
    bindingId?: string,
  ): Promise<ManagedAssetDirectoryResponseDto> =>
    this.api.managedAssetDirectory(productId, installationId, root, path, bindingId)

  managedAssetFile = (
    productId: string,
    installationId: string,
    root: ManagedAssetRoot,
    path: string,
    bindingId?: string,
  ): Promise<ManagedAssetFilePreviewResponseDto> =>
    this.api.managedAssetFile(productId, installationId, root, path, bindingId)

  openHostPath = (path: string): Promise<{ opened: boolean; action?: 'opened' | 'revealed' }> =>
    this.api.openHostPath(path)

  previewHostFile = (path: string): Promise<HostFilePreviewResponseDto> =>
    this.api.previewHostFile(path)

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeLiveEvents = (listener: LiveEventListener): (() => void) => {
    this.liveEventListeners.add(listener)
    return () => this.liveEventListeners.delete(listener)
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
        if (document.hidden) {
          if (this.integrationDiscoveryTimer) clearTimeout(this.integrationDiscoveryTimer)
          this.integrationDiscoveryTimer = null
          return
        }
        if (this.reviewActive && this.reviewLiveDirty) this.scheduleReviewRefresh(0)
        const discoveryStatus = this.snapshot.integrationDiscovery?.status
        if (
          this.integrationDiscoveryActive
          && (discoveryStatus === 'idle' || discoveryStatus === 'scanning')
        ) this.scheduleIntegrationDiscoveryRefresh()
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
    this.reviewRefreshDueAt = null
    if (this.detailTimer) clearTimeout(this.detailTimer)
    if (this.reviewSearchTimer) clearTimeout(this.reviewSearchTimer)
    if (this.reviewSummaryPatchTimer) clearTimeout(this.reviewSummaryPatchTimer)
    this.pendingReviewSummaryIds.clear()
    if (this.integrationDiscoveryTimer) clearTimeout(this.integrationDiscoveryTimer)
    if (this.visibilityListener && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityListener)
    this.refreshTimer = null
    this.detailTimer = null
    this.reviewSearchTimer = null
    this.reviewSummaryPatchTimer = null
    this.integrationDiscoveryTimer = null
    this.integrationDiscoveryPolls = 0
    this.integrationDiscoveryActive = false
    this.liveEventListeners.clear()
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
    this.patch({ agentsLoading: true, agentsError: '' })

    let summaries: AgentSummaryResponseDto
    try {
      summaries = await this.api.agentSummaries()
    } catch {
      if (generation !== this.agentsGeneration) return
      this.patch({
        agentsLoading: false,
        agentsError: translateProduct('errors:agentsOverviewFailed'),
      })
      return
    }
    if (generation !== this.agentsGeneration) return

    // Summary is the page/navigation critical read. Detail and management data
    // are loaded independently after this point.
    this.patch({
      agentSummaries: summaries,
      agentCoverage: null,
      agentsLoading: false,
      agentsError: '',
      agentsHasNewData: this.agentsInvalidation !== invalidation,
    })

    this.patch({
      integrationManagementLoading: true,
      integrationManagementError: '',
      integrationDiscoveryLoading: true,
    })
    const [capturePolicy, management] = await Promise.all([
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
      capturePolicy,
      integrationManagement: management.value ?? this.snapshot.integrationManagement,
      ...(management.value
        ? { integrationPreferences: { preferences: management.value.preferences, meta: management.value.meta } }
        : {}),
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
  }

  ensureAgentDetail(sourceId: string): Promise<void> {
    if (!sourceId) return Promise.resolve()
    if (this.snapshot.agents?.items.some(item => item.sourceId === sourceId)) return Promise.resolve()
    const existing = this.agentDetailInFlight.get(sourceId)
    if (existing) return existing

    this.patch({ agentDetailLoadingSourceId: sourceId, agentDetailError: '' })
    const pending = this.api.agentDetail(sourceId).then(
      detail => {
        if (!detail) throw new Error(`Unknown Agent source: ${sourceId}`)
        this.patch({
          agents: mergeAgentDetail(this.snapshot.agents, detail),
          agentDetailLoadingSourceId: '',
          agentDetailError: '',
        })
        void this.ensureAgentEnrichment(sourceId)
      },
      error => {
        this.patch({
          agentDetailLoadingSourceId: '',
          agentDetailError: error instanceof Error ? error.message : String(error),
        })
        throw error
      },
    ).finally(() => {
      this.agentDetailInFlight.delete(sourceId)
    })
    this.agentDetailInFlight.set(sourceId, pending)
    return pending
  }

  ensureAgentEnrichment(sourceId: string): Promise<void> {
    if (!sourceId) return Promise.resolve()
    const current = this.snapshot.agents?.items.find(item => item.sourceId === sourceId)
    if (current && (current.usedAssets.length > 0 || current.capabilities.length > 0 || current.integration)) {
      return Promise.resolve()
    }
    const existing = this.agentEnrichmentInFlight.get(sourceId)
    if (existing) return existing
    const pending = this.api.agentEnrichment(sourceId).then(enrichment => {
      if (!enrichment) return
      const agents = mergeAgentEnrichment(this.snapshot.agents, enrichment)
      if (agents) this.patch({ agents })
    }).catch(() => {
      // Supporting enrichment must never fail the core Agent detail.
    }).finally(() => {
      this.agentEnrichmentInFlight.delete(sourceId)
    })
    this.agentEnrichmentInFlight.set(sourceId, pending)
    return pending
  }

  refreshAgentCoverage(): Promise<void> {
    if (this.snapshot.agentCoverage) return Promise.resolve()
    if (this.agentCoverageInFlight) return this.agentCoverageInFlight
    const pending = this.api.agentCoverage().then(agentCoverage => {
      this.patch({ agentCoverage })
    }).finally(() => {
      if (this.agentCoverageInFlight === pending) this.agentCoverageInFlight = null
    })
    this.agentCoverageInFlight = pending
    return pending
  }

  rescanAgents(sourceId?: string): Promise<AgentRescanResponseDto> {
    if (this.agentsRescanInFlight) return this.agentsRescanInFlight
    const generation = ++this.agentsGeneration
    this.patch({ agentsRescanning: true, agentsRescanError: '' })
    const pending = this.api.rescanAgents(sourceId).then(
      result => {
        if (generation === this.agentsGeneration) {
          this.patch({
            agents: result.agents,
            agentSummaries: summariesFromOverview(result.agents),
            agentCoverage: null,
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

  setIntegrationDiscoveryActive(active: boolean): void {
    this.integrationDiscoveryActive = active
    if (!active) {
      if (this.integrationDiscoveryTimer) clearTimeout(this.integrationDiscoveryTimer)
      this.integrationDiscoveryTimer = null
      return
    }
    const status = this.snapshot.integrationDiscovery?.status
    if (status === 'idle' || status === 'scanning') this.scheduleIntegrationDiscoveryRefresh()
  }

  private scheduleIntegrationDiscoveryRefresh(): void {
    if (
      !this.integrationDiscoveryActive
      || (typeof document !== 'undefined' && document.hidden)
      || this.integrationDiscoveryTimer
      || this.integrationDiscoveryPolls >= INTEGRATION_DISCOVERY_MAX_POLLS
    ) return
    this.integrationDiscoveryTimer = setTimeout(() => {
      this.integrationDiscoveryTimer = null
      this.integrationDiscoveryPolls += 1
      void this.refreshIntegrationDiscovery()
    }, INTEGRATION_DISCOVERY_POLL_MS)
  }

  private async refreshIntegrationDiscovery(): Promise<void> {
    try {
      const result = await this.api.integrationDiscovery()
      this.patch({
        integrationDiscovery: result,
        integrationDiscoveryLoading: false,
        integrationDiscoveryError: '',
      })
      if (result.status === 'idle' || result.status === 'scanning') {
        this.scheduleIntegrationDiscoveryRefresh()
      } else {
        this.integrationDiscoveryPolls = 0
        await this.refreshIntegrationManagement().catch(() => undefined)
      }
    } catch (error) {
      this.patch({
        integrationDiscoveryLoading: false,
        integrationDiscoveryError: error instanceof Error ? error.message : String(error),
      })
    }
  }

  refreshIntegrationPreferences(): Promise<void> {
    if (this.integrationPreferencesInFlight) return this.integrationPreferencesInFlight
    this.patch({ integrationPreferencesLoading: true, integrationPreferencesError: '' })
    const pending = this.api.integrationPreferences().then(
      result => {
        this.patch({
          integrationPreferences: result,
          integrationPreferencesLoading: false,
          integrationPreferencesError: '',
        })
      },
      error => {
        this.patch({
          integrationPreferencesLoading: false,
          integrationPreferencesError: error instanceof Error ? error.message : String(error),
        })
        throw error
      },
    ).finally(() => {
      if (this.integrationPreferencesInFlight === pending) this.integrationPreferencesInFlight = null
    })
    this.integrationPreferencesInFlight = pending
    return pending
  }

  ensureIntegrationPreferences(): Promise<void> {
    if (this.snapshot.integrationPreferences) return Promise.resolve()
    return this.refreshIntegrationPreferences()
  }

  refreshIntegrationManagement(): Promise<void> {
    if (this.integrationManagementInFlight) return this.integrationManagementInFlight
    this.patch({ integrationManagementLoading: true, integrationManagementError: '' })
    const pending = this.api.integrations().then(
      management => {
        const discovery = discoveryFromManagement(management)
        this.patch({
          integrationManagement: management,
          integrationPreferences: { preferences: management.preferences, meta: management.meta },
          integrationPreferencesLoading: false,
          integrationPreferencesError: '',
          integrationManagementLoading: false,
          integrationManagementError: '',
          integrationDiscovery: discovery,
          integrationDiscoveryLoading: false,
          integrationDiscoveryError: '',
        })
        if (discovery.status === 'idle' || discovery.status === 'scanning') {
          this.scheduleIntegrationDiscoveryRefresh()
        } else if (discovery.status === 'complete') {
          this.integrationDiscoveryPolls = 0
        }
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
    const patch: Partial<ClientSnapshot> = { integrationPreferences: result }
    if (current) {
      patch.integrationManagement = applyManagementPreferences({
        ...current,
        meta: { ...current.meta, generatedAt: result.meta.generatedAt },
      }, result.preferences)
    }
    this.patch(patch)
    return result
  }

  async installIntegration(
    integrationId: string,
  ): Promise<IntegrationPackageOperationResponseDto> {
    const result = await this.api.installIntegration(integrationId)
    await this.refreshIntegrationManagement().catch(() => undefined)
    return result
  }

  async removeIntegration(
    integrationId: string,
  ): Promise<IntegrationPackageOperationResponseDto> {
    const result = await this.api.removeIntegration(integrationId)
    await this.refreshIntegrationManagement().catch(() => undefined)
    return result
  }

  async acknowledgeIntegration(integrationId: string): Promise<void> {
    const current = this.snapshot.integrationPreferences?.preferences ?? this.snapshot.integrationManagement?.preferences
    if (!current || current.acknowledgedIntegrationIds.includes(integrationId)) return
    await this.updateIntegrationPreferences({
      acknowledgedIntegrationIds: [...current.acknowledgedIntegrationIds, integrationId],
    })
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

  rescanIntegrationDiscovery(integrationId?: string): Promise<IntegrationToolDiscoveryResponseDto> {
    if (this.integrationDiscoveryInFlight) return this.integrationDiscoveryInFlight
    this.patch({ integrationDiscoveryRescanning: true, integrationDiscoveryError: '' })
    const pending = this.api.rescanIntegrationDiscovery(integrationId).then(
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

  async rescanAgentEnvironment({
    targetId,
    sourceId,
    integrationId,
  }: {
    targetId: string
    sourceId?: string
    integrationId?: string
  }): Promise<void> {
    this.patch({
      agentEnvironmentRescanTargetId: targetId,
      agentsRescanResult: null,
      agentsRescanError: '',
      integrationDiscoveryError: '',
    })
    const tasks: Promise<unknown>[] = []
    if (integrationId) tasks.push(this.rescanIntegrationDiscovery(integrationId))
    if (sourceId) tasks.push(this.rescanAgents(sourceId))
    if (!tasks.length) return

    const results = await Promise.allSettled(tasks)
    if (results.every(result => result.status === 'rejected')) {
      const failure = results[0]
      throw failure?.status === 'rejected' ? failure.reason : new Error('Agent environment rescan failed')
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

  ensureIntegrationManagement(): Promise<void> {
    if (this.snapshot.integrationManagement) {
      const status = this.snapshot.integrationManagement.discovery.status
      if (status === 'idle' || status === 'scanning') this.scheduleIntegrationDiscoveryRefresh()
      return Promise.resolve()
    }
    return this.refreshIntegrationManagement()
  }

  ensureAgents(): Promise<void> {
    if (this.snapshot.agentSummaries) return Promise.resolve()
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
      this.reviewRefreshDueAt = null
      return
    }
    if (this.reviewLiveDirty) this.scheduleReviewRefresh(0)
  }

  private scheduleReviewRefresh(delay?: number): void {
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

  private scheduleReviewSummaryPatch(logicalSessionId: string): void {
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

  private async flushReviewSummaryPatches(): Promise<void> {
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
      const detail = await this.api.reviewDetail(id, { direction: 'backward', limit: REVIEW_DETAIL_PAGE_SIZE, process: 'summary' })
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

      void this.api.relationships(id).then(
        relationships => {
          if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== id) return
          this.publish({
            ...this.snapshot,
            review: { ...this.snapshot.review, relationships, relationshipError: '' },
          })
        },
        reason => {
          if (generation !== this.detailGeneration || this.snapshot.review.selectedId !== id) return
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

  private onLiveEvent(event: LiveUpdateEventDto): void {
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

export const clientModel = new AgentLensClientModel()