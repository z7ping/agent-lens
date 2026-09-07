import type {
  CanonicalObservation,
  ObservationCursor,
  StorageService,
} from '@agent-lens/core'
import type { TimelineProjection } from '@agent-lens/projection-timeline'
import type {
  ReviewInteractionDto,
  ReviewSessionSummaryDto,
} from '@agent-lens/protocol'
import { asRecord, buildInteractionGroups, textFromPayload } from './nodes'

const DESCRIPTOR_SCAN_CHUNK = 1000
const MAX_DESCRIPTOR_CACHE = 32

export interface InteractionDescriptor {
  ordinal: number
  trigger: 'user' | 'background'
  start: ObservationCursor
  end: ObservationCursor
  startedAt: string
  endedAt: string
  hasError: boolean
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
  }
  updateDescriptor(descriptor, observation)
  return descriptor
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

  constructor(
    private readonly storage: StorageService,
    private readonly timeline: TimelineProjection,
  ) {}

  async scanAll(logicalSessionId: string): Promise<InteractionDescriptor[]> {
    const descriptors: InteractionDescriptor[] = []
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
    let userCount = 0
    let after: ObservationCursor | undefined
    while (true) {
      const observations = await this.storage.repositories.observations.query({
        logicalSessionId,
        kind: 'message.user',
        ...(after ? { after } : {}),
        limit: DESCRIPTOR_SCAN_CHUNK,
      })
      if (!observations.length) break
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
    return userCount + (leadingBackground ? 1 : 0)
  }

  async materialize(logicalSessionId: string, descriptor: InteractionDescriptor): Promise<ReviewInteractionDto> {
    const first = await this.storage.repositories.observations.get(descriptor.start.id)
    if (!first) throw new Error(`Review projection integrity error: missing observation ${descriptor.start.id}`)
    const observations: CanonicalObservation[] = [first]
    let after = descriptor.start

    while (observations[observations.length - 1]!.id !== descriptor.end.id) {
      const page = await this.storage.repositories.observations.query({
        logicalSessionId,
        after,
        limit: DESCRIPTOR_SCAN_CHUNK,
      })
      if (!page.length) throw new Error(`Review projection integrity error: incomplete interaction ${descriptor.ordinal}`)
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

    const items = await this.timeline.mapObservations(observations)
    const interaction = buildInteractionGroups([items], descriptor.ordinal)[0]
    if (!interaction) throw new Error(`Review projection integrity error: empty interaction ${descriptor.ordinal}`)
    return interaction
  }
}

export const interactionDescriptorInternals = {
  maxDescriptorCache: MAX_DESCRIPTOR_CACHE,
  scanChunk: DESCRIPTOR_SCAN_CHUNK,
}
