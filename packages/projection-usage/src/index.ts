import type {
  AgentInstallation,
  CanonicalObservation,
  ObservationCursor,
  SourceSession,
  StorageService,
  ToolUsageAggregateQuery,
  ToolUsageObservationReader,
  ToolUsageObservationRecord,
} from '@agent-lens/core'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type AssetUsageDto,
  type ToolAssetUsageQueryDto,
  type ToolAssetUsageResponseDto,
  type ToolUsageDto,
  type ToolUsageProjectionStatusDto,
  type UsageAssetType,
} from '@agent-lens/protocol'

const REPOSITORY_SCAN_CHUNK = 1000
const LIGHT_SCAN_CHUNK = 5000
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const MAX_DETAIL_OBSERVATION_IDS = 100
const MAX_DETAIL_SESSIONS = 100
const AGGREGATE_OVERVIEW_DETAIL_LIMIT = 0
const AGGREGATE_DETAIL_LIMIT = 5
const AGGREGATE_ASSET_DETAIL_LIMIT = 0
const PROJECTION_STATUS_CACHE_MS = 1_000

type UsageObservation = CanonicalObservation | ToolUsageObservationRecord

type ToolUsageFactCoverage = {
  sourceObservationCount: number
  projectedCount: number
  missingCount: number
  coverageRatio: number
  ready: boolean
}

type ProjectionBackfillStatusReader = {
  toolUsageFactCoverage(): Promise<ToolUsageFactCoverage>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) { const value = record[name]; if (typeof value === 'string' && value) return value }
  return undefined
}
function effectiveAt(observation: UsageObservation): string { return observation.occurredAt ?? observation.capturedAt }
function cursorForObservation(observation: UsageObservation): ObservationCursor {
  const sequence = observation.canonicalSequence ?? observation.sourceSequence
  return {
    effectiveAt: effectiveAt(observation),
    ...(sequence === undefined ? {} : { sequence }),
    id: observation.id,
  }
}
function callId(observation: UsageObservation): string | undefined { return stringField(asRecord(observation.payload), 'callId', 'call_id', 'toolUseId', 'tool_use_id') }
function toolName(observation: UsageObservation): string | undefined { return stringField(asRecord(observation.payload), 'nativeToolName', 'toolName', 'tool_name', 'name') }
function inferAssetUsage(nativeToolName: string, payload: Record<string, unknown>): { type: UsageAssetType; canonicalName: string } | null {
  const mcp = nativeToolName.match(/^mcp__(.+?)__(.+)$/i)
  if (mcp?.[1]) return { type: 'mcp', canonicalName: mcp[1] }
  if (nativeToolName.toLowerCase() === 'skill') {
    const input = asRecord(payload.input); const skill = stringField(input, 'skill', 'name')
    if (skill) return { type: 'skill', canonicalName: skill }
  }
  return null
}

