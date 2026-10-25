import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CapturePolicyService, NativeSessionCatalogQuery, NativeSessionCatalogStore, NativeSessionCatalogEntry } from '@agent-lens/core'
import { badRequest, writeJson } from './http-utils'

const PATH = '/api/v1/native-sessions'
const MAX_IDENTIFIER = 512
const MAX_CURSOR = 2048
const MAX_PAGE = 100

function parseIdentifier(params: URLSearchParams, key: string, maxLength = MAX_IDENTIFIER): string | undefined {
  const entries = params.getAll(key)
  if (entries.length > 1) throw badRequest(`Duplicate ${key}`)
  const item = entries[0]
  if (item === undefined) return undefined
  if (!item.trim() || item.length > maxLength) throw badRequest(`Invalid ${key}`)
  return item
}

function decodeCatalogCursor(value: string | undefined): NativeSessionCatalogQuery['before'] {
  if (value === undefined) return undefined
  if (!value || value.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw badRequest('Invalid native catalog cursor')
  }
  let data: unknown
  try { data = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) }
  catch { throw badRequest('Invalid native catalog cursor') }
  if (!Array.isArray(data) || data.length !== 5
    || data.some(field => typeof field !== 'string' || !field || field.length > MAX_IDENTIFIER)
    || (data[4] !== 'native' && data[4] !== 'archive')) {
    throw badRequest('Invalid native catalog cursor')
  }
  return {
    lastActivityAt: data[0] as string,
    sourceId: data[1] as string,
    installationId: data[2] as string,
    nativeSessionId: data[3] as string,
    locationKind: data[4] as 'native' | 'archive',
  }
}

export function encodeNativeCatalogCursor(value: NativeSessionCatalogEntry): string {
  return Buffer.from(JSON.stringify([
    value.lastActivityAt, value.sourceId, value.installationId,
    value.nativeSessionId, value.locationKind,
  ]), 'utf8').toString('base64url')
}

export async function handleNativeSessionCatalogRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  catalog?: NativeSessionCatalogStore,
  policy?: CapturePolicyService,
): Promise<boolean> {
  if (url.pathname !== PATH) return false
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET')
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }
  if (!catalog || !policy) {
    writeJson(response, 503, { state: 'unavailable', reason: 'native-session-catalog-unavailable' })
    return true
  }
  // Client never receives local file paths or file identities. This index is
  // intentionally independent of the legacy Review's event-store projection.
  const sourceId = parseIdentifier(url.searchParams, 'sourceId')
  const installationId = parseIdentifier(url.searchParams, 'installationId')
  const rawLimit = parseIdentifier(url.searchParams, 'limit')
  const limit = rawLimit === undefined ? 50 : Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw badRequest('Invalid catalog page limit')
  const before = decodeCatalogCursor(parseIdentifier(url.searchParams, 'cursor', MAX_CURSOR))

  if (sourceId && !policy.isSourceEnabled(sourceId)) {
    writeJson(response, 200, { items: [], hasMore: false })
    return true
  }

  const page = await catalog.query({
    ...(sourceId ? { sourceId } : {}),
    ...(installationId ? { installationId } : {}),
    ...(before ? { before } : {}),
    limit,
  })
  const items = page.items
    .filter(item => policy.isSourceEnabled(item.sourceId))
    .map(item => ({
      sourceId: item.sourceId,
      installationId: item.installationId,
      nativeSessionId: item.nativeSessionId,
      locationKind: item.locationKind,
      lastActivityAt: item.lastActivityAt,
      ...(item.title ? { title: item.title } : {}),
    }))
  // Cursor advances using the scanned page, including filtered sources.
  // This prevents repeated pages if a source gets disabled between requests.
  const last = page.items.at(-1)
  writeJson(response, 200, {
    items, hasMore: page.hasMore,
    ...(page.hasMore && last ? { nextCursor: encodeNativeCatalogCursor(last) } : {}),
  })
  return true
}
