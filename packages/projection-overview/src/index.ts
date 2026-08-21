import type { CapabilityService, SourceService, StorageService } from '@agent-lens/core'
import { TimelineProjection } from '@agent-lens/projection-timeline'
import { ToolAssetUsageProjection } from '@agent-lens/projection-usage'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type AgentOverviewResponseDto,
  type FacetResponseDto,
  type SessionRelationshipDto,
  type SessionRelationshipResponseDto,
} from '@agent-lens/protocol'

export class FacetProjection {
  constructor(private readonly storage: StorageService, private readonly sources?: SourceService) {}

  async query(): Promise<FacetResponseDto> {
    const definitions = this.sources?.list() ?? []
    const agents = await Promise.all(definitions.map(async definition => {
      const installations = await this.storage.repositories.installations.listByProduct(definition.manifest.productId)
      return {
        sourceId: definition.manifest.sourceId,
        productId: definition.manifest.productId,
        displayName: definition.manifest.displayName,
        supported: true,
        enabled: true,
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
  ) {
    this.usage = new ToolAssetUsageProjection(storage)
  }

  async query(): Promise<AgentOverviewResponseDto> {
    const definitions = this.sources?.list() ?? []
    const items = await Promise.all(definitions.map(async definition => {
      const installations = await this.storage.repositories.installations.listByProduct(definition.manifest.productId)
      const usedAssets = new Map<string, AgentOverviewResponseDto['items'][number]['usedAssets'][number]>()
      for (const installation of installations) {
        const usage = await this.usage.query({ installationId: installation.id, limit: 500 })
        for (const asset of usage.assets) {
          const key = `${asset.type}\u0000${asset.canonicalName}`
          const previous = usedAssets.get(key)
          usedAssets.set(key, previous ? {
            ...previous,
            callCount: previous.callCount + asset.callCount,
            firstUsedAt: previous.firstUsedAt < asset.firstUsedAt ? previous.firstUsedAt : asset.firstUsedAt,
            lastUsedAt: previous.lastUsedAt > asset.lastUsedAt ? previous.lastUsedAt : asset.lastUsedAt,
          } : {
            type: asset.type, canonicalName: asset.canonicalName, callCount: asset.callCount,
            firstUsedAt: asset.firstUsedAt, lastUsedAt: asset.lastUsedAt, confidence: asset.confidence,
          })
        }
      }
      return {
        sourceId: definition.manifest.sourceId,
        productId: definition.manifest.productId,
        displayName: definition.manifest.displayName,
        supported: true,
        enabled: true,
        detected: installations.length > 0,
        installations: installations.map(item => ({
          id: item.id, ...(item.version ? { version: item.version } : {}),
          ...(item.executable ? { executable: item.executable } : {}),
          ...(item.configRoot ? { configRoot: item.configRoot } : {}),
          ...(item.dataRoot ? { dataRoot: item.dataRoot } : {}),
          firstSeenAt: item.firstSeenAt, lastSeenAt: item.lastSeenAt,
        })),
        capabilities: (this.capabilities?.listForSource(definition.manifest.sourceId) ?? []).map(item => ({
          name: item.name, status: item.status, captureModes: item.captureModes, ...(item.reason ? { reason: item.reason } : {}),
        })),
        usedAssets: [...usedAssets.values()].sort((a, b) => b.callCount - a.callCount || a.canonicalName.localeCompare(b.canonicalName)),
        assetInventoryStatus: 'usage-only' as const,
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
      id: item.id, fromSessionId: item.fromSessionId, toSessionId: item.toSessionId,
      type: item.type, confidence: item.confidence,
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
        type: 'native-parent', confidence: 'high',
        fromNativeSessionId: source.nativeParentSessionId,
        toNativeSessionId: source.nativeSessionId,
      })
    }
    const dedup = new Map(items.map(item => [item.id, item]))
    return { items: [...dedup.values()], meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: new Date().toISOString() } }
  }
}
