import type {
  AgentInstallation,
  CanonicalObservation,
  ObservationCursor,
  SourceSession,
  StorageService,
} from '@agent-lens/core'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type AssetUsageDto,
  type ToolAssetUsageQueryDto,
  type ToolAssetUsageResponseDto,
  type ToolUsageDto,
  type UsageAssetType,
} from '@agent-lens/protocol'

const SCAN_CHUNK = 1000
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) { const value = record[name]; if (typeof value === 'string' && value) return value }
  return undefined
}
function effectiveAt(observation: CanonicalObservation): string { return observation.occurredAt ?? observation.capturedAt }
function cursorForObservation(observation: CanonicalObservation): ObservationCursor {
  const sequence = observation.canonicalSequence ?? observation.sourceSequence
  return {
    effectiveAt: effectiveAt(observation),
    ...(sequence === undefined ? {} : { sequence }),
    id: observation.id,
  }
}
function callId(observation: CanonicalObservation): string | undefined { return stringField(asRecord(observation.payload), 'callId', 'call_id', 'toolUseId', 'tool_use_id') }
function toolName(observation: CanonicalObservation): string | undefined { return stringField(asRecord(observation.payload), 'nativeToolName', 'toolName', 'tool_name', 'name') }
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
  nativeToolName: string; sourceIds: Set<string>; productIds: Set<string>; sessionIds: Set<string>
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

export class ToolAssetUsageProjection {
  constructor(private readonly storage: StorageService) {}

