import type {
  CanonicalObservation,
  ObservationHeader,
  ObservationCursor,
  StorageService,
} from '@agent-lens/core'
import type { TimelineProjection } from '@agent-lens/projection-timeline'
import type {
  ReviewInteractionDto,
  ReviewProcessSummaryDto,
  ReviewSessionSummaryDto,
} from '@agent-lens/protocol'
import { asRecord, buildInteractionGroups, buildNodes, stringField, textFromPayload } from './nodes'

const DESCRIPTOR_SCAN_CHUNK = 1000
const MAX_DESCRIPTOR_CACHE = 32
const SLOW_DESCRIPTOR_PHASE_MS = 500
const MAX_REVIEW_SUMMARY_FACTS = 600

function logSlowDescriptorPhase(phase: string, startedAt: number, details: Record<string, number> = {}): void {
  const elapsedMs = performance.now() - startedAt
  if (elapsedMs < SLOW_DESCRIPTOR_PHASE_MS) return
  console.warn('[AgentLens] Review descriptor slow phase', { phase, elapsedMs: Math.round(elapsedMs), ...details })
}

export interface InteractionDescriptor {
  ordinal: number
  trigger: 'user' | 'background'
  start: ObservationCursor
  end: ObservationCursor
  startedAt: string
  endedAt: string
  hasError: boolean
  observationCount: number
  preview?: string
}

export function durationMs(startedAt: string, endedAt: string): number {
  const value = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function observationError(item: CanonicalObservation): boolean {
  if (item.kind !== 'tool.result') return false
  return asRecord(item.payload).success === false
}

function observationEffectiveAt(item: CanonicalObservation): string {
  return item.occurredAt ?? item.capturedAt
}

function observationCursor(item: CanonicalObservation): ObservationCursor {
  const sequence = item.canonicalSequence ?? item.sourceSequence
  return {
    effectiveAt: observationEffectiveAt(item),
    ...(sequence === undefined ? {} : { sequence }),
    id: item.id,
  }
}

function updateDescriptor(descriptor: InteractionDescriptor, observation: CanonicalObservation): void {
  if (!descriptor.preview && observation.kind === 'message.user') {
    const preview = textFromPayload(observation.payload)?.replace(/\s+/g, ' ').trim()
    if (preview) descriptor.preview = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview
  }
  descriptor.end = observationCursor(observation)
  descriptor.endedAt = observationEffectiveAt(observation)
  descriptor.hasError ||= observationError(observation)
  descriptor.observationCount += 1
}

function headerEffectiveAt(item: ObservationHeader): string {
  return item.occurredAt ?? item.capturedAt
}

function headerCursor(item: ObservationHeader): ObservationCursor {
  return {
    effectiveAt: headerEffectiveAt(item),
    ...(item.canonicalSequence === undefined && item.sourceSequence === undefined
      ? {}
      : { sequence: item.canonicalSequence ?? item.sourceSequence }),
    id: item.id,
  }
}

function observationHeader(item: CanonicalObservation): ObservationHeader {
  return {
    id: item.id,
    installationId: item.installationId,
    logicalSessionId: item.logicalSessionId,
    sourceSessionId: item.sourceSessionId,
    kind: item.kind,
    ...(item.sourceSequence === undefined ? {} : { sourceSequence: item.sourceSequence }),
    ...(item.canonicalSequence === undefined ? {} : { canonicalSequence: item.canonicalSequence }),
    ...(item.occurredAt ? { occurredAt: item.occurredAt } : {}),
    capturedAt: item.capturedAt,
    ...(item.kind === 'tool.result' ? { error: observationError(item) } : {}),
  }
}

function compareObservationCursor(left: ObservationCursor, right: ObservationCursor): number {
  const time = left.effectiveAt.localeCompare(right.effectiveAt)
  if (time) return time
  const leftSequence = left.sequence ?? Number.POSITIVE_INFINITY
  const rightSequence = right.sequence ?? Number.POSITIVE_INFINITY
  if (leftSequence !== rightSequence) return leftSequence < rightSequence ? -1 : 1
  return left.id.localeCompare(right.id)
}

function normalizedLifecycleAction(observation: CanonicalObservation): string {
  const payload = asRecord(observation.payload)
  return (stringField(payload, 'event', 'action', 'type', 'status') ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_:\-]+/g, '.')
}

