import type {
  ReplicationAvailability,
  UnifiedLogicalSessionReader,
  UnifiedObservationReader,
  UnifiedReadOrigin,
  UnifiedReadReference,
  UnifiedReadReferences,
} from '@agent-lens/core/replication'
import type {
  HubReadAvailability,
  HubReviewDetailDto,
  HubReviewOriginDto,
  HubReviewReferenceDto,
  HubReviewSessionListDto,
  JsonValue,
} from '@agent-lens/protocol'

function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 32) return '[max-depth]'
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1))
  if (typeof value === 'object') {
    const output: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
      output[key] = jsonValue(item, depth + 1)
    }
    return output
  }
  return null
}

function availability(value: ReplicationAvailability | undefined): HubReadAvailability {
  if (!value) return { state: 'omitted', reason: 'not-captured' }
  switch (value.state) {
    case 'value': return { state: 'value', value: jsonValue(value.value) }
    case 'null': return { state: 'null' }
    case 'redacted': return { state: 'redacted' }
    case 'omitted': return { state: 'omitted', reason: value.reason }
  }
}

function origin(value: UnifiedReadOrigin): HubReviewOriginDto {
  return value.kind === 'local'
    ? { kind: 'local', nodeId: value.nodeId, entityId: value.entityId }
    : {
        kind: 'remote',
        nodeId: value.nodeId,
        entityId: value.entityId,
        generationId: value.generationId,
      }
}

function isSingleReference(value: UnifiedReadReference | readonly UnifiedReadReference[]): value is UnifiedReadReference {
  return !Array.isArray(value)
}

function references(value: UnifiedReadReferences): Record<string, HubReviewReferenceDto | HubReviewReferenceDto[]> {
  const output: Record<string, HubReviewReferenceDto | HubReviewReferenceDto[]> = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSingleReference(item)
      ? { entityType: item.entityType, publicId: item.publicId }
      : item.map(ref => ({ entityType: ref.entityType, publicId: ref.publicId }))
  }
  return output
}

/** Availability-aware Hub task review over the Core Unified Read boundary. */
export class HubReviewProjection {
  constructor(
    private readonly sessions: UnifiedLogicalSessionReader,
    private readonly observations: UnifiedObservationReader,
  ) {}

  async query(limit = 100): Promise<HubReviewSessionListDto> {
    const sessions = await this.sessions.list(limit)
    return {
      items: sessions.map(session => ({
        id: session.publicId,
        origin: origin(session.origin),
        title: availability(session.body.title),
        startedAt: availability(session.body.startedAt),
        endedAt: availability(session.body.endedAt),
      })),
      meta: {
        count: sessions.length,
        generatedAt: new Date().toISOString(),
      },
    }
  }

  async get(logicalSessionPublicId: string, limit = 500): Promise<HubReviewDetailDto | null> {
    const session = await this.sessions.get(logicalSessionPublicId)
    if (!session) return null

    const items = await this.observations.queryForLogicalSession(logicalSessionPublicId, limit)
    return {
      logicalSessionId: session.publicId,
      origin: origin(session.origin),
      title: availability(session.body.title),
      items: items.map(item => ({
        id: item.publicId,
        origin: origin(item.origin),
        kind: availability(item.body.kind),
        capturedAt: availability(item.body.capturedAt),
        occurredAt: availability(item.body.occurredAt),
        payload: availability(item.body.payload),
        references: references(item.references),
      })),
      meta: {
        count: items.length,
        generatedAt: new Date().toISOString(),
      },
    }
  }
}

export const hubReviewProjectionInternals = {
  availability,
  references,
  origin,
}
