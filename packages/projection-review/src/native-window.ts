import { createHash } from 'node:crypto'
import type { ObservationCandidate } from '@agent-lens/core'
import {
  type JsonValue,
  type NativeReviewWindowDto,
  type TimelineItemDto,
} from '@agent-lens/protocol'
import { buildInteractions } from './nodes'

export interface NativeReviewProjectionInput {
  sourceId: string
  installationId: string
  nativeSessionId: string
  observations: readonly ObservationCandidate[]
  /** Correlates every normalized candidate to its source record, not SQL IDs. */
  observationRecordIds?: readonly string[]
  hasMore: boolean
  pendingTail: boolean
  /** Encoded Source cursor, with no underlying file path. */
  nextCursor: string
  /** Present for all but the first native byte window. */
  hasPrevious: boolean
  /** Provided only for complete user-turn window pagination. */
  startingOrdinal?: number
  completeBoundaries?: boolean
}

function stableId(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
}

function jsonValue(value: unknown, depth = 0, seen = new WeakSet<object>()): JsonValue {
  if (depth > 20) return '[max-depth]'
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'undefined') return null
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    if (Array.isArray(value)) {
      const result = value.map(item => jsonValue(item, depth + 1, seen))
      seen.delete(value)
      return result
    }
    const result: Record<string, JsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol') {
        result[key] = jsonValue(entry, depth + 1, seen)
      }
    }
    seen.delete(value)
    return result
  }
  return null
}

/**
 * Uses the SAME Review node, tool pairing and turn grouping projection as
 * persisted Review. No SourceRecord/Canonical/Evidence is inserted into SQL.
 *
 * Window boundaries may cut through an interaction. Clients must not append
 * these partial interactions to the main Task Surface until stitching exists.
 */
export function nativeReviewSessionId(sourceId: string, installationId: string, nativeSessionId: string): string {
  return `native:${stableId([sourceId, installationId, nativeSessionId])}`
}

export function projectNativeReviewWindow(input: NativeReviewProjectionInput): NativeReviewWindowDto {
  if (input.observationRecordIds && input.observationRecordIds.length !== input.observations.length) {
    throw new Error('Native Review candidate and source record identity counts disagree')
  }
  const sessionId = nativeReviewSessionId(input.sourceId, input.installationId, input.nativeSessionId)
  const sourceSessionId = `native-source:${stableId([input.sourceId, input.installationId, input.nativeSessionId])}`
  const candidateOccurrences = new Map<string, number>()
  const items: TimelineItemDto[] = input.observations.map((candidate, index) => {
    const recordId = input.observationRecordIds?.[index]
    // Persistent row IDs never enter this path. Source identity must be stable
    // even if the user changes display modes or reopens an original session.
    const nativeKey = recordId ?? candidate.nativeEventId ?? `${candidate.kind}:${candidate.sourceSequence ?? 'unknown'}`
    const withinRecordOrdinal = candidateOccurrences.get(nativeKey) ?? 0
    candidateOccurrences.set(nativeKey, withinRecordOrdinal + 1)
    const id = `native-observation:${stableId([
      sessionId,
      recordId ?? candidate.nativeEventId ?? candidate.sourceSequence ?? 'unspecified',
      candidate.kind,
      candidate.nativeEventId ?? '',
      candidate.sourceSequence ?? '',
      recordId ? withinRecordOrdinal : index,
    ])}`
    const at = candidate.occurredAt ?? candidate.capturedAt
    const payload = jsonValue(candidate.payload)
    return {
      id,
      kind: candidate.kind,
      sourceId: input.sourceId,
      productId: input.sourceId,
      hostId: '',
      installationId: input.installationId,
      logicalSessionId: sessionId,
      sourceSessionId,
      ...(candidate.nativeEventId ? { nativeEventId: candidate.nativeEventId } : {}),
      ...(candidate.nativeParentEventId ? { nativeParentEventId: candidate.nativeParentEventId } : {}),
      ...(candidate.sourceSequence === undefined ? {} : { sourceSequence: candidate.sourceSequence }),
      ...(candidate.occurredAt ? { occurredAt: candidate.occurredAt } : {}),
      capturedAt: candidate.capturedAt,
      effectiveAt: at,
      payload,
      evidence: [],
    }
  })

  return {
    state: 'available',
    sourceId: input.sourceId,
    installationId: input.installationId,
    nativeSessionId: input.nativeSessionId,
    sessionId,
    ...(input.completeBoundaries ? { pagingUnit: 'interaction' as const } : {}),
    interactions: buildInteractions(items, input.startingOrdinal ?? 1).map(interaction => ({
      ...interaction,
      // Stable even if an interaction's global ordinal changes.
      id: `native-review:${stableId([sessionId, interaction.nodes[0]?.id ?? interaction.startedAt])}`,
    })),
    observationCount: items.length,
    hasMore: input.hasMore,
    pendingTail: input.pendingTail,
    nextCursor: input.nextCursor,
    boundaryIntegrity: input.completeBoundaries
      ? 'complete'
      : (input.hasPrevious || input.hasMore || input.pendingTail) ? 'partial' : 'complete',
  }
}
