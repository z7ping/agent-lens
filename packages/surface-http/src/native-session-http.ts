import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NativeSessionReadQuery, NativeSessionReadResult } from '@agent-lens/core-services'
import type { NativeSessionCatalogStore, ObservationCandidate, SourceNativeSessionCursor } from '@agent-lens/core'
import type { NativeReviewWindowDto } from '@agent-lens/protocol'

import { projectNativeReviewWindow } from '@agent-lens/projection-review'
import { badRequest, writeJson } from './http-utils'

export interface NativeSessionWindowReader {
  read(query: NativeSessionReadQuery): Promise<NativeSessionReadResult>
}

const PATH = '/api/v1/native-sessions/window'
const MAX_IDENTIFIER = 512
const MAX_CURSOR_BYTES = 512
const MAX_LIMIT = 16
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_REVIEW_PAGES = 8
const MAX_REVIEW_TURNS_PER_REQUEST = 4
const MAX_REVIEW_PAGES_PER_REQUEST = 16
const MAX_REVIEW_OBSERVATIONS = 128
// Bound the aggregate *before* allocating a projected Review DTO.
const MAX_REVIEW_INPUT_BYTES = 2 * 1024 * 1024

/**
 * Assemble contiguous, source-validated native pages before running the ONE
 * existing Review grouping projection. This pairs tool calls/results across
 * ordinary byte windows without persisting any events.
 *
 * The cap is deliberate: a turn beyond the budget remains "partial"; callers
 * must not treat this as full-session or safe turn-by-turn pagination yet.
 */
async function readContiguousReviewPages(
  reader: NativeSessionWindowReader,
  query: NativeSessionReadQuery,
  first: Extract<NativeSessionReadResult, {state: 'available'}>,
): Promise<NativeSessionReadResult> {
  let current = first
  let pages = 1
  let observations = [...first.observations]
  let recordIds = [...first.observationRecordIds]
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(observations), 'utf8')
  } catch {
    // The projection owns circular-value handling. Do not expand unbounded.
    bytes = MAX_REVIEW_INPUT_BYTES
  }
  let previousOffset = query.cursor?.offset ?? 0

  while (current.hasMore && !current.pendingTail
    && pages < MAX_REVIEW_PAGES && observations.length < MAX_REVIEW_OBSERVATIONS
    && bytes < MAX_REVIEW_INPUT_BYTES) {
    query.signal.throwIfAborted()
    if (current.nextCursor.offset <= previousOffset) {
      return { state: 'unsupported', reason: 'native-review-cursor-not-advancing' }
    }
    const next = await reader.read({ ...query, cursor: current.nextCursor })
    if (next.state !== 'available') return next // fail closed on drift or lost access
    if (next.nextCursor.fileIdentity !== current.nextCursor.fileIdentity) {
      return { state: 'drifted', reason: 'native-review-file-identity-changed' }
    }
    let nextBytes: number
    try {
      nextBytes = Buffer.byteLength(JSON.stringify(next.observations), 'utf8')
    } catch {
      nextBytes = MAX_REVIEW_INPUT_BYTES
    }
    if (observations.length + next.observations.length > MAX_REVIEW_OBSERVATIONS
      || bytes + nextBytes > MAX_REVIEW_INPUT_BYTES) {
      // The returned cursor still points to the last *included* page.
      break
    }
    observations = [...observations, ...next.observations]
    recordIds = [...recordIds, ...next.observationRecordIds]
    bytes += nextBytes
    previousOffset = current.nextCursor.offset
    current = next
    pages++
  }

  return {
    ...current,
    observations,
    observationRecordIds: recordIds,
    // Evidence must never leave the reader; Review nodes intentionally have
    // no persisted Evidence IDs or raw source locator.
    evidenceCandidates: [],
  }
}


type AvailableNativePage = Extract<NativeSessionReadResult, { state: 'available' }>
type NativeTurnReadResult =
  | { state: 'available'; dto: NativeReviewWindowDto }
  | Extract<NativeSessionReadResult, { state: 'unsupported' | 'unavailable' | 'drifted' }>

function toolCallId(observation: ObservationCandidate): string | undefined {
  const payload = observation.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const fields = payload as Record<string, unknown>
  for (const key of ['callId', 'call_id', 'toolUseId', 'tool_use_id']) {
    if (typeof fields[key] === 'string' && fields[key]) return fields[key] as string
  }
  return undefined
}

