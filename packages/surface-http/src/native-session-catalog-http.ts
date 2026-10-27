import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CapturePolicyService, NativeSessionCatalogQuery, NativeSessionCatalogStore, NativeSessionCatalogEntry, NativeSessionListReader, SourceService } from '@agent-lens/core'
import { nativeReviewSessionId } from '@agent-lens/projection-review'
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

export function encodeNativeCatalogCursor(value: Pick<NativeSessionCatalogEntry,
  'lastActivityAt'|'sourceId'|'installationId'|'nativeSessionId'|'locationKind'>): string {
  return Buffer.from(JSON.stringify([
    value.lastActivityAt, value.sourceId, value.installationId,
    value.nativeSessionId, value.locationKind,
  ]), 'utf8').toString('base64url')
}

export async function handleNativeSessionCatalogRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  catalog?: Pick<NativeSessionCatalogStore,'getByReviewSessionId'|'query'>,
  policy?: CapturePolicyService,
  nativeList?: NativeSessionListReader,
  sources?: SourceService,
): Promise<boolean> {
  const encodedSessionId = url.pathname.startsWith(`${PATH}/`)
    ? url.pathname.slice(PATH.length + 1)
    : ''
  let sessionId: string | undefined
  if (encodedSessionId && !encodedSessionId.includes('/')) {
    try {
      const decoded = decodeURIComponent(encodedSessionId)
      if (/^native:[0-9a-f]{32}$/.test(decoded)) sessionId = decoded
    } catch {
      // Malformed native IDs never fall through to a broad Catalog scan.
    }
  }
  if (url.pathname !== PATH && !sessionId) return false
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET')
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }
  if (!catalog || !policy) {
    writeJson(response, 503, { state: 'unavailable', reason: 'native-session-catalog-unavailable' })
    return true
  }
  // A direct Review deep-link resolves by indexed native identity rather
  // than scanning thousands of Source-owned session locations.
  if (sessionId) {
    const entry = await catalog.getByReviewSessionId(sessionId)
    if (!entry || !policy.isSourceEnabled(entry.sourceId)) {
      writeJson(response, 404, { error: 'not_found' })
      return true
    }
    // The direct route must use the same Slim context/title join as the
    // indexed task list; otherwise a deep link loses its project identity.
    const indexed = nativeList && entry.locationKind === 'native'
      ? (await nativeList.query({reviewSessionId:sessionId,limit:1})).items[0]
      : undefined
    const match = indexed
      && indexed.reviewSessionId === sessionId
      && indexed.sourceId === entry.sourceId
      && indexed.installationId === entry.installationId
      && indexed.nativeSessionId === entry.nativeSessionId
      ? indexed : undefined
    writeJson(response, 200, {
      id: sessionId,
      sourceId: entry.sourceId,
      installationId: entry.installationId,
      nativeSessionId: entry.nativeSessionId,
      locationKind: entry.locationKind,
      lastActivityAt: entry.lastActivityAt,
      ...((match?.title ?? entry.title) ? {title:match?.title??entry.title}:{}),
      ...(match ? {
        titleProvenance:match.titleProvenance,
        ...(match.projectId?{projectId:match.projectId}:{}),
        ...(match.projectName?{projectName:match.projectName}:{}),
        ...(match.workspacePath?{workspacePath:match.workspacePath}:{}),
      }:{}),
    })
    return true
  }
  // Client never receives local file paths or file identities. This index is
  // intentionally independent of the legacy Review's event-store projection.
  const search = parseIdentifier(url.searchParams, 'search', 256)
  const sourceId = parseIdentifier(url.searchParams, 'sourceId')
  const installationId = parseIdentifier(url.searchParams, 'installationId')
  // Project association is resolved against native_session_context on Slim.
  // The filter never reads Canonical Observation or legacy session rows.
  const projectId = parseIdentifier(url.searchParams, 'projectId')
  const rawLimit = parseIdentifier(url.searchParams, 'limit')
  const limit = rawLimit === undefined ? 50 : Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw badRequest('Invalid catalog page limit')
  const before = decodeCatalogCursor(parseIdentifier(url.searchParams, 'cursor', MAX_CURSOR))

  if (sourceId && !policy.isSourceEnabled(sourceId)) {
    writeJson(response, 200, { items: [], hasMore: false })
    return true
  }

  // Once the slim runtime is installed, project/summary queries no longer
  // pass through the legacy SQL SessionSummary projection. The result has
  // explicit missing/stale/partial statistics instead of fake zero totals.
  if (nativeList) {
    const declaration = sourceId
      ? sources?.list().find(item=>item.manifest.sourceId===sourceId)
      : undefined
    const page = await nativeList.query({
      ...(sourceId?{sourceId}:{}),
      ...(installationId?{installationId}:{}),
      ...(projectId?{projectId}:{}),
      ...(search?{search}:{}),
      ...(before?{before:{
        lastActivityAt:before.lastActivityAt,sourceId:before.sourceId,
        installationId:before.installationId,
        nativeSessionId:before.nativeSessionId,
      }}:{}),
      ...(declaration?{
        parserVersion:declaration.manifest.parserVersion,
        coverageCertified:declaration.nativeSessionCoverageComplete===true,
      }:{}),
      ...(!sourceId&&sources?{
        sourceCertifications:sources.list().map(source=>({
          sourceId:source.manifest.sourceId,
          parserVersion:source.manifest.parserVersion,
          coverageCertified:source.nativeSessionCoverageComplete===true,
        })),
      }:{}),
      limit,
    })
    const items=page.items
      .filter(item=>policy.isSourceEnabled(item.sourceId))
      .map(item=>({
        id:item.reviewSessionId,
        sourceId:item.sourceId,installationId:item.installationId,
        nativeSessionId:item.nativeSessionId,locationKind:'native' as const,
        lastActivityAt:item.lastActivityAt,
        ...(item.title?{title:item.title}:{}),
        titleProvenance:item.titleProvenance,
        ...(item.projectId?{projectId:item.projectId}:{}),
        ...(item.projectName?{projectName:item.projectName}:{}),
        ...(item.workspacePath?{workspacePath:item.workspacePath}:{}),
        metricsState:item.metricsState,
        ...(item.metrics?{metrics:item.metrics}:{}),
      }))
    const last=page.items.at(-1)
    writeJson(response,200,{
      items,hasMore:page.hasMore,
      ...(page.hasMore&&last?{
        nextCursor:encodeNativeCatalogCursor({...last,locationKind:'native'}),
      }:{}),
    })
    return true
  }

  const page = await catalog.query({
    ...(sourceId ? { sourceId } : {}),
    ...(installationId ? { installationId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(search ? { search } : {}),
    ...(before ? { before } : {}),
    limit,
  })
  const items = page.items
    .filter(item => policy.isSourceEnabled(item.sourceId))
    .map(item => ({
      id: nativeReviewSessionId(item.sourceId, item.installationId, item.nativeSessionId),
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