interface ObservationMetadata { sourceId: string; productId: string }
interface ToolAccumulator {
  nativeToolName: string; sourceIds: Set<string>; productIds: Set<string>; sessionCalls: Map<string, number>
  callCount: number; resultCount: number; successCount: number; errorCount: number; totalDurationMs: number
  firstUsedAt: string; lastUsedAt: string; observationIds: string[]
}
interface AssetAccumulator {
  type: UsageAssetType; canonicalName: string; sourceIds: Set<string>; callCount: number
  firstUsedAt: string; lastUsedAt: string; observationIds: string[]
}
function updateWindow(accumulator: { firstUsedAt: string; lastUsedAt: string }, at: string): void {
  if (at < accumulator.firstUsedAt) accumulator.firstUsedAt = at
  if (at > accumulator.lastUsedAt) accumulator.lastUsedAt = at
}
function pushObservationSample(ids: string[], id: string): void {
  if (ids.length < MAX_DETAIL_OBSERVATION_IDS) ids.push(id)
}
function usageReader(storage: StorageService): ToolUsageObservationReader | undefined {
  return (storage as StorageService & { readonly toolUsageObservations?: ToolUsageObservationReader }).toolUsageObservations
}
function projectionStatusReader(storage: StorageService): ProjectionBackfillStatusReader | undefined {
  return (storage as StorageService & { readonly projectionBackfill?: ProjectionBackfillStatusReader }).projectionBackfill
}
function aggregateQuery(query: ToolAssetUsageQueryDto, detailLimit = AGGREGATE_OVERVIEW_DETAIL_LIMIT): ToolUsageAggregateQuery {
  return {
    ...(query.installationId ? { installationId: query.installationId } : {}),
    ...(query.logicalSessionId ? { logicalSessionId: query.logicalSessionId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.sourceId ? { sourceId: query.sourceId } : {}),
    ...(query.toolName ? { toolName: query.toolName } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    detailLimit,
  }
}
function hasEmbeddedMetadata(observation: UsageObservation): observation is ToolUsageObservationRecord {
  return 'sourceId' in observation && 'productId' in observation
}

export class ToolAssetUsageProjection {
  private cachedProjectionStatus: ToolUsageProjectionStatusDto | null = null
  private cachedProjectionStatusAt = 0
  private projectionStatusInFlight: Promise<ToolUsageProjectionStatusDto | undefined> | null = null

  constructor(private readonly storage: StorageService) {}

  private projectionStatus(): Promise<ToolUsageProjectionStatusDto | undefined> {
    if (this.cachedProjectionStatus && Date.now() - this.cachedProjectionStatusAt < PROJECTION_STATUS_CACHE_MS) {
      return Promise.resolve(this.cachedProjectionStatus)
    }
    if (this.projectionStatusInFlight) return this.projectionStatusInFlight
    const reader = projectionStatusReader(this.storage)
    if (!reader) return Promise.resolve(undefined)
    this.projectionStatusInFlight = reader.toolUsageFactCoverage()
      .then(coverage => {
        const status: ToolUsageProjectionStatusDto = {
          state: coverage.ready ? 'ready' : 'partial',
          sourceObservationCount: coverage.sourceObservationCount,
          projectedCount: coverage.projectedCount,
          missingCount: coverage.missingCount,
          coverageRatio: coverage.coverageRatio,
        }
        this.cachedProjectionStatus = status
        this.cachedProjectionStatusAt = Date.now()
        return status
      })
      .finally(() => { this.projectionStatusInFlight = null })
    return this.projectionStatusInFlight
  }

  private async forEachKind(
    kind: 'tool.call' | 'tool.result',
    query: ToolAssetUsageQueryDto,
    visit: (observation: UsageObservation) => Promise<void> | void,
  ): Promise<void> {
    const reader = usageReader(this.storage)
    const scanChunk = reader ? LIGHT_SCAN_CHUNK : REPOSITORY_SCAN_CHUNK
    let after: ObservationCursor | undefined
    while (true) {
      const page = reader
        ? await reader.query({
            kind,
            ...(query.installationId ? { installationId: query.installationId } : {}),
            ...(query.logicalSessionId ? { logicalSessionId: query.logicalSessionId } : {}),
            ...(query.projectId ? { projectId: query.projectId } : {}),
            ...(query.sourceId ? { sourceId: query.sourceId } : {}),
            ...(query.from ? { from: query.from } : {}),
            ...(query.to ? { to: query.to } : {}),
            ...(after ? { after } : {}),
            limit: scanChunk,
          })
        : await this.storage.repositories.observations.query({
            kind,
            ...(query.installationId ? { installationId: query.installationId } : {}),
            ...(query.logicalSessionId ? { logicalSessionId: query.logicalSessionId } : {}),
            ...(query.from ? { from: query.from } : {}),
            ...(query.to ? { to: query.to } : {}),
            ...(after ? { after } : {}),
            limit: scanChunk,
          })
      if (!page.length) break
      for (const observation of page) {
        if (query.projectId && observation.projectId !== query.projectId) continue
        await visit(observation)
      }
      if (page.length < scanChunk) break
      after = cursorForObservation(page[page.length - 1]!)
    }
  }

  private metadataResolver() {
    const sourceSessionCache = new Map<string, SourceSession | null>()
    const installationCache = new Map<string, AgentInstallation | null>()
    const metadataCache = new Map<string, ObservationMetadata | null>()
    return async (observation: UsageObservation): Promise<ObservationMetadata | null> => {
      if (hasEmbeddedMetadata(observation)) return { sourceId: observation.sourceId, productId: observation.productId }
      const cached = metadataCache.get(observation.id); if (cached !== undefined) return cached
      let sourceSession = sourceSessionCache.get(observation.sourceSessionId)
      if (sourceSession === undefined) {
        sourceSession = await this.storage.repositories.sessions.getSourceSession(observation.sourceSessionId)
        sourceSessionCache.set(observation.sourceSessionId, sourceSession)
      }
      let installation = installationCache.get(observation.installationId)
      if (installation === undefined) {
        installation = await this.storage.repositories.installations.get(observation.installationId)
        installationCache.set(observation.installationId, installation)
      }
      const metadata = sourceSession && installation ? { sourceId: sourceSession.sourceId, productId: installation.productId } : null
      metadataCache.set(observation.id, metadata)
      return metadata
    }
  }

  async queryAssets(query: ToolAssetUsageQueryDto = {}): Promise<AssetUsageDto[]> {
    const reader = usageReader(this.storage)
    if (reader?.aggregate) {
      const aggregate = await reader.aggregate(aggregateQuery(query, AGGREGATE_ASSET_DETAIL_LIMIT))
      const result: AssetUsageDto[] = aggregate.assets.map(item => ({
        type: item.type,
        canonicalName: item.canonicalName,
        sourceIds: [...item.sourceIds].sort(),
        callCount: item.callCount,
        firstUsedAt: item.firstUsedAt,
        lastUsedAt: item.lastUsedAt,
        attribution: 'derived',
        confidence: 'high',
        observationIds: item.observationIds.slice(0, MAX_DETAIL_OBSERVATION_IDS),
      }))
      result.sort((a, b) => b.callCount - a.callCount || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.canonicalName.localeCompare(b.canonicalName))
      return result
    }

    const metadataFor = this.metadataResolver()
    const assets = new Map<string, AssetAccumulator>()

    await this.forEachKind('tool.call', query, async observation => {
      const metadata = await metadataFor(observation)
      if (!metadata || (query.sourceId && metadata.sourceId !== query.sourceId)) return
      const payload = asRecord(observation.payload)
      const name = toolName(observation)
      if (!name || (query.toolName && name !== query.toolName)) return
      const inferred = inferAssetUsage(name, payload)
      if (!inferred) return
      const at = effectiveAt(observation)
      const key = `${inferred.type}\u0000${inferred.canonicalName}`
      let asset = assets.get(key)
      if (!asset) {
        asset = { type: inferred.type, canonicalName: inferred.canonicalName, sourceIds: new Set(), callCount: 0, firstUsedAt: at, lastUsedAt: at, observationIds: [] }
        assets.set(key, asset)
      }
      asset.sourceIds.add(metadata.sourceId)
      asset.callCount += 1
      pushObservationSample(asset.observationIds, observation.id)
      updateWindow(asset, at)
    })

    const result: AssetUsageDto[] = [...assets.values()].map(item => ({
      type: item.type,
      canonicalName: item.canonicalName,
      sourceIds: [...item.sourceIds].sort(),
      callCount: item.callCount,
      firstUsedAt: item.firstUsedAt,
      lastUsedAt: item.lastUsedAt,
      attribution: 'derived',
      confidence: 'high',
      observationIds: item.observationIds,
    }))
    result.sort((a, b) => b.callCount - a.callCount || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.canonicalName.localeCompare(b.canonicalName))
    return result
  }

  async query(
    query: ToolAssetUsageQueryDto = {},
    detailLimit = AGGREGATE_OVERVIEW_DETAIL_LIMIT,
  ): Promise<ToolAssetUsageResponseDto> {
    const normalizedDetailLimit = Math.max(0, Math.min(detailLimit, MAX_DETAIL_SESSIONS, MAX_DETAIL_OBSERVATION_IDS))
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
    const reader = usageReader(this.storage)
    if (reader?.aggregate) {
      const [aggregate, projection] = await Promise.all([
        reader.aggregate(aggregateQuery(query, normalizedDetailLimit)),
        this.projectionStatus(),
      ])
      const toolDtos: ToolUsageDto[] = aggregate.tools.map(item => ({
        nativeToolName: item.nativeToolName,
        sourceIds: [...item.sourceIds].sort(),
        productIds: [...item.productIds].sort(),
        callCount: item.callCount,
        resultCount: item.resultCount,
        successCount: item.successCount,
        errorCount: item.errorCount,
        sessionCount: item.sessionCount,
        sessions: normalizedDetailLimit > 0
          ? item.sessions
              .slice()
              .sort((a, b) => b.callCount - a.callCount || a.logicalSessionId.localeCompare(b.logicalSessionId))
              .slice(0, normalizedDetailLimit)
          : [],
        totalDurationMs: item.totalDurationMs,
        averageDurationMs: item.resultCount ? Math.round(item.totalDurationMs / item.resultCount) : 0,
        firstUsedAt: item.firstUsedAt,
        lastUsedAt: item.lastUsedAt,
        observationIds: normalizedDetailLimit > 0 ? item.observationIds.slice(0, normalizedDetailLimit) : [],
      }))
      toolDtos.sort((a, b) => b.callCount - a.callCount || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.nativeToolName.localeCompare(b.nativeToolName))

      const assetDtos: AssetUsageDto[] = aggregate.assets.map(item => ({
        type: item.type,
        canonicalName: item.canonicalName,
        sourceIds: [...item.sourceIds].sort(),
        callCount: item.callCount,
        firstUsedAt: item.firstUsedAt,
        lastUsedAt: item.lastUsedAt,
        attribution: 'derived',
        confidence: 'high',
        observationIds: normalizedDetailLimit > 0 ? item.observationIds.slice(0, normalizedDetailLimit) : [],
      }))
      assetDtos.sort((a, b) => b.callCount - a.callCount || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.canonicalName.localeCompare(b.canonicalName))

      const hasMoreTools = toolDtos.length > limit
      const limitedTools = toolDtos.slice(0, limit)
      return {
        tools: limitedTools,
        assets: assetDtos,
        meta: {
          protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
          toolCount: limitedTools.length,
          assetCount: assetDtos.length,
          unattributedToolCalls: aggregate.unattributedToolCalls,
          hasMoreTools,
          ...(projection ? { projection } : {}),
          generatedAt: new Date().toISOString(),
        },
      }
    }

    const metadataFor = this.metadataResolver()
    const callsByIdentity = new Map<string, { name: string; sourceId: string; productId: string }>()
    const tools = new Map<string, ToolAccumulator>()
    const assets = new Map<string, AssetAccumulator>()
    let unattributedToolCalls = 0

    await this.forEachKind('tool.call', query, async observation => {
      const metadata = await metadataFor(observation)
      if (!metadata || (query.sourceId && metadata.sourceId !== query.sourceId)) return
      const payload = asRecord(observation.payload)
      const identity = callId(observation)
      const name = toolName(observation)
      if (!name || (query.toolName && name !== query.toolName)) return
      if (identity) callsByIdentity.set(`${observation.logicalSessionId}\u0000${identity}`, { name, sourceId: metadata.sourceId, productId: metadata.productId })

      const at = effectiveAt(observation)
      const key = `${metadata.sourceId}\u0000${name}`
      let tool = tools.get(key)
      if (!tool) {
        tool = { nativeToolName: name, sourceIds: new Set(), productIds: new Set(), sessionCalls: new Map(), callCount: 0, resultCount: 0, successCount: 0, errorCount: 0, totalDurationMs: 0, firstUsedAt: at, lastUsedAt: at, observationIds: [] }
        tools.set(key, tool)
      }
      tool.sourceIds.add(metadata.sourceId)
      tool.productIds.add(metadata.productId)
      pushObservationSample(tool.observationIds, observation.id)
      tool.callCount += 1
      tool.sessionCalls.set(observation.logicalSessionId, (tool.sessionCalls.get(observation.logicalSessionId) ?? 0) + 1)
      updateWindow(tool, at)

      const inferred = inferAssetUsage(name, payload)
      if (!inferred) {
        unattributedToolCalls += 1
        return
      }
      const assetKey = `${inferred.type}\u0000${inferred.canonicalName}`
      let asset = assets.get(assetKey)
      if (!asset) {
        asset = { type: inferred.type, canonicalName: inferred.canonicalName, sourceIds: new Set(), callCount: 0, firstUsedAt: at, lastUsedAt: at, observationIds: [] }
        assets.set(assetKey, asset)
      }
      asset.sourceIds.add(metadata.sourceId)
      asset.callCount += 1
      pushObservationSample(asset.observationIds, observation.id)
      updateWindow(asset, at)
    })

    await this.forEachKind('tool.result', query, async observation => {
      const metadata = await metadataFor(observation)
      if (!metadata) return
      const payload = asRecord(observation.payload)
      const identity = callId(observation)
      const linkedCall = identity ? callsByIdentity.get(`${observation.logicalSessionId}\u0000${identity}`) : undefined
      const name = toolName(observation) ?? linkedCall?.name
      if (!name || (query.toolName && name !== query.toolName)) return
      const sourceId = linkedCall?.sourceId ?? metadata.sourceId
      if (query.sourceId && sourceId !== query.sourceId) return
      const productId = linkedCall?.productId ?? metadata.productId
      const at = effectiveAt(observation)
      const key = `${sourceId}\u0000${name}`
      let tool = tools.get(key)
      if (!tool) {
        tool = { nativeToolName: name, sourceIds: new Set(), productIds: new Set(), sessionCalls: new Map(), callCount: 0, resultCount: 0, successCount: 0, errorCount: 0, totalDurationMs: 0, firstUsedAt: at, lastUsedAt: at, observationIds: [] }
        tools.set(key, tool)
      }
      tool.sourceIds.add(sourceId)
      tool.productIds.add(productId)
      pushObservationSample(tool.observationIds, observation.id)
      tool.resultCount += 1
      updateWindow(tool, at)
      const success = payload.success
      if (success === false) tool.errorCount += 1
      else if (success === true) tool.successCount += 1
      const duration = payload.durationMs ?? payload.duration_ms
      if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) tool.totalDurationMs += duration
    })

    const toolDtos: ToolUsageDto[] = [...tools.values()].map(item => ({
      nativeToolName: item.nativeToolName,
      sourceIds: [...item.sourceIds].sort(),
      productIds: [...item.productIds].sort(),
      callCount: item.callCount,
      resultCount: item.resultCount,
      successCount: item.successCount,
      errorCount: item.errorCount,
      sessionCount: item.sessionCalls.size,
      sessions: normalizedDetailLimit > 0
        ? [...item.sessionCalls.entries()]
            .map(([logicalSessionId, callCount]) => ({ logicalSessionId, callCount }))
            .sort((a, b) => b.callCount - a.callCount || a.logicalSessionId.localeCompare(b.logicalSessionId))
            .slice(0, normalizedDetailLimit)
        : [],
      totalDurationMs: item.totalDurationMs,
      averageDurationMs: item.resultCount ? Math.round(item.totalDurationMs / item.resultCount) : 0,
      firstUsedAt: item.firstUsedAt,
      lastUsedAt: item.lastUsedAt,
      observationIds: normalizedDetailLimit > 0 ? item.observationIds.slice(0, normalizedDetailLimit) : [],
    }))
    toolDtos.sort((a, b) => b.callCount - a.callCount || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.nativeToolName.localeCompare(b.nativeToolName))

    const assetDtos: AssetUsageDto[] = [...assets.values()].map(item => ({
      type: item.type,
      canonicalName: item.canonicalName,
      sourceIds: [...item.sourceIds].sort(),
      callCount: item.callCount,
      firstUsedAt: item.firstUsedAt,
      lastUsedAt: item.lastUsedAt,
      attribution: 'derived',
      confidence: 'high',
      observationIds: normalizedDetailLimit > 0 ? item.observationIds.slice(0, normalizedDetailLimit) : [],
    }))
    assetDtos.sort((a, b) => b.callCount - a.callCount || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.canonicalName.localeCompare(b.canonicalName))

    const hasMoreTools = toolDtos.length > limit
    const limitedTools = toolDtos.slice(0, limit)
    return {
      tools: limitedTools,
      assets: assetDtos,
      meta: {
        protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
        toolCount: limitedTools.length,
        assetCount: assetDtos.length,
        unattributedToolCalls,
        hasMoreTools,
        generatedAt: new Date().toISOString(),
      },
    }
  }
}

export const usageProjectionInternals = {
  inferAssetUsage,
  callId,
  toolName,
  aggregateQuery,
  projectionStatusReader,
  aggregateOverviewDetailLimit: AGGREGATE_OVERVIEW_DETAIL_LIMIT,
  aggregateDetailLimit: AGGREGATE_DETAIL_LIMIT,
  aggregateAssetDetailLimit: AGGREGATE_ASSET_DETAIL_LIMIT,
  maxDetailObservationIds: MAX_DETAIL_OBSERVATION_IDS,
  maxDetailSessions: MAX_DETAIL_SESSIONS,
  projectionStatusCacheMs: PROJECTION_STATUS_CACHE_MS,
}