/**
 * Explicit opt-in turn pagination. Do not publish a partial user turn as complete:
 * return a boundary-aligned cursor at the *next* user record, not after the
 * already-read native page. Both the cursor and source lines are still verified
 * by the normal NativeSessionReader/isolated Source Worker path.
 */
async function readCompleteNativeTurn(
  reader: NativeSessionWindowReader,
  query: NativeSessionReadQuery,
  initial: AvailableNativePage,
  startingOrdinal: number,
): Promise<NativeTurnReadResult> {
  const observations: ObservationCandidate[] = []
  const observationRecordIds: string[] = []
  const pendingTools = new Set<string>()
  let current = initial
  let pages = 0
  let bytes = 0
  let previousOffset = query.cursor?.offset ?? 0
  let sawUser = false
  let lastRecordStart: SourceNativeSessionCursor | undefined

  const finish = (nextCursor: SourceNativeSessionCursor, hasMore: boolean): NativeTurnReadResult => {
    // A source page can end while a model tool is still running; this is NOT a
    // completed user turn, even when the file has no further full records yet.
    if (pendingTools.size > 0) {
      return { state: 'unsupported', reason: 'native-review-turn-tool-pending' }
    }
    // Metadata-only native sessions and leading background records are not
    // permission to fabricate a finished user turn or advance its ordinal.
    if (!sawUser) {
      return { state: 'unsupported', reason: 'native-review-no-user-turn' }
    }
    const base = projectNativeReviewWindow({
      sourceId: query.sourceId,
      installationId: query.installationId,
      nativeSessionId: query.nativeSessionId,
      observations, observationRecordIds,
      hasMore, pendingTail: false,
      hasPrevious: query.cursor !== undefined,
      nextCursor: '',
      startingOrdinal,
      completeBoundaries: true,
    })
    return {
      state: 'available',
      dto: {
        ...base,
        nextCursor: encodeNativeSessionCursor({
          ...nextCursor,
          mode: 'review-turns',
          turnOrdinal: startingOrdinal + base.interactions.length,
        }),
      },
    }
  }

  while (pages < MAX_REVIEW_PAGES) {
    query.signal.throwIfAborted()
    // Other Source adapters have not proved rewind-point support. Fail closed
    // rather than fabricate an "exact" turn boundary.
    if (!current.observationCursors
      || current.observationCursors.length !== current.observations.length
      || current.observationRecordIds.length !== current.observations.length) {
      return { state: 'unsupported', reason: 'native-review-record-boundaries-unavailable' }
    }
    let pageBytes: number
    try {
      pageBytes = Buffer.byteLength(JSON.stringify(current.observations), 'utf8')
    } catch {
      return { state: 'unsupported', reason: 'native-review-input-not-serializable' }
    }
    if (bytes + pageBytes > MAX_REVIEW_INPUT_BYTES
      || observations.length + current.observations.length > MAX_REVIEW_OBSERVATIONS) {
      return { state: 'unsupported', reason: 'native-review-turn-exceeds-budget' }
    }
    bytes += pageBytes
    for (let index = 0; index < current.observations.length; index++) {
      const observation = current.observations[index]!
      const recordCursor = current.observationCursors[index]!
      if (recordCursor.fileIdentity !== current.nextCursor.fileIdentity
        || !Number.isSafeInteger(recordCursor.offset)
        || recordCursor.offset < previousOffset
        || recordCursor.offset >= current.nextCursor.offset
        || !Number.isSafeInteger(recordCursor.sequence) || recordCursor.sequence < 0
        || (lastRecordStart && recordCursor.offset < lastRecordStart.offset)) {
        return { state: 'drifted', reason: 'native-review-record-boundary-drifted' }
      }
      if (query.cursor && observations.length === 0 && index === 0
        && (observation.kind !== 'message.user' || recordCursor.offset !== query.cursor.offset)) {
        return { state: 'unsupported', reason: 'native-review-cursor-not-turn-boundary' }
      }
      const isNewRecord = !lastRecordStart || recordCursor.offset !== lastRecordStart.offset
      if (sawUser && observation.kind === 'message.user' && isNewRecord) {
        // An unresolved tool could return after this user message. The
        // existing per-interaction tool grouping cannot safely pair it.
        if (pendingTools.size > 0) {
          return { state: 'unsupported', reason: 'native-review-cross-turn-tool-pending' }
        }
        return finish(recordCursor, true)
      }
      observations.push(observation)
      observationRecordIds.push(current.observationRecordIds[index]!)
      if (observation.kind === 'message.user') sawUser = true
      const callId = toolCallId(observation)
      if (callId && observation.kind === 'tool.call') pendingTools.add(callId)
      if (callId && observation.kind === 'tool.result') pendingTools.delete(callId)
      lastRecordStart = recordCursor
    }
    pages++
    if (current.pendingTail) {
      return { state: 'unsupported', reason: 'native-review-turn-pending-tail' }
    }
    if (!current.hasMore) return finish(current.nextCursor, false)
    if (pages >= MAX_REVIEW_PAGES
      || observations.length >= MAX_REVIEW_OBSERVATIONS
      || bytes >= MAX_REVIEW_INPUT_BYTES) {
      return { state: 'unsupported', reason: 'native-review-turn-exceeds-budget' }
    }
    if (current.nextCursor.offset <= previousOffset) {
      return { state: 'unsupported', reason: 'native-review-cursor-not-advancing' }
    }
    previousOffset = current.nextCursor.offset
    const next = await reader.read({ ...query, cursor: current.nextCursor })
    if (next.state !== 'available') return next
    if (next.nextCursor.fileIdentity !== current.nextCursor.fileIdentity) {
      return { state: 'drifted', reason: 'native-review-file-identity-changed' }
    }
    current = next
  }
  return { state: 'unsupported', reason: 'native-review-turn-exceeds-budget' }
}

