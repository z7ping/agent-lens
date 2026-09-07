import type {
  AssetInventoryEntry,
  CapabilityService,
  CapturePolicyService,
  ObservationCursor,
  SessionSummaryCursor,
  SessionSummaryFacetScope,
  SourceService,
  StorageService,
} from '@agent-lens/core'
import { TimelineProjection } from '@agent-lens/projection-timeline'
import { ToolAssetUsageProjection } from '@agent-lens/projection-usage'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type AgentAssetInventoryDto,
  type AgentAssetStateDto,
  type AgentOverviewResponseDto,
  type FacetResponseDto,
  type SessionRelationshipDto,
  type SessionRelationshipResponseDto,
} from '@agent-lens/protocol'

const FACET_SESSION_PAGE_SIZE = 500
const FACET_OBSERVATION_PAGE_SIZE = 5000
const FACET_SCOPE_CACHE_MS = 10_000
const FACET_RESPONSE_CACHE_MS = 2_000
const AGENT_OVERVIEW_CACHE_MS = 2_000
const SLOW_OVERVIEW_PHASE_MS = 500

type FastFacetScope = SessionSummaryFacetScope

function logSlowOverviewPhase(phase: string, startedAt: number, details: Record<string, number | string> = {}): void {
  const elapsedMs = performance.now() - startedAt
  if (elapsedMs < SLOW_OVERVIEW_PHASE_MS) return
  console.warn('[AgentLens] Overview slow phase', { phase, elapsedMs: Math.round(elapsedMs), ...details })
}

function latestStates(entry: AssetInventoryEntry): AgentAssetStateDto[] {
  const latest = new Map<string, AgentAssetStateDto>()
  for (const state of entry.states) {
    if (latest.has(state.state)) continue
    latest.set(state.state, {
      state: state.state,
      value: state.value,
      observedAt: state.observedAt,
      evidenceCount: state.evidenceRefs.length,
    })
  }
  return [...latest.values()].sort((a, b) => a.state.localeCompare(b.state))
}

function sourceEnabled(policy: CapturePolicyService | undefined, sourceId: string): boolean {
  return policy ? policy.isSourceEnabled(sourceId) : true
}

function updateFacetRange(range: { from?: string; to?: string }, from: string, to = from): void {
  if (!range.from || from < range.from) range.from = from
  if (!range.to || to > range.to) range.to = to
}

async function loadFacetScopeFallback(storage: StorageService): Promise<{
  projectIds: string[]
  from?: string
  to?: string
}> {
  const projectIds = new Set<string>()
  const range: { from?: string; to?: string } = {}

  if (storage.sessionSummaries) {
    let after: SessionSummaryCursor | undefined
    while (true) {
      const page = await storage.sessionSummaries.query({
        limit: FACET_SESSION_PAGE_SIZE,
        ...(after ? { after } : {}),
      })
      for (const session of page.items) {
        if (session.projectId) projectIds.add(session.projectId)
        updateFacetRange(range, session.startedAt, session.endedAt)
      }
      if (!page.hasMore) break
      const last = page.items.at(-1)
      if (!last) break
      after = { activeAt: last.endedAt, logicalSessionId: last.logicalSessionId }
    }
    return { projectIds: [...projectIds], ...range }
  }

  let after: ObservationCursor | undefined
  while (true) {
    const observations = await storage.repositories.observations.query({
      order: 'asc',
      ...(after ? { after } : {}),
      limit: FACET_OBSERVATION_PAGE_SIZE,
    })
    if (!observations.length) break
    for (const observation of observations) {
      if (observation.projectId) projectIds.add(observation.projectId)
      const at = observation.occurredAt ?? observation.capturedAt
      updateFacetRange(range, at)
    }
    if (observations.length < FACET_OBSERVATION_PAGE_SIZE) break
    const last = observations.at(-1)!
    const sequence = last.canonicalSequence ?? last.sourceSequence
    after = {
      effectiveAt: last.occurredAt ?? last.capturedAt,
      ...(sequence === undefined ? {} : { sequence }),
      id: last.id,
    }
  }
  return { projectIds: [...projectIds], ...range }
}

function fastFacetScope(storage: StorageService): (() => Promise<FastFacetScope>) | undefined {
  const facetScope = storage.sessionSummaryProjection?.facetScope
  return facetScope ? () => facetScope.call(storage.sessionSummaryProjection) : undefined
}

