import { createHash } from 'node:crypto'
import type { EvidenceCandidate, ObservationCandidate } from '@agent-lens/core'
import {
  type JsonValue,
  type NativeReviewWindowDto,
  type TimelineItemDto,
  type TimelineEvidenceDto,
} from '@agent-lens/protocol'
import { buildInteractionGroups, buildInteractions } from './nodes'
import { observedTaskFileChanges, summarizeObservedTaskFileChanges } from '@agent-lens/projection-session'

export interface NativeReviewProjectionInput {
  sourceId: string
  installationId: string
  nativeSessionId: string
  observations: readonly ObservationCandidate[]
  /** Correlates every normalized candidate to its source record, not SQL IDs. */
  observationRecordIds?: readonly string[]
  /** Source-normalized, policy-sanitized provenance only; never expose raw locators. */
  evidenceCandidates?: readonly EvidenceCandidate[]
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
  /** Stable source-owned first-user record offset. Fragments share one semantic turn. */
  singleUserTurnOffset?: number
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
  const provenance = new Map<string, TimelineEvidenceDto[]>()
  // A candidate must explicitly name the same SourceRecord that produced
  // the observation. Timestamp or payload similarity is not sufficient
  // evidence to attach a fact to a particular interaction.
  const presentRecords = new Set(input.observationRecordIds ?? [])
  for (const candidate of input.evidenceCandidates ?? []) {
    const recordId = candidate.sourceRecordId
    if (!recordId || !presentRecords.has(recordId)) continue
    const row = provenance.get(recordId) ?? []
    if (row.length >= 8) continue // bounded per record, not an SQL evidence copy
    const id = `native-evidence:${stableId([
      sessionId, recordId, candidate.captureMethod, candidate.derivation,
      candidate.nativeStableId ?? '', candidate.parserVersion ?? '',
      candidate.eventTime ?? '', row.length,
    ])}`
    row.push({
      id,
      captureMethod: candidate.captureMethod,
      derivation: candidate.derivation,
      confidence: candidate.confidenceHint ?? 'unknown',
      ...(candidate.parserVersion ? {parserVersion:candidate.parserVersion} : {}),
      ...(candidate.eventTime ? {eventTime:candidate.eventTime} : {}),
      capturedAt: candidate.capturedAt,
      // Raw sourceLocator/path and candidate.missingReason never reach HTTP.
      // Source-owned IDs only participate in the opaque derived evidence ID.
    })
    provenance.set(recordId, row)
  }
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
      evidence: recordId ? (provenance.get(recordId) ?? []) : [],
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
    ...(input.completeBoundaries || input.singleUserTurnOffset !== undefined
      ? { pagingUnit: 'interaction' as const } : {}),
    ...(files.length ? { observedFileChanges: files } : {}),
    ...(changedFiles.length > files.length ? { fileChangesTruncated: true } : {}),
    interactions: (input.singleUserTurnOffset === undefined
      ? buildInteractions(items, input.startingOrdinal ?? 1)
      : items.length ? buildInteractionGroups([items], input.startingOrdinal ?? 1) : []
    ).map(interaction => ({
      ...interaction,
      // Stable even if an interaction's global ordinal changes.
      id: `native-review:${stableId([sessionId, input.singleUserTurnOffset === undefined
        ? interaction.nodes[0]?.id ?? interaction.startedAt : `user-offset:${input.singleUserTurnOffset}`])}`,
      ...(input.singleUserTurnOffset === undefined ? {} : {trigger:'user' as const}),
      nodes: interaction.nodes.map(node => {
        const cursor = node.type === 'message' && node.attachments?.length
          ? attachmentCursors.get(node.id) : undefined
        // A tool result may share the same original SourceRecord provenance
        // as its call. Retain one evidence edge per stable evidence ID.
        const evidence = [...new Map(node.evidence.map(item => [item.id, item])).values()]
        return {
          ...node,
          evidence,
          ...(cursor ? { nativeAttachmentCursor: cursor } : {}),
        }
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

/**
 * Attach only timestamp-attested, Hook-exclusive event facts to a complete
 * native user turn. Never overlay Hook tool calls/results or user messages:
 * their identity, ordering and cross-source pairing are NOT established by
 * timestamp proximity. The standalone Hook lane remains authoritative for
 * those ambiguous facts until explicit native-event correlation is available.
 *
 * This is a projection only: Source originals stay source-owned, with no new
 * SQL Observation, Evidence, or duplicated message payload.
 */
export function overlayNativeHookEvents(input: {
  window: NativeReviewWindowDto
  observations: readonly ObservationCandidate[]
  observationRecordIds: readonly string[]
  truncated: boolean
}): NativeReviewWindowDto {
  const { window, observations, observationRecordIds } = input
  if (window.boundaryIntegrity !== 'complete' || window.pagingUnit !== 'interaction') {
    throw new Error('Hook overlay requires a complete native user-turn window')
  }
  if (observations.length !== observationRecordIds.length) {
    throw new Error('Hook overlay requires exact source record provenance')
  }
  const kinds = new Set<ObservationCandidate['kind']>([
    'permission.request', 'permission.response',
    'subagent.spawn', 'subagent.end',
    'context.compaction', 'context.injected',
  ])
  // Require a true native occurrence time. A processing/capture timestamp is
  // not evidence that a Hook belongs to the nearby user turn.
  const selected = observations.flatMap((observation, index) => {
    // Source runtimes may fill occurredAt from Hook capture time when the
    // original event has no clock. Equal values are therefore insufficient
    // evidence for cross-source placement (even if some are truly equal).
    const attested = observation.occurredAt
      && observation.occurredAt !== observation.capturedAt
    const millis = attested ? Date.parse(observation.occurredAt!) : NaN
    // An identity alone is not evidence of lifecycle-wide uniqueness:
    // a tool call ID may be reused outside the currently loaded page.
    // Require a Source-attested event time even for exact ID matching.
    return kinds.has(observation.kind) && Number.isFinite(millis)
      ? [{ observation, recordId: observationRecordIds[index]! }]
      : []
  })
  if (!selected.length || !window.interactions.length) {
    return {
      ...window,
      ...(input.truncated ? { hookEventsTruncated: true } : {}),
      // There is no durable per-session Hook capture-completeness certificate.
      // Even an empty archive does not prove that no events occurred before
      // the Source-owned archive was enabled.
      hookFactsPartial: true,
    }
  }
  const projected = projectNativeReviewWindow({
    sourceId: window.sourceId,
    installationId: window.installationId,
    nativeSessionId: window.nativeSessionId,
    observations: selected.map(item => item.observation),
    observationRecordIds: selected.map(item => item.recordId),
    hasMore: false, pendingTail: false, nextCursor: '',
    hasPrevious: false,
  })
  const candidates = projected.interactions.flatMap(item => item.nodes)
    .filter((node): node is Extract<typeof node, {type:'event'}> => node.type === 'event')
  const seenIds = new Set(window.interactions.flatMap(turn => turn.nodes.map(node => node.id)))
  const nativeFactKey = (kind: string, nativeEventId: string) =>
    JSON.stringify([kind, nativeEventId])
  const existingSourceFacts = new Set(window.interactions.flatMap(turn => turn.nodes)
    .flatMap(node => node.type === 'event' && node.nativeEventId
      ? [nativeFactKey(node.kind, node.nativeEventId)] : []))
  // Content and timestamps are NOT provenance. Two independent approval or
  // subagent facts may have identical payloads and clocks; dropping one by
  // similarity silently loses Source-owned evidence.
  const explicitOwners = new Map<string, Set<string>>()
  const identityKey = (kind: 'event' | 'call', id: string) => JSON.stringify([kind, id])
  for (const turn of window.interactions.filter(item => item.trigger === 'user')) {
    for (const native of turn.nodes) {
      const keys = [
        ...(native.nativeEventId ? [identityKey('event', native.nativeEventId)] : []),
        ...(native.type === 'tool' && native.callId ? [identityKey('call', native.callId)] : []),
      ]
      for (const key of keys) {
        const owners = explicitOwners.get(key) ?? new Set<string>()
        owners.add(turn.id)
        explicitOwners.set(key, owners)
      }
    }
  }
  const added = new Map<string, typeof candidates>()
  for (const node of candidates) {
    if (seenIds.has(node.id)
      || (node.nativeEventId && existingSourceFacts.has(nativeFactKey(node.kind, node.nativeEventId)))) continue
    const correlationKeys = [
      ...(node.nativeParentEventId ? [identityKey('event', node.nativeParentEventId)] : []),
      ...(node.nativeCallId ? [identityKey('call', node.nativeCallId)] : []),
    ]
    let matching: typeof window.interactions[number] | undefined
    if (correlationKeys.length) {
      // Every supplied identity must independently resolve to the SAME
      // single native user turn. Unknown, reused or conflicting IDs fail
      // closed: time proximity cannot override explicit source evidence.
      const owners = correlationKeys.map(key => explicitOwners.get(key))
      if (owners.some(value => value?.size !== 1)) continue
      const ownerId = owners[0]!.values().next().value
      if (owners.some(value => !value!.has(ownerId!))) continue
      matching = window.interactions.find(turn => turn.id === ownerId)
    } else {
      const at = Date.parse(node.at)
      // Without a Source-native ID, the timestamp must identify precisely
      // one complete turn; simultaneous turn boundaries are ambiguous.
      const possibleTurns = window.interactions.filter(turn => {
        const start = Date.parse(turn.startedAt)
        const end = Date.parse(turn.endedAt)
        return turn.trigger === 'user' && Number.isFinite(start)
          && Number.isFinite(end) && at >= start && at <= end
      })
      if (possibleTurns.length !== 1) continue
      matching = possibleTurns[0]
    }
    if (!matching) continue
    // Uniqueness within this loaded page is not uniqueness across the entire
    // native session. Bound even an exact call/parent ID to the attested
    // occurrence interval of the selected complete user turn.
    const eventAt = Date.parse(node.occurredAt ?? '')
    const turnStart = Date.parse(matching.startedAt)
    const turnEnd = Date.parse(matching.endedAt)
    if (!Number.isFinite(eventAt) || !Number.isFinite(turnStart)
      || !Number.isFinite(turnEnd) || eventAt < turnStart || eventAt > turnEnd) continue
    const events = added.get(matching.id) ?? []
    events.push(node)
    added.set(matching.id, events)
    seenIds.add(node.id)
    if (node.nativeEventId) existingSourceFacts.add(nativeFactKey(node.kind, node.nativeEventId))
  }
  let mergedCount = 0
  const interactions = window.interactions.map(turn => {
    const events = added.get(turn.id)
    if (!events?.length) return turn
    // Preserve native ordering at the same timestamp; Hooks are placed after
    // existing native facts rather than before the verified user prompt.
    const combined = [
      ...turn.nodes.map((node, index) => ({node, index})),
      ...events.map((node, index) => ({node, index: turn.nodes.length + index})),
    ].sort((a,b) => Date.parse(a.node.at)-Date.parse(b.node.at) || a.index-b.index)
    mergedCount += events.length
    return {...turn, nodes: combined.map(item => item.node)}
  })
  return {
    ...window,
    interactions,
    observationCount: window.observationCount + mergedCount,
    ...(input.truncated ? {hookEventsTruncated: true} : {}),
    // A directory snapshot proves a consistent page, NOT full runtime
    // coverage. Source-only events before archival activation remain unknown.
    hookFactsPartial: true,
  }
}