/**
 * One HTTP request may hydrate several *complete* consecutive turns, but never
 * create a new grouping implementation or keep a complete session in memory.
 * Source calls (including the initial read) are bounded across the whole
 * request: per-turn budgets alone are not a sufficient overall bound.
 */
async function readCompleteNativeTurns(
  reader: NativeSessionWindowReader,
  query: NativeSessionReadQuery,
  first: AvailableNativePage,
  startingOrdinal: number,
  turnLimit: number,
): Promise<NativeTurnReadResult> {
  let sourcePages = 1
  const boundedReader: NativeSessionWindowReader = {
    async read(input) {
      if (sourcePages >= MAX_REVIEW_PAGES_PER_REQUEST) {
        return { state: 'unsupported', reason: 'native-review-request-page-budget' }
      }
      sourcePages += 1
      return reader.read(input)
    },
  }
  let page = first
  let queryAt = query
  let ordinal = startingOrdinal
  let assembled: NativeReviewWindowDto | undefined
  for (let turn = 0; turn < turnLimit; turn++) {
    const next = await readCompleteNativeTurn(boundedReader, queryAt, page, ordinal)
    if (next.state !== 'available') return next
    const value = next.dto
    assembled = assembled
      ? {
          ...assembled,
          interactions: [...assembled.interactions, ...value.interactions],
          observationCount: assembled.observationCount + value.observationCount,
          observedFileChanges: [...(assembled.observedFileChanges ?? []), ...(value.observedFileChanges ?? [])].slice(0,64),
          ...(assembled.fileChangesTruncated || value.fileChangesTruncated
            || (assembled.observedFileChanges?.length ?? 0) + (value.observedFileChanges?.length ?? 0) > 64
            ? { fileChangesTruncated: true } : {}),
          hasMore: value.hasMore,
          nextCursor: value.nextCursor,
          boundaryIntegrity: 'complete',
        }
      : value
    if (!value.hasMore) break
    if (turn === turnLimit - 1) break
    const cursor = decodeCursor(value.nextCursor)
    if (!cursor || cursor.mode !== 'review-turns'
      || cursor.turnOrdinal === undefined
      || cursor.turnOrdinal <= ordinal
      || cursor.fileIdentity !== page.nextCursor.fileIdentity) {
      return { state: 'unsupported', reason: 'native-review-next-turn-cursor-invalid' }
    }
    ordinal = cursor.turnOrdinal
    queryAt = { ...query, cursor }
    const incoming = await boundedReader.read(queryAt)
    if (incoming.state !== 'available') return incoming
    if (incoming.nextCursor.fileIdentity !== cursor.fileIdentity) {
      return { state: 'drifted', reason: 'native-review-file-identity-changed' }
    }
    page = incoming
  }
  return assembled
    ? { state: 'available', dto: assembled }
    : { state: 'unsupported', reason: 'native-review-no-user-turn' }
}

