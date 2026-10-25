import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NativeSessionReadQuery, NativeSessionReadResult } from '@agent-lens/core-services'
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

function identifier(params: URLSearchParams, key: string): string {
  const values = params.getAll(key)
  if (values.length !== 1 || !values[0] || values[0]!.length > MAX_IDENTIFIER) {
    throw badRequest(`${key} must be a single nonempty identifier of at most ${MAX_IDENTIFIER} characters`)
  }
  return values[0]!
}

function decodeCursor(value: string | null): NativeSessionReadQuery['cursor'] {
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
      || Object.keys(cursor).length !== 3) {
      throw badRequest('Invalid native session cursor')
    }
    return { offset: cursor.offset as number, sequence: cursor.sequence as number, fileIdentity: cursor.fileIdentity }
  } catch {
    throw badRequest('Invalid native session cursor')
  }
}

export function encodeNativeSessionCursor(cursor: NonNullable<NativeSessionReadQuery['cursor']>): string {
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
): Promise<boolean> {
  if (url.pathname !== PATH) return false
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET')
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }
  if (!reader) {
    writeJson(response, 503, { state: 'unavailable', reason: 'native-session-reader-unavailable' })
    return true
  }

  const sourceId = identifier(url.searchParams, 'sourceId')
  const installationId = identifier(url.searchParams, 'installationId')
  const nativeSessionId = identifier(url.searchParams, 'nativeSessionId')
  if (url.searchParams.has('filePath') || url.searchParams.has('path') || url.searchParams.has('root')) {
    throw badRequest('Raw file paths are not accepted by native window requests')
  }
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? 8 : Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest(`Native window limit must be between 1 and ${MAX_LIMIT}`)
  }
  if (url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('limit').length > 1) {
    throw badRequest('Duplicate native window parameters')
  }
  const formatValues = url.searchParams.getAll('format')
  if (formatValues.length > 1 || (formatValues.length === 1 && formatValues[0] !== 'review')) {
    throw badRequest('Unsupported native window format')
  }
  const cursor = decodeCursor(url.searchParams.get('cursor'))

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