export class FacetProjection {
  private cachedScope: FastFacetScope | null = null
  private cachedScopeAt = 0
  private cachedResponse: FacetResponseDto | null = null
  private cachedResponseAt = 0
  private queryInFlight: Promise<FacetResponseDto> | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly sources?: SourceService,
    private readonly capturePolicy?: CapturePolicyService,
  ) {}

  private async scope(): Promise<FastFacetScope> {
    if (this.cachedScope && Date.now() - this.cachedScopeAt < FACET_SCOPE_CACHE_MS) return this.cachedScope
    const startedAt = performance.now()
    const fast = fastFacetScope(this.storage)
    if (fast) {
      const scope = await fast()
      this.cachedScope = scope
      this.cachedScopeAt = Date.now()
      logSlowOverviewPhase('facet-scope', startedAt, { projects: scope.projects.length, source: 'projection' })
      return scope
    }

    const fallback = await loadFacetScopeFallback(this.storage)
    const projects = (await Promise.all(fallback.projectIds.map(id => this.storage.repositories.sessions.getProject(id))))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map(item => ({
        id: item.id,
        ...(item.name ? { name: item.name } : {}),
        ...(item.repositoryIdentity ? { repositoryIdentity: item.repositoryIdentity } : {}),
      }))
    const scope = {
      projects,
      ...(fallback.from ? { from: fallback.from } : {}),
      ...(fallback.to ? { to: fallback.to } : {}),
    }
    this.cachedScope = scope
    this.cachedScopeAt = Date.now()
    logSlowOverviewPhase('facet-scope', startedAt, { projects: scope.projects.length, source: 'fallback' })
    return scope
  }

  query(): Promise<FacetResponseDto> {
    if (this.cachedResponse && Date.now() - this.cachedResponseAt < FACET_RESPONSE_CACHE_MS) {
      return Promise.resolve(this.cachedResponse)
    }
    if (this.queryInFlight) return this.queryInFlight
    this.queryInFlight = this.buildResponse()
      .then(response => {
        this.cachedResponse = response
        this.cachedResponseAt = Date.now()
        return response
      })
      .finally(() => { this.queryInFlight = null })
    return this.queryInFlight
  }

  private async buildResponse(): Promise<FacetResponseDto> {
    const definitions = this.sources?.list() ?? []
    const agents = await Promise.all(definitions.map(async definition => {
      const installations = await this.storage.repositories.installations.listByProduct(definition.manifest.productId)
      return {
        sourceId: definition.manifest.sourceId,
        productId: definition.manifest.productId,
        displayName: definition.manifest.displayName,
        supported: true,
        enabled: sourceEnabled(this.capturePolicy, definition.manifest.sourceId),
        detected: installations.length > 0,
        installationIds: installations.map(item => item.id),
      }
    }))

    const scope = await this.scope()
    const projects = [...scope.projects]
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))

    return {
      agents: agents.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      projects,
      dateRange: { ...(scope.from ? { from: scope.from } : {}), ...(scope.to ? { to: scope.to } : {}) },
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: new Date().toISOString() },
    }
  }
}