function identifier(params: URLSearchParams, key: string): string {
  const values = params.getAll(key)
  if (values.length !== 1 || !values[0] || values[0]!.length > MAX_IDENTIFIER) {
    throw badRequest(`${key} must be a single nonempty identifier of at most ${MAX_IDENTIFIER} characters`)
  }
  return values[0]!
}

type EncodedNativeCursor = SourceNativeSessionCursor & {
  mode?: 'review-turns'
  turnOrdinal?: number
}

function decodeCursor(value: string | null): EncodedNativeCursor | undefined {
  if (value === null) return undefined
  if (!value || value.length > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw badRequest('Invalid native session cursor')
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw badRequest('Invalid native session cursor')
    }
    const cursor = decoded as Record<string, unknown>
    if (!Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0
      || !Number.isSafeInteger(cursor.sequence) || (cursor.sequence as number) < 0
      || typeof cursor.fileIdentity !== 'string'
      || !cursor.fileIdentity || cursor.fileIdentity.length > 128
      || !(Object.keys(cursor).length === 3
        || (Object.keys(cursor).length === 5
          && cursor.mode === 'review-turns'
          && Number.isSafeInteger(cursor.turnOrdinal)
          && (cursor.turnOrdinal as number) >= 1))) {
      throw badRequest('Invalid native session cursor')
    }
    return {
      offset: cursor.offset as number,
      sequence: cursor.sequence as number,
      fileIdentity: cursor.fileIdentity,
      ...(cursor.mode === 'review-turns'
        ? { mode: 'review-turns' as const, turnOrdinal: cursor.turnOrdinal as number }
        : {}),
    }
  } catch {
    throw badRequest('Invalid native session cursor')
  }
}

