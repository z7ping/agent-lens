import type { AgentCoverageResponseDto, AgentDetailResponseDto, AgentEnrichmentResponseDto, AgentOverviewResponseDto, AgentRescanResponseDto, AgentSummaryResponseDto, CapturePolicyResponseDto, FacetResponseDto, HealthResponseDto, HostFilePreviewResponseDto, IntegrationManagementResponseDto, IntegrationPreferencesResponseDto, IntegrationToolDiscoveryResponseDto, ManagedAssetDirectoryResponseDto, ManagedAssetFilePreviewResponseDto, ManagedAssetRoot, LiveUpdateEventDto, ReviewInteractionDto, ReviewMessageAttachmentDto, ReviewResponseDto, ReviewSessionDetailDto, SessionRelationshipResponseDto, SourceRecordResponseDto, TaskFileChangesResponseDto, ToolAssetUsageResponseDto } from '@agent-lens/protocol'
import { AgentLensApi, type QueryFilters, type ReviewFilters } from './api'
import { translateProduct } from '../i18n/runtime'

export function discoveryFromManagement(
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
export const INITIAL_REVIEW_LIMIT = 20
export const INTEGRATION_DISCOVERY_POLL_MS = 500
export const INTEGRATION_DISCOVERY_MAX_POLLS = 20
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

export abstract class AgentLensModelBase {
  protected abstract onLiveEvent(event: LiveUpdateEventDto): void
  protected abstract scheduleReviewRefresh(delay?: number): void
  protected abstract scheduleIntegrationDiscoveryRefresh(): void

  protected snapshot: ClientSnapshot = {
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
  protected readonly listeners = new Set<Listener>()
  protected readonly liveEventListeners = new Set<LiveEventListener>()
  protected notifyQueued = false
  protected refreshTimer: ReturnType<typeof setTimeout> | null = null
  protected reviewRefreshDueAt: number | null = null
  protected detailTimer: ReturnType<typeof setTimeout> | null = null
  protected reviewSearchTimer: ReturnType<typeof setTimeout> | null = null
  protected integrationDiscoveryTimer: ReturnType<typeof setTimeout> | null = null
  protected reviewInFlight: Promise<void> | null = null
  protected reviewRequestFilterKey = ''
  protected reviewRequestDirty = false
  protected reviewLiveDirty = false
  protected reviewPaginationDirty = false
  protected readonly pendingReviewSummaryIds = new Set<string>()
  protected reviewSummaryPatchTimer: ReturnType<typeof setTimeout> | null = null
  protected reviewActive = false
  protected facetsInFlight: Promise<void> | null = null
  protected agentsInFlight: Promise<void> | null = null
  protected readonly agentDetailInFlight = new Map<string, Promise<void>>()
  protected readonly agentEnrichmentInFlight = new Map<string, Promise<void>>()
  protected agentCoverageInFlight: Promise<void> | null = null
  protected agentsRescanInFlight: Promise<AgentRescanResponseDto> | null = null
  protected integrationDiscoveryInFlight: Promise<IntegrationToolDiscoveryResponseDto> | null = null
  protected integrationPreferencesInFlight: Promise<void> | null = null
  protected integrationManagementInFlight: Promise<void> | null = null
  protected integrationDiscoveryPolls = 0
  protected integrationDiscoveryActive = false
  protected visibilityListener: (() => void) | null = null
  protected unsubscribeLive: (() => void) | null = null
  protected reviewGeneration = 0
  protected detailGeneration = 0
  protected reviewSelectionAbort: AbortController | null = null
  protected usageGeneration = 0
  protected agentsGeneration = 0
  protected usageInvalidation = 0
  protected agentsInvalidation = 0

  constructor(protected readonly api = new AgentLensApi()) {}

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

  protected publish(next: ClientSnapshot): void {
    this.snapshot = next
    if (this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      for (const listener of this.listeners) listener()
    })
  }

  protected patch(patch: Partial<ClientSnapshot>): void {
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
    this.reviewSelectionAbort?.abort()
    this.reviewSelectionAbort = null
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

}