export class AgentOverviewProjection {
  private readonly usage: ToolAssetUsageProjection
  private cachedResponse: AgentOverviewResponseDto | null = null
  private cachedResponseAt = 0
  private queryInFlight: Promise<AgentOverviewResponseDto> | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly sources?: SourceService,
    private readonly capabilities?: CapabilityService,
    private readonly capturePolicy?: CapturePolicyService,
  ) {
    this.usage = new ToolAssetUsageProjection(storage)
  }

  query(): Promise<AgentOverviewResponseDto> {
    if (this.cachedResponse && Date.now() - this.cachedResponseAt < AGENT_OVERVIEW_CACHE_MS) {
      return Promise.resolve(this.cachedResponse)
    }
    if (this.queryInFlight) return this.queryInFlight
    this.queryInFlight = this.buildResponse()
      .then(response => {
        this.cachedResponse = response
        this.cachedResponseAt = Date.now()
        return response
      })
      .finally(() => { this.queryInFlight = null })
    return this.queryInFlight
  }

  private async buildResponse(): Promise<AgentOverviewResponseDto> {
    const startedAt = performance.now()
    const definitions = this.sources?.list() ?? []
    const items = await Promise.all(definitions.map(async definition => {
      const sourceStartedAt = performance.now()
      const installations = await this.storage.repositories.installations.listByProduct(definition.manifest.productId)
      const usedAssets = new Map<string, AgentOverviewResponseDto['items'][number]['usedAssets'][number]>()
      const inventory = new Map<string, AgentAssetInventoryDto>()

      const assets = await this.usage.queryAssets({ sourceId: definition.manifest.sourceId })
      for (const asset of assets) {
        const key = `${asset.type}\u0000${asset.canonicalName}`
        usedAssets.set(key, {
          type: asset.type,
          canonicalName: asset.canonicalName,
          callCount: asset.callCount,
          firstUsedAt: asset.firstUsedAt,
          lastUsedAt: asset.lastUsedAt,
          confidence: asset.confidence,
        })
      }

      const inventoryPages = this.storage.assetInventory
        ? await Promise.all(installations.map(installation => this.storage.assetInventory!.listByInstallation(installation.id)))
        : []
      for (const entries of inventoryPages) {
        for (const entry of entries) {
          let asset = inventory.get(entry.definition.id)
          if (!asset) {
            asset = {
              id: entry.definition.id,
              type: entry.definition.type,
              canonicalName: entry.definition.canonicalName,
              ...(entry.definition.displayName ? { displayName: entry.definition.displayName } : {}),
              ...(entry.definition.upstreamIdentity ? { upstreamIdentity: entry.definition.upstreamIdentity } : {}),
              bindings: [],
            }
            inventory.set(entry.definition.id, asset)
          }
          asset.bindings.push({
            id: entry.binding.id,
            installationId: entry.binding.installationId,
            ...(entry.binding.path ? { path: entry.binding.path } : {}),
            ...(entry.binding.source ? { source: entry.binding.source } : {}),
            ...(entry.binding.version ? { version: entry.binding.version } : {}),
            states: latestStates(entry),
          })
        }
      }

      const assetInventory = [...inventory.values()]
      for (const asset of assetInventory) {
        asset.bindings.sort((a, b) => (a.path ?? a.source ?? a.id).localeCompare(b.path ?? b.source ?? b.id))
      }
      assetInventory.sort((a, b) => a.type.localeCompare(b.type)
        || (a.displayName ?? a.canonicalName).localeCompare(b.displayName ?? b.canonicalName))

      const item = {
        sourceId: definition.manifest.sourceId,
        productId: definition.manifest.productId,
        displayName: definition.manifest.displayName,
        supported: true,
        enabled: sourceEnabled(this.capturePolicy, definition.manifest.sourceId),
        detected: installations.length > 0,
        installations: installations.map(item => ({
          id: item.id,
          ...(item.version ? { version: item.version } : {}),
          ...(item.executable ? { executable: item.executable } : {}),
          ...(item.configRoot ? { configRoot: item.configRoot } : {}),
          ...(item.dataRoot ? { dataRoot: item.dataRoot } : {}),
          firstSeenAt: item.firstSeenAt,
          lastSeenAt: item.lastSeenAt,
        })),
        capabilities: (this.capabilities?.listForSource(definition.manifest.sourceId) ?? []).map(item => ({
          name: item.name,
          status: item.status,
          captureModes: item.captureModes,
          ...(item.reason ? { reason: item.reason } : {}),
        })),
        assetInventory,
        usedAssets: [...usedAssets.values()].sort((a, b) => b.callCount - a.callCount || a.canonicalName.localeCompare(b.canonicalName)),
        assetInventoryStatus: this.storage.assetInventory ? 'available' as const : 'unavailable' as const,
      }
      logSlowOverviewPhase('agent-source', sourceStartedAt, {
        sourceId: definition.manifest.sourceId,
        installations: installations.length,
        usedAssets: usedAssets.size,
        inventoryAssets: assetInventory.length,
      })
      return item
    }))
    logSlowOverviewPhase('agent-overview-total', startedAt, { sources: definitions.length, items: items.length })
    return { items, meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: new Date().toISOString() } }
  }
}

export class SessionRelationshipProjection {
  private readonly timeline: TimelineProjection
  constructor(private readonly storage: StorageService) { this.timeline = new TimelineProjection(storage) }

  async query(logicalSessionId: string): Promise<SessionRelationshipResponseDto> {
    const canonical = await this.storage.repositories.sessions.listRelationships(logicalSessionId)
    const items: SessionRelationshipDto[] = canonical.map(item => ({
      id: item.id,
      fromSessionId: item.fromSessionId,
      toSessionId: item.toSessionId,
      type: item.type,
      confidence: item.confidence,
    }))

    const timeline = await this.timeline.query({ logicalSessionId, limit: 1000 })
    const sourceSessionIds = [...new Set(timeline.items.map(item => item.sourceSessionId))]
    for (const id of sourceSessionIds) {
      const source = await this.storage.repositories.sessions.getSourceSession(id)
      if (!source?.nativeParentSessionId) continue
      items.push({
        id: `native-parent:${source.id}`,
        sourceId: source.sourceId,
        fromSessionId: source.nativeParentSessionId,
        toSessionId: logicalSessionId,
        type: 'native-parent',
        confidence: 'high',
        fromNativeSessionId: source.nativeParentSessionId,
        toNativeSessionId: source.nativeSessionId,
      })
    }
    const dedup = new Map(items.map(item => [item.id, item]))
    return { items: [...dedup.values()], meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: new Date().toISOString() } }
  }
}

export const projectionOverviewInternals = {
  FACET_SCOPE_CACHE_MS,
  FACET_RESPONSE_CACHE_MS,
  AGENT_OVERVIEW_CACHE_MS,
  fastFacetScope,
}