export function encodeNativeSessionCursor(cursor: EncodedNativeCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/**
 * A controlled, opt-in transport for native window experiments. The client
 * supplies only Source/Installation/Session identity and an opaque cursor,
 * NEVER a source-owned file path. This does not switch the existing Review DTO.
 */
export async function handleNativeSessionWindowRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  reader?: NativeSessionWindowReader,
  catalog?: NativeSessionCatalogStore,
): Promise<boolean> {
  const byId = url.pathname.match(/^\/api\/v1\/native-sessions\/([^/]+)\/review$/)
  if (url.pathname !== PATH && !byId) return false
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET')
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }
  if (!reader) {
    writeJson(response, 503, { state: 'unavailable', reason: 'native-session-reader-unavailable' })
    return true
  }

  let requestedUrl = url
  if (byId) {
    if (!catalog) {
      writeJson(response, 503, { state: 'unavailable', reason: 'native-session-catalog-unavailable' })
      return true
    }
    const nativeReviewId = (() => {
      try { return decodeURIComponent(byId[1]!) }
      catch { return '' }
    })()
    if (!/^native:[0-9a-f]{32}$/.test(nativeReviewId)) {
      writeJson(response, 404, { error: 'not_found' })
      return true
    }
    // A stable ID has exactly one Catalog-owned Source triple; callers cannot
    // override it or ask a direct-link handler for incomplete raw windows.
    if (['sourceId', 'installationId', 'nativeSessionId', 'filePath', 'path', 'root'].some(key =>
      url.searchParams.has(key))
      || (url.searchParams.has('format')
        && url.searchParams.get('format') !== 'review-turns')) {
      throw badRequest('Native Review by ID only accepts its own cursor, turnLimit and review-turns format')
    }
    const entry = await catalog.getByReviewSessionId(nativeReviewId)
    if (!entry || entry.locationKind !== 'native') {
      writeJson(response, 404, { error: 'not_found' })
      return true
    }
    requestedUrl = new URL(url)
    requestedUrl.pathname = PATH
    requestedUrl.searchParams.set('sourceId', entry.sourceId)
    requestedUrl.searchParams.set('installationId', entry.installationId)
    requestedUrl.searchParams.set('nativeSessionId', entry.nativeSessionId)
    requestedUrl.searchParams.set('format', 'review-turns')
  }

  const sourceId = identifier(requestedUrl.searchParams, 'sourceId')
  const installationId = identifier(requestedUrl.searchParams, 'installationId')
  const nativeSessionId = identifier(requestedUrl.searchParams, 'nativeSessionId')
  if (requestedUrl.searchParams.has('filePath') || requestedUrl.searchParams.has('path') || requestedUrl.searchParams.has('root')) {
    throw badRequest('Raw file paths are not accepted by native window requests')
  }
  const rawLimit = requestedUrl.searchParams.get('limit')
  const limit = rawLimit === null ? 8 : Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest(`Native window limit must be between 1 and ${MAX_LIMIT}`)
  }
  if (requestedUrl.searchParams.getAll('cursor').length > 1 || requestedUrl.searchParams.getAll('limit').length > 1) {
    throw badRequest('Duplicate native window parameters')
  }
  const formatValues = requestedUrl.searchParams.getAll('format')
  if (formatValues.length > 1
    || (formatValues.length === 1 && !['review', 'review-turns'].includes(formatValues[0]!))) {
    throw badRequest('Unsupported native window format')
  }
  const cursor = decodeCursor(requestedUrl.searchParams.get('cursor'))
  const turnMode = formatValues[0] === 'review-turns'
  const turnLimitValues = requestedUrl.searchParams.getAll('turnLimit')
  const turnLimit = turnLimitValues.length === 0 ? 1 : Number(turnLimitValues[0])
  if (turnLimitValues.length > 1 || (turnLimitValues.length && !turnMode)
    || !Number.isSafeInteger(turnLimit) || turnLimit < 1
    || turnLimit > MAX_REVIEW_TURNS_PER_REQUEST) {
    throw badRequest('Invalid native complete-turn request limit')
  }
  if ((turnMode && cursor && cursor.mode !== 'review-turns')
    || (!turnMode && cursor?.mode === 'review-turns')) {
    throw badRequest('Native session cursor does not match the requested format')
  }

  const abort = new AbortController()
  const close = () => {
    if (!response.writableEnded) abort.abort()
  }
  response.once('close', close)
  try {
    const readQuery: NativeSessionReadQuery = {
      sourceId,
      installationId,
      nativeSessionId,
      limit,
      ...(cursor ? { cursor } : {}),
      signal: abort.signal,
    }
    const first = await reader.read(readQuery)
    if (turnMode) {
      const complete = first.state === 'available'
        ? await readCompleteNativeTurns(reader, readQuery, first, cursor?.turnOrdinal ?? 1, turnLimit)
        : first
      if (abort.signal.aborted || response.destroyed) return true
      if (complete.state !== 'available') {
        writeJson(response, 200, complete)
      } else if (Buffer.byteLength(JSON.stringify(complete.dto), 'utf8') > MAX_RESPONSE_BYTES) {
        writeJson(response, 413, { state: 'unsupported', reason: 'native-window-response-too-large' })
      } else {
        writeJson(response, 200, complete.dto)
      }
      return true
    }
    const result = formatValues[0] === 'review' && first.state === 'available'
      ? await readContiguousReviewPages(reader, readQuery, first)
      : first
    if (abort.signal.aborted || response.destroyed) return true
    if (result.state !== 'available') {
      writeJson(response, 200, result)
      return true
    }
    // Source reader has already enforced CapturePolicy. Never forward raw
    // EvidenceCandidate.sourceLocator.path or SourceRecord payloads.
    const safeResponse = formatValues[0] === 'review' ? projectNativeReviewWindow({
      sourceId, installationId, nativeSessionId,
      observations: result.observations,
      ...(result.observationRecordIds ? { observationRecordIds: result.observationRecordIds } : {}),
      hasMore: result.hasMore,
      pendingTail: result.pendingTail,
      hasPrevious: cursor !== undefined,
      nextCursor: encodeNativeSessionCursor(result.nextCursor),
    }) : {
      state: 'available' as const,
      observations: result.observations,
      nextCursor: encodeNativeSessionCursor(result.nextCursor),
      hasMore: result.hasMore,
      pendingTail: result.pendingTail,
    }
    if (Buffer.byteLength(JSON.stringify(safeResponse), 'utf8') > MAX_RESPONSE_BYTES) {
      writeJson(response, 413, { state: 'unsupported', reason: 'native-window-response-too-large' })
    } else {
      writeJson(response, 200, safeResponse)
    }
    return true
  } finally {
    response.off('close', close)
  }
}
