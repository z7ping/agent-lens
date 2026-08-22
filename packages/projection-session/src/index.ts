import type {
  AgentInstallation,
  CanonicalObservation,
  LogicalSession,
  ObservationCursor,
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

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const DISCOVERY_CHUNK = 1000
const SESSION_CHUNK = 1000

export interface SessionProjectionEntry {
  session: SessionDetailDto
  logicalSession: LogicalSession
  installation: AgentInstallation
  observations: CanonicalObservation[]
}

export interface SessionProjectionEntries {
  entries: SessionProjectionEntry[]
  hasMore: boolean
}

function effectiveAt(observation: CanonicalObservation): string {
  return observation.occurredAt ?? observation.capturedAt
}

function effectiveSequence(observation: CanonicalObservation): number | undefined {
  return observation.canonicalSequence ?? observation.sourceSequence
}

function cursorForObservation(observation: CanonicalObservation): ObservationCursor {
  const sequence = effectiveSequence(observation)
  return {
    effectiveAt: effectiveAt(observation),
    ...(sequence === undefined ? {} : { sequence }),
    id: observation.id,
  }
}

function compareObservations(left: CanonicalObservation, right: CanonicalObservation): number {
  const leftTime = Date.parse(effectiveAt(left))
  const rightTime = Date.parse(effectiveAt(right))
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }
  const leftSequence = effectiveSequence(left) ?? Number.MAX_SAFE_INTEGER
  const rightSequence = effectiveSequence(right) ?? Number.MAX_SAFE_INTEGER
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

    if (!current.length && observation.kind === 'session.lifecycle') continue
    if (!current.length) trigger = 'background'
    current.push(observation)
  }
  flush()
  return result
}

export class SessionProjection {
  constructor(private readonly storage: StorageService) {}

  private async discoverRecentSessionIds(
    installationId: string | undefined,
    limit: number,
  ): Promise<{ ids: string[]; hasMore: boolean }> {
    if (this.storage.sessionSummaries) {
      const result = await this.storage.sessionSummaries.query({
        limit,
        ...(installationId ? { installationId } : {}),
      })
      return {
        ids: result.items.map(item => item.logicalSessionId),
        hasMore: result.hasMore,
      }
    }
    const ids: string[] = []
    const seen = new Set<string>()
    let before: ObservationCursor | undefined

    while (ids.length <= limit) {
      const page = await this.storage.repositories.observations.query({
        ...(installationId ? { installationId } : {}),
        ...(before ? { before } : {}),
        order: 'desc',
        limit: DISCOVERY_CHUNK,
      })
      if (!page.length) break

      for (const observation of page) {
        if (seen.has(observation.logicalSessionId)) continue
        seen.add(observation.logicalSessionId)
        ids.push(observation.logicalSessionId)
        if (ids.length > limit) break
      }

      if (ids.length > limit || page.length < DISCOVERY_CHUNK) break
      before = cursorForObservation(page[page.length - 1]!)
    }

    return { ids: ids.slice(0, limit), hasMore: ids.length > limit }
  }

  private async loadSessionObservations(
    logicalSessionIds: string[],
    installationId?: string,
  ): Promise<Map<string, CanonicalObservation[]>> {
    const values = new Map<string, CanonicalObservation[]>(
      logicalSessionIds.map(id => [id, []]),
    )
    if (!logicalSessionIds.length) return values
    let after: ObservationCursor | undefined

    while (true) {
      const page = await this.storage.repositories.observations.query({
        logicalSessionIds,
        ...(installationId ? { installationId } : {}),
        ...(after ? { after } : {}),
        limit: SESSION_CHUNK,
      })
      if (!page.length) break
      for (const observation of page) {
        values.get(observation.logicalSessionId)?.push(observation)
      }
      if (page.length < SESSION_CHUNK) break
      after = cursorForObservation(page[page.length - 1]!)
    }

    return values
  }

  async queryEntries(query: SessionQueryDto = {}): Promise<SessionProjectionEntries> {
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
    let sessionIds: string[]
    let hasMore = false

    if (query.logicalSessionId) {
      sessionIds = [query.logicalSessionId]
    } else {
      const discovered = await this.discoverRecentSessionIds(query.installationId, limit)
      sessionIds = discovered.ids
      hasMore = discovered.hasMore
    }

    const observationsBySession = await this.loadSessionObservations(
      sessionIds,
      query.installationId,
    )

    const sessionCache = new Map<string, LogicalSession | null>()
    const installationCache = new Map<string, AgentInstallation | null>()
    const sourceSessionCache = new Map<string, SourceSession | null>()
    const entries: SessionProjectionEntry[] = []

    for (const logicalSessionId of sessionIds) {
      const values = observationsBySession.get(logicalSessionId) ?? []
      if (!values.length) continue

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
      const detail: SessionDetailDto = {
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
      }
      entries.push({
        session: detail,
        logicalSession: session,
        installation,
        observations: sorted,
      })
    }

    entries.sort((left, right) => (
      right.session.endedAt.localeCompare(left.session.endedAt)
      || left.session.id.localeCompare(right.session.id)
    ))
    return { entries, hasMore }
  }

  async query(query: SessionQueryDto = {}): Promise<SessionResponseDto> {
    const projected = await this.queryEntries(query)
    const items = projected.entries.map(entry => entry.session)
    return {
      items,
      meta: {
        protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
        count: items.length,
        hasMore: projected.hasMore,
        generatedAt: new Date().toISOString(),
      },
    }
  }
}

export const sessionProjectionInternals = {
  buildInteractions,
  compareObservations,
  cursorForObservation,
}
