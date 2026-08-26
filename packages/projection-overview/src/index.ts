import type {
  AssetInventoryEntry,
  CapabilityService,
  CapturePolicyService,
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

export class FacetProjection {
  constructor(
    private readonly storage: StorageService,
    private readonly sources?: SourceService,
    private readonly capturePolicy?: CapturePolicyService,
  ) {}

  async query(): Promise<FacetResponseDto> {
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

    const observations = await this.storage.repositories.observations.query({ limit: 5000 })
    const projectIds = [...new Set(observations.map(item => item.projectId).filter((id): id is string => Boolean(id)))]
    const projects = (await Promise.all(projectIds.map(id => this.storage.repositories.sessions.getProject(id))))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map(item => ({ id: item.id, ...(item.name ? { name: item.name } : {}), ...(item.repositoryIdentity ? { repositoryIdentity: item.repositoryIdentity } : {}) }))
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
    const times = observations.map(item => item.occurredAt ?? item.capturedAt).sort()

    return {
      agents: agents.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      projects,
      dateRange: { ...(times[0] ? { from: times[0] } : {}), ...(times.at(-1) ? { to: times.at(-1)! } : {}) },
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: new Date().toISOString() },
    }
  }
}

export class AgentOverviewProjection {
  private readonly usage: ToolAssetUsageProjection

  constructor(
    private readonly storage: StorageService,
    private readonly sources?: SourceService,
    private readonly capabilities?: CapabilityService,
    private readonly capturePolicy?: CapturePolicyService,
  ) {
    this.usage = new ToolAssetUsageProjection(storage)
  }

  async query(): Promise<AgentOverviewResponseDto> {
    const definitions = this.sources?.list() ?? []
    const items = await Promise.all(definitions.map(async definition => {
      const installations = await this.storage.repositories.installations.listByProduct(definition.manifest.productId)
      const usedAssets = new Map<string, AgentOverviewResponseDto['items'][number]['usedAssets'][number]>()
      const inventory = new Map<string, AgentAssetInventoryDto>()

      for (const installation of installations) {
        const assets = await this.usage.queryAssets({ installationId: installation.id })
        for (const asset of assets) {
          const key = `${asset.type}\u0000${asset.canonicalName}`
          const previous = usedAssets.get(key)
          usedAssets.set(key, previous ? {
            ...previous,
            callCount: previous.callCount + asset.callCount,
            firstUsedAt: previous.firstUsedAt < asset.firstUsedAt ? previous.firstUsedAt : asset.firstUsedAt,
            lastUsedAt: previous.lastUsedAt > asset.lastUsedAt ? previous.lastUsedAt : asset.lastUsedAt,
          } : {
            type: asset.type,
            canonicalName: asset.canonicalName,
            callCount: asset.callCount,
            firstUsedAt: asset.firstUsedAt,
            lastUsedAt: asset.lastUsedAt,
            confidence: asset.confidence,
          })
        }

        if (this.storage.assetInventory) {
          for (const entry of await this.storage.assetInventory.listByInstallation(installation.id)) {
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
      }

      const assetInventory = [...inventory.values()]
      for (const asset of assetInventory) {
        asset.bindings.sort((a, b) => (a.path ?? a.source ?? a.id).localeCompare(b.path ?? b.source ?? b.id))
      }
      assetInventory.sort((a, b) => a.type.localeCompare(b.type)
        || (a.displayName ?? a.canonicalName).localeCompare(b.displayName ?? b.canonicalName))

      return {
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
    }))
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
