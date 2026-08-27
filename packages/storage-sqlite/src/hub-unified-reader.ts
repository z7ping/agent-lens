import type {
  CanonicalObservation,
  JsonValue,
  LogicalSession,
  ObservationRepository,
  SessionRepository,
} from '@agent-lens/core'
import type {
  ReplicationAvailability,
} from '@agent-lens/core/replication'
import type {
  HubRemoteObservationQuery,
  HubRemoteReadEntity,
} from './hub-remote-reader'

export type HubUnifiedReadOrigin =
  | {
      kind: 'local'
      nodeId: string
      entityId: string
    }
  | {
      kind: 'remote'
      nodeId: string
      entityId: string
      generationId: string
    }

export interface HubUnifiedLogicalSession {
  publicId: string
  entityType: 'LogicalSession'
  origin: HubUnifiedReadOrigin
  body: Readonly<Record<string, ReplicationAvailability>>
}

export interface HubUnifiedCanonicalObservation {
  publicId: string
  entityType: 'CanonicalObservation'
  origin: HubUnifiedReadOrigin
  body: Readonly<Record<string, ReplicationAvailability>>
}

export interface HubRemoteReadPort {
  get(publicId: string): Promise<HubRemoteReadEntity | undefined>
  listCanonicalObservationsForLogicalSession(
    query: HubRemoteObservationQuery,
  ): Promise<readonly HubRemoteReadEntity[]>
}

function availability(value: JsonValue | undefined): ReplicationAvailability {
  if (value === undefined) return { state: 'omitted', reason: 'not-captured' }
  if (value === null) return { state: 'null' }
  return { state: 'value', value }
}

function localJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 32) return '[max-depth]'
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) {
    return value.map(item => item === undefined ? null : localJsonValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    const output: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
      output[key] = localJsonValue(item, depth + 1)
    }
    return output
  }
  return null
}

function localSessionBody(session: LogicalSession): Readonly<Record<string, ReplicationAvailability>> {
  return {
    id: availability(session.id),
    installationId: availability(session.installationId),
    runtimeProfileId: availability(session.runtimeProfileId),
    projectId: availability(session.projectId),
    workspaceId: availability(session.workspaceId),
    title: availability(session.title),
    startedAt: availability(session.startedAt),
    endedAt: availability(session.endedAt),
  }
}

function localObservationBody(observation: CanonicalObservation): Readonly<Record<string, ReplicationAvailability>> {
  return {
    id: availability(observation.id),
    hostId: availability(observation.hostId),
    installationId: availability(observation.installationId),
    projectId: availability(observation.projectId),
    workspaceId: availability(observation.workspaceId),
    logicalSessionId: availability(observation.logicalSessionId),
    sourceSessionId: availability(observation.sourceSessionId),
    interactionId: availability(observation.interactionId),
    actorId: availability(observation.actorId),
    kind: availability(observation.kind),
    sourceSequence: availability(observation.sourceSequence),
    canonicalSequence: availability(observation.canonicalSequence),
    occurredAt: availability(observation.occurredAt),
    capturedAt: availability(observation.capturedAt),
    payload: availability(localJsonValue(observation.payload)),
    evidenceRefs: availability(observation.evidenceRefs),
  }
}

function remoteAvailabilityBody(
  entity: HubRemoteReadEntity,
  expectedType: 'LogicalSession' | 'CanonicalObservation',
): Readonly<Record<string, ReplicationAvailability>> {
  if (entity.entityType !== expectedType) {
    throw new TypeError(`Remote entity type mismatch: expected ${expectedType}, got ${entity.entityType}`)
  }
  if (!entity.body || Array.isArray(entity.body) || typeof entity.body !== 'object') {
    throw new TypeError(`Remote ${expectedType} body must be an availability object`)
  }
  return entity.body as unknown as Readonly<Record<string, ReplicationAvailability>>
}

/**
 * First H8 Unified Read slice.
 *
 * It composes Local Canonical LogicalSession with the formal active-generation
 * Remote Replica read boundary. Local Canonical IDs stay unchanged, while
 * remote entities are addressed only by ReplicaKey. Projection/Web callers do
 * not inspect Hub replica tables or generation state themselves.
 */
export class HubUnifiedLogicalSessionReader {
  constructor(
    private readonly localNodeId: string,
    private readonly localSessions: SessionRepository,
    private readonly remote: HubRemoteReadPort,
  ) {}

  async get(publicId: string): Promise<HubUnifiedLogicalSession | undefined> {
    const local = await this.localSessions.getLogicalSession(publicId as LogicalSession['id'])
    if (local) {
      return {
        publicId: local.id,
        entityType: 'LogicalSession',
        origin: {
          kind: 'local',
          nodeId: this.localNodeId,
          entityId: local.id,
        },
        body: localSessionBody(local),
      }
    }

    const remote = await this.remote.get(publicId)
    if (!remote || remote.entityType !== 'LogicalSession') return undefined
    return {
      publicId: remote.publicId,
      entityType: 'LogicalSession',
      origin: {
        kind: 'remote',
        nodeId: remote.originNodeId,
        entityId: remote.originEntityId,
        generationId: remote.generationId,
      },
      body: remoteAvailabilityBody(remote, 'LogicalSession'),
    }
  }
}

/**
 * Availability-aware observation reader for one Unified LogicalSession.
 * It deliberately does not cast remote bodies into CanonicalObservation,
 * because metadata-only/history policy may omit fields that Local Core expects.
 */
export class HubUnifiedObservationReader {
  constructor(
    private readonly localNodeId: string,
    private readonly localObservations: ObservationRepository,
    private readonly sessions: HubUnifiedLogicalSessionReader,
    private readonly remote: HubRemoteReadPort,
  ) {}

  async queryForLogicalSession(
    logicalSessionPublicId: string,
    limit = 500,
  ): Promise<readonly HubUnifiedCanonicalObservation[]> {
    const session = await this.sessions.get(logicalSessionPublicId)
    if (!session) return []
    const boundedLimit = Math.max(1, Math.min(limit, 5000))

    if (session.origin.kind === 'local') {
      const observations = await this.localObservations.query({
        logicalSessionId: session.origin.entityId,
        limit: boundedLimit,
      })
      return observations.map(observation => ({
        publicId: observation.id,
        entityType: 'CanonicalObservation' as const,
        origin: {
          kind: 'local' as const,
          nodeId: this.localNodeId,
          entityId: observation.id,
        },
        body: localObservationBody(observation),
      }))
    }

    const observations = await this.remote.listCanonicalObservationsForLogicalSession({
      originNodeId: session.origin.nodeId,
      generationId: session.origin.generationId,
      logicalSessionOriginId: session.origin.entityId,
      limit: boundedLimit,
    })
    return observations.map(observation => ({
      publicId: observation.publicId,
      entityType: 'CanonicalObservation' as const,
      origin: {
        kind: 'remote' as const,
        nodeId: observation.originNodeId,
        entityId: observation.originEntityId,
        generationId: observation.generationId,
      },
      body: remoteAvailabilityBody(observation, 'CanonicalObservation'),
    }))
  }
}