  private async loadKind(
    kind: 'tool.call' | 'tool.result',
    query: ToolAssetUsageQueryDto,
  ): Promise<CanonicalObservation[]> {
    const observations: CanonicalObservation[] = []
    let after: ObservationCursor | undefined
    while (true) {
      const page = await this.storage.repositories.observations.query({
        kind,
        ...(query.installationId ? { installationId: query.installationId } : {}),
        ...(query.logicalSessionId ? { logicalSessionId: query.logicalSessionId } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        ...(after ? { after } : {}),
        limit: SCAN_CHUNK,
      })
      if (!page.length) break
      observations.push(...page)
      if (page.length < SCAN_CHUNK) break
      after = cursorForObservation(page[page.length - 1]!)
    }
    return observations
  }

  async query(query: ToolAssetUsageQueryDto = {}): Promise<ToolAssetUsageResponseDto> {
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
    const [calls, results] = await Promise.all([
      this.loadKind('tool.call', query),
      this.loadKind('tool.result', query),
    ])
    const observations = [...calls, ...results]
      .filter(item => !query.projectId || item.projectId === query.projectId)

    const sourceSessionCache = new Map<string, SourceSession | null>()
    const installationCache = new Map<string, AgentInstallation | null>()
    const metadataCache = new Map<string, ObservationMetadata | null>()
    const metadataFor = async (observation: CanonicalObservation): Promise<ObservationMetadata | null> => {
      const cached = metadataCache.get(observation.id); if (cached !== undefined) return cached
      let sourceSession = sourceSessionCache.get(observation.sourceSessionId)
      if (sourceSession === undefined) { sourceSession = await this.storage.repositories.sessions.getSourceSession(observation.sourceSessionId); sourceSessionCache.set(observation.sourceSessionId, sourceSession) }
      let installation = installationCache.get(observation.installationId)
      if (installation === undefined) { installation = await this.storage.repositories.installations.get(observation.installationId); installationCache.set(observation.installationId, installation) }
      const metadata = sourceSession && installation ? { sourceId: sourceSession.sourceId, productId: installation.productId } : null
      metadataCache.set(observation.id, metadata); return metadata
    }

    const callsByIdentity = new Map<string, { name: string; sourceId: string; productId: string }>()
    for (const observation of observations) {
      if (observation.kind !== 'tool.call') continue
      const metadata = await metadataFor(observation); const id = callId(observation); const name = toolName(observation)
      if (!metadata || !id || !name || (query.sourceId && metadata.sourceId !== query.sourceId)) continue
      callsByIdentity.set(`${observation.logicalSessionId}\u0000${id}`, { name, sourceId: metadata.sourceId, productId: metadata.productId })
    }

    const tools = new Map<string, ToolAccumulator>(); const assets = new Map<string, AssetAccumulator>(); let unattributedToolCalls = 0
    for (const observation of observations) {
      const metadata = await metadataFor(observation); if (!metadata) continue
      const payload = asRecord(observation.payload); const identity = callId(observation)
      const linkedCall = identity ? callsByIdentity.get(`${observation.logicalSessionId}\u0000${identity}`) : undefined
      const name = toolName(observation) ?? linkedCall?.name; if (!name) continue
      const sourceId = linkedCall?.sourceId ?? metadata.sourceId; if (query.sourceId && sourceId !== query.sourceId) continue
      const productId = linkedCall?.productId ?? metadata.productId; const at = effectiveAt(observation); const key = `${sourceId}\u0000${name}`
      let tool = tools.get(key)
      if (!tool) {
        tool = { nativeToolName: name, sourceIds: new Set(), productIds: new Set(), sessionIds: new Set(), callCount: 0, resultCount: 0, successCount: 0, errorCount: 0, totalDurationMs: 0, firstUsedAt: at, lastUsedAt: at, observationIds: [] }
        tools.set(key, tool)
      }
      tool.sourceIds.add(sourceId); tool.productIds.add(productId); tool.sessionIds.add(observation.logicalSessionId); tool.observationIds.push(observation.id); updateWindow(tool, at)
      if (observation.kind === 'tool.call') {
        tool.callCount += 1; const inferred = inferAssetUsage(name, payload)
        if (!inferred) unattributedToolCalls += 1
        else {
          const assetKey = `${inferred.type}\u0000${inferred.canonicalName}`; let asset = assets.get(assetKey)
          if (!asset) { asset = { type: inferred.type, canonicalName: inferred.canonicalName, sourceIds: new Set(), callCount: 0, firstUsedAt: at, lastUsedAt: at, observationIds: [] }; assets.set(assetKey, asset) }
          asset.sourceIds.add(sourceId); asset.callCount += 1; asset.observationIds.push(observation.id); updateWindow(asset, at)
        }
      } else {
        tool.resultCount += 1; const success = payload.success
        if (success === false) tool.errorCount += 1; else if (success === true) tool.successCount += 1
        const duration = payload.durationMs ?? payload.duration_ms
        if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) tool.totalDurationMs += duration
      }
    }

    const toolDtos: ToolUsageDto[] = [...tools.values()].map(item => ({
      nativeToolName: item.nativeToolName, sourceIds: [...item.sourceIds].sort(), productIds: [...item.productIds].sort(),
      callCount: item.callCount, resultCount: item.resultCount, successCount: item.successCount, errorCount: item.errorCount,
      sessionCount: item.sessionIds.size, totalDurationMs: item.totalDurationMs,
      averageDurationMs: item.resultCount ? Math.round(item.totalDurationMs / item.resultCount) : 0,
      firstUsedAt: item.firstUsedAt, lastUsedAt: item.lastUsedAt, observationIds: item.observationIds,
    }))
    toolDtos.sort((a, b) => b.callCount - a.callCount || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.nativeToolName.localeCompare(b.nativeToolName))
    const assetDtos: AssetUsageDto[] = [...assets.values()].map(item => ({
      type: item.type, canonicalName: item.canonicalName, sourceIds: [...item.sourceIds].sort(), callCount: item.callCount,
      firstUsedAt: item.firstUsedAt, lastUsedAt: item.lastUsedAt, attribution: 'derived', confidence: 'high', observationIds: item.observationIds,
    }))
    assetDtos.sort((a, b) => b.callCount - a.callCount || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.canonicalName.localeCompare(b.canonicalName))
    const hasMoreTools = toolDtos.length > limit; const limitedTools = toolDtos.slice(0, limit)
    return { tools: limitedTools, assets: assetDtos, meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, toolCount: limitedTools.length, assetCount: assetDtos.length, unattributedToolCalls, hasMoreTools, generatedAt: new Date().toISOString() } }
  }
}

export const usageProjectionInternals = { inferAssetUsage, callId, toolName }
