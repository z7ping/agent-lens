import {
  LIVE_SNAPSHOT_DEFAULT_LIMIT,
  LIVE_SNAPSHOT_MAX_LIMIT,
  type CanonicalObservation,
  type ObservationCursor,
  type StorageService,
  type LiveSnapshotWindow,
} from '@agent-lens/core'
import type { PiLiveRuntimeState, PiLiveSnapshot } from './types'

const CANONICAL_CURSOR_PREFIX = 'canonical:'
const CANONICAL_HISTORY_CHUNK = 240
const CANONICAL_HISTORY_MAX_SCAN = 1_200
const CANONICAL_HISTORY_SOURCE_SESSION_LIMIT = 64

const RENDERABLE_KINDS = new Set<CanonicalObservation['kind']>([
  'message.user',
  'message.assistant',
  'message.reasoning',
  'tool.call',
  'tool.result',
])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function compactOutput(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try { return JSON.stringify(value) ?? '' } catch { return String(value) }
}

function effectiveAt(value: CanonicalObservation): string {
  return value.occurredAt ?? value.capturedAt
}

function observationCursor(value: CanonicalObservation): ObservationCursor {
  const sequence = value.canonicalSequence ?? value.sourceSequence
  return {
    effectiveAt: effectiveAt(value),
    ...(sequence === undefined ? {} : { sequence }),
    id: value.id,
  }
}

export function canonicalHistoryCursor(observationId: string): string {
  return `${CANONICAL_CURSOR_PREFIX}${encodeURIComponent(observationId)}`
}

export function canonicalHistoryObservationId(cursor: string | undefined): string | undefined {
  if (!cursor?.startsWith(CANONICAL_CURSOR_PREFIX)) return undefined
  const raw = cursor.slice(CANONICAL_CURSOR_PREFIX.length)
  if (!raw) return undefined
  try {
    const value = decodeURIComponent(raw)
    return value || undefined
  } catch {
    return undefined
  }
}

export function isCanonicalHistoryCursor(cursor: string | undefined): boolean {
  return canonicalHistoryObservationId(cursor) !== undefined
}

function canonicalEntry(value: CanonicalObservation): Record<string, unknown> | null {
  const payload = record(value.payload)
  const id = canonicalHistoryCursor(value.id)
  const timestamp = effectiveAt(value)

  if (value.kind === 'message.user' || value.kind === 'message.assistant') {
    const role = value.kind === 'message.user' ? 'user' : 'assistant'
    const body = text(payload.text)
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : undefined
    if (!body && !attachments?.length) return null
    return {
      // Deliberately not "message": canonical fallback rows must never expose a
      // Pi-native entry id to message actions after the Worker becomes ready.
      type: 'canonical-message',
      id,
      timestamp,
      message: {
        role,
        content: body,
        ...(attachments?.length ? { attachments } : {}),
      },
    }
  }

  if (value.kind === 'message.reasoning') {
    const body = text(payload.text)
    if (!body) return null
    return {
      type: 'canonical-reasoning',
      id,
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: body }],
      },
    }
  }

  if (value.kind === 'tool.call') {
    const callId = text(payload.callId) || value.id
    const name = text(payload.nativeToolName) || 'tool'
    return {
      type: 'canonical-tool-call',
      id,
      timestamp,
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: callId,
          name,
          ...(payload.input === undefined ? {} : { arguments: payload.input }),
        }],
      },
    }
  }

  if (value.kind === 'tool.result') {
    const callId = text(payload.callId) || value.id
    const name = text(payload.nativeToolName) || 'tool'
    return {
      type: 'canonical-tool-result',
      id,
      timestamp,
      message: {
        role: 'toolResult',
        toolCallId: callId,
        toolName: name,
        content: compactOutput(payload.output),
        isError: payload.success === false,
      },
    }
  }

  return null
}

async function piSourceSessionIds(
  storage: StorageService,
  logicalSessionId: string,
): Promise<Set<string>> {
  const list = storage.repositories.sessions.listSourceSessionsByLogicalSession
  if (!list) return new Set()
  const sessions = await list(logicalSessionId, {
    sourceId: 'pi',
    limit: CANONICAL_HISTORY_SOURCE_SESSION_LIMIT,
  })
  return new Set(sessions.map(item => item.id))
}

async function boundaryObservation(
  storage: StorageService,
  logicalSessionId: string,
  cursor: string | undefined,
): Promise<CanonicalObservation | undefined> {
  const id = canonicalHistoryObservationId(cursor)
  if (!id) return undefined
  const value = await storage.repositories.observations.get(id)
  return value?.logicalSessionId === logicalSessionId ? value : undefined
}

async function collectRenderable(
  storage: StorageService,
  logicalSessionId: string,
  sourceSessionIds: ReadonlySet<string>,
  direction: 'asc' | 'desc',
  target: number,
  boundary?: ObservationCursor,
): Promise<{ items: CanonicalObservation[]; exhausted: boolean }> {
  const items: CanonicalObservation[] = []
  let cursor = boundary
  let scanned = 0
  let exhausted = false

  while (items.length < target && scanned < CANONICAL_HISTORY_MAX_SCAN) {
    const remainingBudget = CANONICAL_HISTORY_MAX_SCAN - scanned
    const batchLimit = Math.min(CANONICAL_HISTORY_CHUNK, remainingBudget)
    const batch = await storage.repositories.observations.query({
      logicalSessionId,
      order: direction,
      limit: batchLimit,
      ...(cursor
        ? direction === 'asc'
          ? { after: cursor }
          : { before: cursor }
        : {}),
    })
    scanned += batch.length
    if (!batch.length) {
      exhausted = true
      break
    }

    for (const item of batch) {
      if (!sourceSessionIds.has(item.sourceSessionId) || !RENDERABLE_KINDS.has(item.kind)) continue
      if (canonicalEntry(item)) items.push(item)
      if (items.length >= target) break
    }

    const tail = batch.at(-1)
    if (!tail || batch.length < batchLimit) {
      exhausted = true
      break
    }
    cursor = observationCursor(tail)
  }

  return { items, exhausted }
}

