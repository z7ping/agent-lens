import { createHash } from 'node:crypto'
import type { ObservationCandidate } from '@agent-lens/core'
import {
  type JsonValue,
  type NativeReviewWindowDto,
  type TimelineItemDto,
} from '@agent-lens/protocol'
import { buildInteractions } from './nodes'
import { observedTaskFileChanges, summarizeObservedTaskFileChanges } from '@agent-lens/projection-session'

export interface NativeReviewProjectionInput {
  sourceId: string
  installationId: string
  nativeSessionId: string
  observations: readonly ObservationCandidate[]
  /** Correlates every normalized candidate to its source record, not SQL IDs. */
  observationRecordIds?: readonly string[]
  /** Opaque Source record-start cursors for lazy native media hydration. */
  observationCursors?: readonly string[]
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

export function nativeReviewObservationId(
  sourceId: string, installationId: string, nativeSessionId: string,
  candidate: ObservationCandidate, recordId: string, withinRecordOrdinal: number,
): string {
  const sessionId = nativeReviewSessionId(sourceId, installationId, nativeSessionId)
  return `native-observation:${stableId([
    sessionId, recordId, candidate.kind,
    candidate.nativeEventId ?? '', candidate.sourceSequence ?? '',
    withinRecordOrdinal,
  ])}`
}

export function projectNativeReviewWindow(input: NativeReviewProjectionInput): NativeReviewWindowDto {
  if (input.observationCursors && input.observationCursors.length !== input.observations.length) {
    throw new Error('Native Review candidate and rewind cursor identity counts disagree')
  }
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
    const id = recordId
      ? nativeReviewObservationId(input.sourceId, input.installationId, input.nativeSessionId,
        candidate, recordId, withinRecordOrdinal)
      : `native-observation:${stableId([
          sessionId, candidate.nativeEventId ?? candidate.sourceSequence ?? 'unspecified',
          candidate.kind, candidate.nativeEventId ?? '', candidate.sourceSequence ?? '', index,
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
      ...(candidate.nativeCallId ? { nativeCallId: candidate.nativeCallId } : {}),
      ...(candidate.nativeParentEventId ? { nativeParentEventId: candidate.nativeParentEventId } : {}),
      ...(candidate.sourceSequence === undefined ? {} : { sourceSequence: candidate.sourceSequence }),
      ...(candidate.occurredAt ? { occurredAt: candidate.occurredAt } : {}),
      capturedAt: candidate.capturedAt,
      effectiveAt: at,
      payload,
      evidence: [],
    }
  })

  const attachmentCursors = new Map<string, string>()
  items.forEach((item, index) => {
    const cursor = input.observationCursors?.[index]
    if (cursor && /^native-observation:[0-9a-f]{32}$/.test(item.id)) attachmentCursors.set(item.id, cursor)
  })
  const changedFiles = summarizeObservedTaskFileChanges(observedTaskFileChanges(items))
  const files = changedFiles.slice(0, 64).map(change => ({
    path: change.path,
    changeType: change.changeType,
    ...(change.oldPath ? { oldPath: change.oldPath } : {}),
    firstChangedAt: change.firstChangedAt,
    lastChangedAt: change.lastChangedAt,
    evidence: change.evidence,
    confidence: change.confidence,
  }))

  return {
    state: 'available',
    sourceId: input.sourceId,
    installationId: input.installationId,
    nativeSessionId: input.nativeSessionId,
    sessionId,
    ...(input.completeBoundaries ? { pagingUnit: 'interaction' as const } : {}),
    ...(files.length ? { observedFileChanges: files } : {}),
    ...(changedFiles.length > files.length ? { fileChangesTruncated: true } : {}),
    interactions: buildInteractions(items, input.startingOrdinal ?? 1).map(interaction => ({
      ...interaction,
      // Stable even if an interaction's global ordinal changes.
      id: `native-review:${stableId([sessionId, interaction.nodes[0]?.id ?? interaction.startedAt])}`,
      nodes: interaction.nodes.map(node => {
        const cursor = node.type === 'message' && node.attachments?.length
          ? attachmentCursors.get(node.id) : undefined
        return cursor ? { ...node, nativeAttachmentCursor: cursor } : node
      }),
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