function isTerminalLifecycle(observation: CanonicalObservation): boolean {
  if (observation.kind !== 'session.lifecycle') return false
  return [
    'turn.completed',
    'turn.complete',
    'turn.ended',
    'turn.end',
    'turn.stopped',
    'turn.stop',
    'turn.aborted',
    'turn.error',
  ].includes(normalizedLifecycleAction(observation))
}

function isProcessDriverKind(kind: ObservationHeader['kind']): boolean {
  return kind !== 'message.user'
    && kind !== 'message.assistant'
    && kind !== 'artifact.action'
}

function updateStructureDescriptor(descriptor: InteractionDescriptor, observation: ObservationHeader): void {
  descriptor.end = headerCursor(observation)
  descriptor.endedAt = headerEffectiveAt(observation)
  descriptor.hasError ||= observation.error === true
  descriptor.observationCount += 1
}

function newDescriptor(observation: CanonicalObservation, ordinal: number): InteractionDescriptor {
  const cursor = observationCursor(observation)
  const descriptor: InteractionDescriptor = {
    ordinal,
    trigger: observation.kind === 'message.user' ? 'user' : 'background',
    start: cursor,
    end: cursor,
    startedAt: cursor.effectiveAt,
    endedAt: cursor.effectiveAt,
    hasError: false,
    observationCount: 0,
  }
  updateDescriptor(descriptor, observation)
  return descriptor
}

function newStructureDescriptor(observation: ObservationHeader, ordinal: number): InteractionDescriptor {
  const cursor = headerCursor(observation)
  return {
    ordinal,
    trigger: observation.kind === 'message.user' ? 'user' : 'background',
    start: cursor,
    end: cursor,
    startedAt: cursor.effectiveAt,
    endedAt: cursor.effectiveAt,
    hasError: observation.error === true,
    observationCount: 1,
  }
}

export function highLatencyThreshold(descriptors: InteractionDescriptor[]): number | null {
  const values = descriptors
    .map(item => durationMs(item.startedAt, item.endedAt))
    .filter(value => value > 0)
    .sort((a, b) => a - b)
  if (values.length < 2) return null
  const middle = Math.floor(values.length / 2)
  const median = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2
  const upperIndex = Math.min(values.length - 1, Math.floor((values.length - 1) * 0.75))
  const upperQuartile = values[upperIndex]!
  return Math.max(upperQuartile, median * 1.75)
}

export class InteractionDescriptorStore {
  private readonly cache = new Map<string, { version: string; descriptors: InteractionDescriptor[] }>()
  private readonly structureCache = new Map<string, { version: string; descriptors: InteractionDescriptor[] }>()

  constructor(
    private readonly storage: StorageService,
    private readonly timeline: TimelineProjection,
  ) {}

  async scanAll(logicalSessionId: string): Promise<InteractionDescriptor[]> {
    const startedAt = performance.now()
    const descriptors: InteractionDescriptor[] = []
    let observationCount = 0
    let pages = 0
    let after: ObservationCursor | undefined
    let current: InteractionDescriptor | null = null

    const flush = () => {
      if (!current) return
      descriptors.push(current)
      current = null
    }

    while (true) {
      const observations = await this.storage.repositories.observations.query({
        logicalSessionId,
        ...(after ? { after } : {}),
        limit: DESCRIPTOR_SCAN_CHUNK,
      })
      if (!observations.length) break
      pages += 1
      observationCount += observations.length

      for (const observation of observations) {
        if (observation.kind === 'message.user' && current) flush()
        if (!current && observation.kind === 'session.lifecycle') continue
        if (!current) current = newDescriptor(observation, descriptors.length + 1)
        else updateDescriptor(current, observation)
      }

      after = observationCursor(observations[observations.length - 1]!)
      if (observations.length < DESCRIPTOR_SCAN_CHUNK) break
    }
    flush()
    logSlowDescriptorPhase('scan-all', startedAt, { pages, observations: observationCount, descriptors: descriptors.length })
    return descriptors
  }

