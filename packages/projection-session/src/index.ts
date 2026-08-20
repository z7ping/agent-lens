import type {
  AgentInstallation,
  CanonicalObservation,
  LogicalSession,
  SourceSession,
  StorageService,
} from '@agent-lens/core'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type SessionDetailDto,
  type SessionInteractionDto,
  type SessionQueryDto,
  type SessionResponseDto,
  type TimelineObservationKind,
} from '@agent-lens/protocol'

const MAX_SCAN_ROWS = 5000
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function effectiveAt(observation: CanonicalObservation): string {
  return observation.occurredAt ?? observation.capturedAt
}

function compareObservations(left: CanonicalObservation, right: CanonicalObservation): number {
  const leftTime = Date.parse(effectiveAt(left))
  const rightTime = Date.parse(effectiveAt(right))
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }
  const leftSequence = left.canonicalSequence ?? left.sourceSequence ?? Number.MAX_SAFE_INTEGER
  const rightSequence = right.canonicalSequence ?? right.sourceSequence ?? Number.MAX_SAFE_INTEGER
  if (leftSequence !== rightSequence) return leftSequence - rightSequence
  return left.id.localeCompare(right.id)
}

function interactionId(sessionId: string, ordinal: number): string {
  return `${sessionId}:interaction:${ordinal}`
}

function buildInteractions(observations: CanonicalObservation[]): SessionInteractionDto[] {
  const sorted = [...observations].sort(compareObservations)
  const result: SessionInteractionDto[] = []
  let current: CanonicalObservation[] = []
  let trigger: SessionInteractionDto['trigger'] = 'background'

  const flush = () => {
    if (!current.length) return
    const first = current[0]!
    const last = current[current.length - 1]!
    const ordinal = result.length + 1
    result.push({
      id: interactionId(first.logicalSessionId, ordinal),
      ordinal,
      trigger,
      startedAt: effectiveAt(first),
      endedAt: effectiveAt(last),
      startObservationId: first.id,
      endObservationId: last.id,
      observationCount: current.length,
      observationIds: current.map(item => item.id),
    })
    current = []
  }

  for (const observation of sorted) {
    if (observation.kind === 'message.user') {
      flush()
      trigger = 'user'
      current.push(observation)
      continue
    }

    if (!current.length && observation.kind === 'session.lifecycle') {
      continue
    }
    if (!current.length) trigger = 'background'
    current.push(observation)
  }
  flush()
  return result
}

export class SessionProjection {
  constructor(private readonly storage: StorageService) {}

  async query(query: SessionQueryDto = {}): Promise<SessionResponseDto> {
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
    const observations = await this.storage.repositories.observations.query({
      ...(query.installationId ? { installationId: query.installationId } : {}),
      ...(query.logicalSessionId ? { logicalSessionId: query.logicalSessionId } : {}),
      limit: MAX_SCAN_ROWS,
    })

    const grouped = new Map<string, CanonicalObservation[]>()
    for (const observation of observations) {
      const values = grouped.get(observation.logicalSessionId) ?? []
      values.push(observation)
      grouped.set(observation.logicalSessionId, values)
    }

    const sessionCache = new Map<string, LogicalSession | null>()
    const installationCache = new Map<string, AgentInstallation | null>()
    const sourceSessionCache = new Map<string, SourceSession | null>()
    const items: SessionDetailDto[] = []

    for (const [logicalSessionId, values] of grouped) {
      let session = sessionCache.get(logicalSessionId)
      if (session === undefined) {
        session = await this.storage.repositories.sessions.getLogicalSession(logicalSessionId)
        sessionCache.set(logicalSessionId, session)
      }
      if (!session) continue

      let installation = installationCache.get(session.installationId)
      if (installation === undefined) {
        installation = await this.storage.repositories.installations.get(session.installationId)
        installationCache.set(session.installationId, installation)
      }
      if (!installation) continue

      const sorted = [...values].sort(compareObservations)
      const sourceIds = new Set<string>()
      const nativeSessionIds = new Set<string>()
      const nativeParentSessionIds = new Set<string>()
      const counts: Partial<Record<TimelineObservationKind, number>> = {}

      for (const observation of sorted) {
        counts[observation.kind] = (counts[observation.kind] ?? 0) + 1
        let sourceSession = sourceSessionCache.get(observation.sourceSessionId)
        if (sourceSession === undefined) {
          sourceSession = await this.storage.repositories.sessions.getSourceSession(observation.sourceSessionId)
          sourceSessionCache.set(observation.sourceSessionId, sourceSession)
        }
        if (!sourceSession) continue
        sourceIds.add(sourceSession.sourceId)
        nativeSessionIds.add(sourceSession.nativeSessionId)
        if (sourceSession.nativeParentSessionId) nativeParentSessionIds.add(sourceSession.nativeParentSessionId)
      }

      const interactions = buildInteractions(sorted)
      items.push({
        id: session.id,
        installationId: session.installationId,
        productId: installation.productId,
        ...(session.projectId ? { projectId: session.projectId } : {}),
        ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
        sourceIds: [...sourceIds].sort(),
        nativeSessionIds: [...nativeSessionIds].sort(),
        nativeParentSessionIds: [...nativeParentSessionIds].sort(),
        startedAt: effectiveAt(sorted[0]!),
        endedAt: effectiveAt(sorted[sorted.length - 1]!),
        observationCount: sorted.length,
        interactionCount: interactions.length,
        observationCounts: counts,
        interactions,
      })
    }

    items.sort((left, right) => right.endedAt.localeCompare(left.endedAt) || left.id.localeCompare(right.id))
    const hasMore = items.length > limit
    const limited = items.slice(0, limit)
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

export const sessionProjectionInternals = {
  buildInteractions,
  compareObservations,
}
