import type {
  AgentInstallation,
  CanonicalObservation,
  Evidence,
  ObservationQuery,
  SourceLocator,
  SourceSession,
  StorageService,
} from '@agent-lens/core'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type JsonValue,
  type TimelineEvidenceDto,
  type TimelineItemDto,
  type TimelineQueryDto,
  type TimelineResponseDto,
  type TimelineSourceLocatorDto,
} from '@agent-lens/protocol'

const MAX_SCAN_ROWS = 5000
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 32) return '[max-depth]'
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) {
    return value.map(item => item === undefined ? null : toJsonValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
      result[key] = toJsonValue(item, depth + 1)
    }
    return result
  }
  return null
}

function mapLocator(locator: SourceLocator): TimelineSourceLocatorDto {
  return {
    kind: locator.kind,
    ...(locator.path ? { path: locator.path } : {}),
    ...(locator.offset === undefined ? {} : { offset: locator.offset }),
    ...(locator.rowId ? { rowId: locator.rowId } : {}),
    ...(locator.table ? { table: locator.table } : {}),
    ...(locator.hookEventId ? { hookEventId: locator.hookEventId } : {}),
  }
}

function mapEvidence(evidence: Evidence): TimelineEvidenceDto {
  return {
    id: evidence.id,
    captureMethod: evidence.captureMethod,
    derivation: evidence.derivation,
    confidence: evidence.confidence,
    ...(evidence.sourceRecordId ? { sourceRecordId: evidence.sourceRecordId } : {}),
    ...(evidence.sourceLocator ? { sourceLocator: mapLocator(evidence.sourceLocator) } : {}),
    ...(evidence.parserVersion ? { parserVersion: evidence.parserVersion } : {}),
    ...(evidence.eventTime ? { eventTime: evidence.eventTime } : {}),
    capturedAt: evidence.capturedAt,
    ...(evidence.missingReason ? { missingReason: evidence.missingReason } : {}),
  }
}

function effectiveTime(observation: CanonicalObservation): string {
  return observation.occurredAt ?? observation.capturedAt
}

function compareTimelineItems(left: TimelineItemDto, right: TimelineItemDto): number {
  const leftTime = Date.parse(left.effectiveAt)
  const rightTime = Date.parse(right.effectiveAt)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }
  if (left.effectiveAt !== right.effectiveAt) {
    return left.effectiveAt.localeCompare(right.effectiveAt)
  }
  const leftSequence = left.canonicalSequence ?? left.sourceSequence ?? Number.MAX_SAFE_INTEGER
  const rightSequence = right.canonicalSequence ?? right.sourceSequence ?? Number.MAX_SAFE_INTEGER
  if (leftSequence !== rightSequence) return leftSequence - rightSequence
  return left.id.localeCompare(right.id)
}

export class TimelineProjection {
  constructor(private readonly storage: StorageService) {}

  async query(query: TimelineQueryDto = {}): Promise<TimelineResponseDto> {
    const requestedLimit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
    const coreQuery: ObservationQuery = {
      ...(query.installationId ? { installationId: query.installationId } : {}),
      ...(query.logicalSessionId ? { logicalSessionId: query.logicalSessionId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      limit: MAX_SCAN_ROWS,
    }
    const observations = await this.storage.repositories.observations.query(coreQuery)

    const sourceSessionCache = new Map<string, SourceSession | null>()
    const installationCache = new Map<string, AgentInstallation | null>()

    const items = await Promise.all(observations.map(async observation => {
      let sourceSession = sourceSessionCache.get(observation.sourceSessionId)
      if (sourceSession === undefined) {
        sourceSession = await this.storage.repositories.sessions.getSourceSession(observation.sourceSessionId)
        sourceSessionCache.set(observation.sourceSessionId, sourceSession)
      }
      if (!sourceSession) {
        throw new Error(`Timeline projection integrity error: missing source session ${observation.sourceSessionId}`)
      }

      let installation = installationCache.get(observation.installationId)
      if (installation === undefined) {
        installation = await this.storage.repositories.installations.get(observation.installationId)
        installationCache.set(observation.installationId, installation)
      }
      if (!installation) {
        throw new Error(`Timeline projection integrity error: missing installation ${observation.installationId}`)
      }

      const evidence = await this.storage.repositories.evidence.listForObservation(observation.id)
      const item: TimelineItemDto = {
        id: observation.id,
        kind: observation.kind,
        sourceId: sourceSession.sourceId,
        productId: installation.productId,
        hostId: observation.hostId,
        installationId: observation.installationId,
        ...(observation.projectId ? { projectId: observation.projectId } : {}),
        ...(observation.workspaceId ? { workspaceId: observation.workspaceId } : {}),
        logicalSessionId: observation.logicalSessionId,
        sourceSessionId: observation.sourceSessionId,
        ...(observation.interactionId ? { interactionId: observation.interactionId } : {}),
        ...(observation.actorId ? { actorId: observation.actorId } : {}),
        ...(observation.sourceSequence === undefined ? {} : { sourceSequence: observation.sourceSequence }),
        ...(observation.canonicalSequence === undefined ? {} : { canonicalSequence: observation.canonicalSequence }),
        ...(observation.occurredAt ? { occurredAt: observation.occurredAt } : {}),
        capturedAt: observation.capturedAt,
        effectiveAt: effectiveTime(observation),
        payload: toJsonValue(observation.payload),
        evidence: evidence.map(mapEvidence),
      }
      return item
    }))

    items.sort(compareTimelineItems)
    const hasMore = items.length > requestedLimit
    const limited = items.slice(0, requestedLimit)

    return {
      items: limited,
      meta: {
        protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
        count: limited.length,
        hasMore,
        generatedAt: new Date().toISOString(),
      },
    }
  }
}

export const timelineProjectionInternals = {
  toJsonValue,
  compareTimelineItems,
}