  async cached(summary: ReviewSessionSummaryDto): Promise<InteractionDescriptor[]> {
    const version = `${summary.observationCount}:${summary.endedAt}`
    const cached = this.cache.get(summary.id)
    if (cached?.version === version) {
      this.cache.delete(summary.id)
      this.cache.set(summary.id, cached)
      return cached.descriptors
    }

    const descriptors = await this.scanAll(summary.id)
    this.cache.set(summary.id, { version, descriptors })
    while (this.cache.size > MAX_DESCRIPTOR_CACHE) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.cache.delete(oldest.value)
    }
    return descriptors
  }

  /** Read only ordering headers when the caller needs normal chronological paging.
   * This deliberately avoids payload and evidence hydration for interactions which
   * will not be part of the current Review page. */
  async structureCached(summary: ReviewSessionSummaryDto): Promise<InteractionDescriptor[]> {
    const version = `${summary.observationCount}:${summary.endedAt}`
    const cached = this.structureCache.get(summary.id)
    if (cached?.version === version) return cached.descriptors
    const headers = this.storage.repositories.observations.queryHeaders
    if (!headers) return this.cached(summary)

    const startedAt = performance.now()
    const descriptors: InteractionDescriptor[] = []
    let after: ObservationCursor | undefined
    let current: InteractionDescriptor | null = null
    let pages = 0
    let observationCount = 0
    while (true) {
      const page = await headers.call(this.storage.repositories.observations, {
        logicalSessionId: summary.id,
        ...(after ? { after } : {}),
        limit: DESCRIPTOR_SCAN_CHUNK,
      })
      if (!page.length) break
      pages += 1
      observationCount += page.length
      for (const observation of page) {
        if (observation.kind === 'message.user' && current) {
          descriptors.push(current)
          current = null
        }
        if (!current && observation.kind === 'session.lifecycle') continue
        if (!current) current = newStructureDescriptor(observation, descriptors.length + 1)
        else updateStructureDescriptor(current, observation)
      }
      after = headerCursor(page[page.length - 1]!)
      if (page.length < DESCRIPTOR_SCAN_CHUNK) break
    }
    if (current) descriptors.push(current)
    this.structureCache.set(summary.id, { version, descriptors })
    while (this.structureCache.size > MAX_DESCRIPTOR_CACHE) {
      const oldest = this.structureCache.keys().next()
      if (oldest.done) break
      this.structureCache.delete(oldest.value)
    }
    logSlowDescriptorPhase('scan-structure', startedAt, { pages, observations: observationCount, descriptors: descriptors.length })
    return descriptors
  }

  async find(logicalSessionId: string, targetOrdinal: number): Promise<InteractionDescriptor | null> {
    if (!Number.isSafeInteger(targetOrdinal) || targetOrdinal < 1) return null
    let after: ObservationCursor | undefined
    let current: InteractionDescriptor | null = null
    let ordinal = 0

    while (true) {
      const observations = await this.storage.repositories.observations.query({
        logicalSessionId,
        ...(after ? { after } : {}),
        limit: DESCRIPTOR_SCAN_CHUNK,
      })
      if (!observations.length) break

      for (const observation of observations) {
        if (observation.kind === 'message.user' && current) {
          if (current.ordinal === targetOrdinal) return current
          current = null
        }
        if (!current && observation.kind === 'session.lifecycle') continue
        if (!current) {
          ordinal += 1
          current = newDescriptor(observation, ordinal)
        } else {
          updateDescriptor(current, observation)
        }
      }

      after = observationCursor(observations[observations.length - 1]!)
      if (observations.length < DESCRIPTOR_SCAN_CHUNK) break
    }

    return current?.ordinal === targetOrdinal ? current : null
  }

  async count(logicalSessionId: string): Promise<number> {
    const startedAt = performance.now()
    const headers = this.storage.repositories.observations.queryHeaders
    if (headers) {
      let userCount = 0
      let pages = 0
      let after: ObservationCursor | undefined
      while (true) {
        const page = await headers.call(this.storage.repositories.observations, {
          logicalSessionId,
          kind: 'message.user',
          ...(after ? { after } : {}),
          limit: DESCRIPTOR_SCAN_CHUNK,
        })
        if (!page.length) break
        pages += 1
        userCount += page.length
        after = headerCursor(page[page.length - 1]!)
        if (page.length < DESCRIPTOR_SCAN_CHUNK) break
      }

      let leadingBackground = false
      let probeAfter: ObservationCursor | undefined
      outer: while (true) {
        const probe = await headers.call(this.storage.repositories.observations, {
          logicalSessionId,
          ...(probeAfter ? { after: probeAfter } : {}),
          limit: 100,
        })
        if (!probe.length) break
        for (const observation of probe) {
          if (observation.kind === 'session.lifecycle') continue
          leadingBackground = observation.kind !== 'message.user'
          break outer
        }
        probeAfter = headerCursor(probe[probe.length - 1]!)
        if (probe.length < 100) break
      }
      const count = userCount + (leadingBackground ? 1 : 0)
      logSlowDescriptorPhase('count-headers', startedAt, { pages, interactions: count })
      return count
    }

    let userCount = 0
    let pages = 0
    let after: ObservationCursor | undefined
    while (true) {
      const observations = await this.storage.repositories.observations.query({
        logicalSessionId,
        kind: 'message.user',
        ...(after ? { after } : {}),
        limit: DESCRIPTOR_SCAN_CHUNK,
      })
      if (!observations.length) break
      pages += 1
      userCount += observations.length
      after = observationCursor(observations[observations.length - 1]!)
      if (observations.length < DESCRIPTOR_SCAN_CHUNK) break
    }

    let leadingBackground = false
    let probeAfter: ObservationCursor | undefined
    outer: while (true) {
      const probe = await this.storage.repositories.observations.query({
        logicalSessionId,
        ...(probeAfter ? { after: probeAfter } : {}),
        limit: 100,
      })
      if (!probe.length) break
      for (const observation of probe) {
        if (observation.kind === 'session.lifecycle') continue
        leadingBackground = observation.kind !== 'message.user'
        break outer
      }
      probeAfter = observationCursor(probe[probe.length - 1]!)
      if (probe.length < 100) break
    }
    const count = userCount + (leadingBackground ? 1 : 0)
    logSlowDescriptorPhase('count', startedAt, { pages, interactions: count })
    return count
  }

  private async observationsByIds(ids: readonly string[]): Promise<CanonicalObservation[]> {
    if (!ids.length) return []
    const uniqueIds = [...new Set(ids)]
    const batch = this.storage.repositories.observations.getMany
    if (batch) return batch.call(this.storage.repositories.observations, uniqueIds)
    const values = await Promise.all(uniqueIds.map(id => this.storage.repositories.observations.get(id)))
    return values.filter((item): item is CanonicalObservation => item !== null)
  }

  private async loadHeaders(
    logicalSessionId: string,
    descriptor: InteractionDescriptor,
  ): Promise<{ headers: ObservationHeader[]; pages: number; fallbackObservations?: CanonicalObservation[] }> {
    const queryHeaders = this.storage.repositories.observations.queryHeaders
    if (!queryHeaders) {
      const fallback = await this.loadObservations(logicalSessionId, descriptor)
      return {
        headers: fallback.observations.map(observationHeader),
        pages: fallback.pages,
        fallbackObservations: fallback.observations,
      }
    }

    const headers: ObservationHeader[] = []
    let pages = 0
    let after: ObservationCursor | undefined
    while (true) {
      const page = await queryHeaders.call(this.storage.repositories.observations, {
        logicalSessionId,
        from: descriptor.startedAt,
        ...(after ? { after } : {}),
        limit: DESCRIPTOR_SCAN_CHUNK,
      })
      if (!page.length) break
      pages += 1
      let reachedEnd = false
      for (const header of page) {
        const cursor = headerCursor(header)
        if (compareObservationCursor(cursor, descriptor.start) < 0) continue
        if (compareObservationCursor(cursor, descriptor.end) > 0) {
          reachedEnd = true
          break
        }
        headers.push(header)
        if (header.id === descriptor.end.id) {
          reachedEnd = true
          break
        }
      }
      if (reachedEnd || page.length < DESCRIPTOR_SCAN_CHUNK) break
      after = headerCursor(page[page.length - 1]!)
    }
    return { headers, pages }
  }

  async materializeSummaryMany(
    logicalSessionId: string,
    descriptors: readonly InteractionDescriptor[],
  ): Promise<ReviewInteractionDto[]> {
    const startedAt = performance.now()
    const groups = []
    for (const descriptor of descriptors) {
      groups.push({ descriptor, ...(await this.loadHeaders(logicalSessionId, descriptor)) })
    }

    const preliminaryIds = new Set<string>()
    for (const group of groups) {
      for (const header of group.headers) {
        if (header.kind === 'session.lifecycle') preliminaryIds.add(header.id)
        if (header.kind === 'tool.result' && header.error === undefined) preliminaryIds.add(header.id)
      }
    }
    const preliminary = new Map((await this.observationsByIds([...preliminaryIds])).map(item => [item.id, item]))

    const displayIds = new Set<string>()
    const summaries = new Map<number, ReviewProcessSummaryDto>()
    for (const group of groups) {
      const terminalIds = new Set(group.headers
        .filter(header => {
          const observation = preliminary.get(header.id)
          return observation ? isTerminalLifecycle(observation) : false
        })
        .map(header => header.id))

      let lastProcessDriver = -1
      for (let index = 0; index < group.headers.length; index += 1) {
        const header = group.headers[index]!
        if (terminalIds.has(header.id)) continue
        if (isProcessDriverKind(header.kind)) lastProcessDriver = index
      }

      const processHeaders: ObservationHeader[] = []
      for (let index = 0; index < group.headers.length; index += 1) {
        const header = group.headers[index]!
        const finalAssistant = header.kind === 'message.assistant' && index > lastProcessDriver
        const prompt = header.kind === 'message.user'
        const artifact = header.kind === 'artifact.action'
        const terminal = terminalIds.has(header.id)
        if (prompt || finalAssistant || artifact || terminal || header.kind === 'model.call' || header.kind === 'model.changed') {
          displayIds.add(header.id)
        }
        if (!prompt && !finalAssistant && !artifact && !terminal) processHeaders.push(header)
      }

      const fallbackById = group.fallbackObservations
        ? new Map(group.fallbackObservations.map(item => [item.id, item]))
        : preliminary
      const messageCount = processHeaders.filter(header =>
        header.kind === 'message.commentary'
        || header.kind === 'message.reasoning'
        || header.kind === 'message.assistant').length
      const toolCount = processHeaders.filter(header => header.kind === 'tool.call').length
      const errorCount = processHeaders.filter(header => {
        if (header.kind !== 'tool.result') return false
        if (header.error !== undefined) return header.error
        const observation = fallbackById.get(header.id) ?? preliminary.get(header.id)
        return observation ? observationError(observation) : false
      }).length
      const processTimes = processHeaders.map(header => Date.parse(headerEffectiveAt(header))).filter(Number.isFinite)
      const processStartedAt = processTimes.length ? Math.min(...processTimes) : undefined
      const processEndedAt = processTimes.length ? Math.max(...processTimes) : undefined
      const totalFactCount = group.headers.length
      const omittedFactCount = Math.max(0, totalFactCount - MAX_REVIEW_SUMMARY_FACTS)
      const last = group.headers.at(-1)
      const interactionId = `${logicalSessionId}:review:${group.descriptor.ordinal}`
      summaries.set(group.descriptor.ordinal, {
        id: `process:${interactionId}`,
        revision: [interactionId, totalFactCount, last?.id ?? 'empty', last?.capturedAt ?? group.descriptor.endedAt].join(':'),
        itemCount: processHeaders.length,
        messageCount,
        toolCount,
        errorCount,
        durationMs: processStartedAt !== undefined && processEndedAt !== undefined
          ? Math.max(0, processEndedAt - processStartedAt)
          : 0,
        availability: omittedFactCount > 0 ? 'partial' : 'available',
        totalFactCount,
        ...(omittedFactCount > 0 ? { omittedFactCount } : {}),
      })
    }

    const hydrated = new Map(preliminary)
    const missingDisplayIds = [...displayIds].filter(id => !hydrated.has(id))
    for (const observation of await this.observationsByIds(missingDisplayIds)) hydrated.set(observation.id, observation)
    const displayObservations = [...displayIds]
      .map(id => hydrated.get(id))
      .filter((item): item is CanonicalObservation => Boolean(item))
    const itemsById = new Map((await this.timeline.mapObservations(displayObservations)).map(item => [item.id, item]))

    const interactions = groups.map(group => {
      const items = group.headers
        .filter(header => displayIds.has(header.id))
        .map(header => itemsById.get(header.id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
      const summary = summaries.get(group.descriptor.ordinal)
      if (!summary) throw new Error(`Review summary integrity error: missing process summary ${group.descriptor.ordinal}`)
      return {
        id: `${logicalSessionId}:review:${group.descriptor.ordinal}`,
        ordinal: group.descriptor.ordinal,
        trigger: group.descriptor.trigger,
        startedAt: group.descriptor.startedAt,
        endedAt: group.descriptor.endedAt,
        nodes: buildNodes(items),
        processSummary: summary,
        processMode: 'summary' as const,
      }
    })

    logSlowDescriptorPhase('materialize-summary-many', startedAt, {
      interactions: interactions.length,
      headers: groups.reduce((total, group) => total + group.headers.length, 0),
      hydrated: hydrated.size,
      pages: groups.reduce((total, group) => total + group.pages, 0),
    })
    return interactions
  }

  async materialize(logicalSessionId: string, descriptor: InteractionDescriptor): Promise<ReviewInteractionDto> {
    const [interaction] = await this.materializeMany(logicalSessionId, [descriptor])
    if (!interaction) throw new Error(`Review projection integrity error: empty interaction ${descriptor.ordinal}`)
    return interaction
  }

  /**
   * Materialise a bounded Review page in two stages. Observation ranges remain
   * independent so descriptor integrity is preserved, but evidence and identity
   * hydration are deliberately shared across the complete foreground page.
   * Calling TimelineProjection once prevents each interaction from serially
   * issuing the same large evidence-reader work.
   */
  async materializeMany(
    logicalSessionId: string,
    descriptors: readonly InteractionDescriptor[],
  ): Promise<ReviewInteractionDto[]> {
    const startedAt = performance.now()
    const groups: Array<{ descriptor: InteractionDescriptor; observations: CanonicalObservation[]; pages: number }> = []
    for (const descriptor of descriptors) {
      groups.push(await this.loadObservations(logicalSessionId, descriptor))
    }
    const observations = groups.flatMap(group => group.observations)
    const itemsById = new Map((await this.timeline.mapObservations(observations)).map(item => [item.id, item]))
    const interactions = groups.map(group => {
      const items = group.observations.map(observation => {
        const item = itemsById.get(observation.id)
        if (!item) throw new Error(`Review projection integrity error: missing timeline item ${observation.id}`)
        return item
      })
      const interaction = buildInteractionGroups([items], group.descriptor.ordinal)[0]
      if (!interaction) throw new Error(`Review projection integrity error: empty interaction ${group.descriptor.ordinal}`)
      return interaction
    })
    logSlowDescriptorPhase('materialize-many', startedAt, {
      interactions: interactions.length,
      observations: observations.length,
      pages: groups.reduce((total, group) => total + group.pages, 0),
    })
    return interactions
  }

  private async loadObservations(
    logicalSessionId: string,
    descriptor: InteractionDescriptor,
  ): Promise<{ descriptor: InteractionDescriptor; observations: CanonicalObservation[]; pages: number }> {
    const startedAt = performance.now()
    const first = await this.storage.repositories.observations.get(descriptor.start.id)
    if (!first) throw new Error(`Review projection integrity error: missing observation ${descriptor.start.id}`)
    const observations: CanonicalObservation[] = [first]
    let pages = 0
    let after = descriptor.start

    while (observations[observations.length - 1]!.id !== descriptor.end.id) {
      const page = await this.storage.repositories.observations.query({
        logicalSessionId,
        after,
        limit: DESCRIPTOR_SCAN_CHUNK,
      })
      if (!page.length) throw new Error(`Review projection integrity error: incomplete interaction ${descriptor.ordinal}`)
      pages += 1
      let found = false
      for (const observation of page) {
        observations.push(observation)
        if (observation.id === descriptor.end.id) {
          found = true
          break
        }
      }
      if (found) break
      after = observationCursor(page[page.length - 1]!)
    }

    logSlowDescriptorPhase('load-observations', startedAt, { pages, observations: observations.length })
    return { descriptor, observations, pages }
  }
}

export const interactionDescriptorInternals = {
  maxDescriptorCache: MAX_DESCRIPTOR_CACHE,
  scanChunk: DESCRIPTOR_SCAN_CHUNK,
}