function snapshotPage(
  observations: readonly CanonicalObservation[],
  options: { hasEarlier: boolean; hasLater: boolean },
): NonNullable<PiLiveSnapshot['page']> {
  const first = observations[0]
  const last = observations.at(-1)
  return {
    hasEarlier: options.hasEarlier,
    ...(options.hasEarlier && first ? { before: canonicalHistoryCursor(first.id) } : {}),
    ...(first ? { first: canonicalHistoryCursor(first.id) } : {}),
    ...(last ? { last: canonicalHistoryCursor(last.id) } : {}),
    ...(options.hasLater && last
      ? { hasLater: true, after: canonicalHistoryCursor(last.id) }
      : {}),
  }
}

export async function canonicalPiLiveSnapshot(
  storage: StorageService,
  state: PiLiveRuntimeState,
  logicalSessionId: string,
  since?: string,
  window: LiveSnapshotWindow = {},
): Promise<PiLiveSnapshot> {
  const sourceSessionIds = await piSourceSessionIds(storage, logicalSessionId)
  if (!sourceSessionIds.size) {
    return { state, entries: [], leafId: null, page: { hasEarlier: false } }
  }

  const requestedLimit = window.limit
  const limit = Number.isInteger(requestedLimit)
    ? Math.max(1, Math.min(LIVE_SNAPSHOT_MAX_LIMIT, requestedLimit!))
    : LIVE_SNAPSHOT_DEFAULT_LIMIT
  const before = window.before
  const after = window.after
  const edge = window.edge
  const around = window.around
  const selectors = [since, before, after, edge, around].filter(Boolean)
  if (selectors.length > 1) throw new Error('Canonical Live history accepts only one cursor or edge selector')
  const forwardCursor = after ?? since

  if (around) {
    const pivot = await boundaryObservation(storage, logicalSessionId, around)
    if (!pivot || !sourceSessionIds.has(pivot.sourceSessionId) || !RENDERABLE_KINDS.has(pivot.kind)) {
      throw new Error('Canonical Live history around cursor was not found')
    }
    const beforeCount = Math.floor((limit - 1) * .3)
    const afterCount = Math.max(0, limit - beforeCount - 1)
    const [older, newer] = await Promise.all([
      collectRenderable(storage, logicalSessionId, sourceSessionIds, 'desc', beforeCount + 1, observationCursor(pivot)),
      collectRenderable(storage, logicalSessionId, sourceSessionIds, 'asc', afterCount + 1, observationCursor(pivot)),
    ])
    const olderItems = older.items.slice(0, beforeCount).reverse()
    const newerItems = newer.items.slice(0, afterCount)
    const observations = [...olderItems, pivot, ...newerItems]
    return {
      state,
      entries: observations.flatMap(item => {
        const entry = canonicalEntry(item)
        return entry ? [entry] : []
      }),
      leafId: null,
      page: snapshotPage(observations, {
        hasEarlier: older.items.length > beforeCount || !older.exhausted,
        hasLater: newer.items.length > afterCount || !newer.exhausted,
      }),
    }
  }

  let direction: 'asc' | 'desc'
  let boundary: CanonicalObservation | undefined
  let hasEarlierBase = false
  let hasLaterBase = false

  if (before) {
    boundary = await boundaryObservation(storage, logicalSessionId, before)
    if (!boundary || !sourceSessionIds.has(boundary.sourceSessionId) || !RENDERABLE_KINDS.has(boundary.kind)) {
      throw new Error('Canonical Live history before cursor was not found')
    }
    direction = 'desc'
    hasLaterBase = true
  } else if (forwardCursor) {
    boundary = await boundaryObservation(storage, logicalSessionId, forwardCursor)
    if (!boundary || !sourceSessionIds.has(boundary.sourceSessionId) || !RENDERABLE_KINDS.has(boundary.kind)) {
      throw new Error('Canonical Live history after cursor was not found')
    }
    direction = 'asc'
    hasEarlierBase = true
  } else if (edge === 'earliest') {
    direction = 'asc'
  } else {
    direction = 'desc'
  }

  const collected = await collectRenderable(
    storage,
    logicalSessionId,
    sourceSessionIds,
    direction,
    limit + 1,
    boundary ? observationCursor(boundary) : undefined,
  )
  const hasExtra = collected.items.length > limit
  const selected = collected.items.slice(0, limit)
  const observations = direction === 'desc' ? selected.reverse() : selected
  const hasEarlier = direction === 'desc'
    ? hasExtra || !collected.exhausted
    : hasEarlierBase
  const hasLater = direction === 'asc'
    ? hasExtra || !collected.exhausted
    : hasLaterBase

  return {
    state,
    entries: observations.flatMap(item => {
      const entry = canonicalEntry(item)
      return entry ? [entry] : []
    }),
    leafId: null,
    page: snapshotPage(observations, { hasEarlier, hasLater }),
  }
}

export const canonicalPiLiveHistoryInternals = {
  CANONICAL_CURSOR_PREFIX,
  CANONICAL_HISTORY_CHUNK,
  CANONICAL_HISTORY_MAX_SCAN,
  canonicalEntry,
  observationCursor,
}
