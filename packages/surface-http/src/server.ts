import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type {
  BackupAssetKind,
  BackupCreateInput,
  BackupService,
  CapabilityService,
  CapturePolicyService,
  Disposable,
  SourceService,
  StorageService,
} from '@agent-lens/core'
import { UsageInsightsProjection } from '@agent-lens/projection-insights'
import { AgentOverviewProjection, FacetProjection, SessionRelationshipProjection } from '@agent-lens/projection-overview'
import { ReviewProjection, type HubReviewProjection } from '@agent-lens/projection-review'
import { SessionProjection } from '@agent-lens/projection-session'
import { TimelineProjection } from '@agent-lens/projection-timeline'
import { ToolAssetUsageProjection } from '@agent-lens/projection-usage'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  TIMELINE_OBSERVATION_KINDS,
  type BackupCreateRequestDto,
  type BackupOverviewResponseDto,
  type BackupRestorePreviewResponseDto,
  type BackupSnapshotResponseDto,
  type BackupVerifyResponseDto,
  type HealthResponseDto,
  type InsightsQueryDto,
  type JsonValue,
  type ReviewDetailDirection,
  type ReviewDetailFilter,
  type ReviewDetailQueryDto,
  type ReviewQueryDto,
  type ReviewStatusFilter,
  type RuntimeModeDto,
  type RuntimeOwnerDto,
  type SessionQueryDto,
  type TimelineDirection,
  type TimelineObservationKind,
  type TimelineQueryDto,
  type ToolAssetUsageQueryDto,
} from '@agent-lens/protocol'
import type { PiLiveService } from '@agent-lens/runtime-cordis'
import type { HttpEventHub } from './events'
import { handlePiLiveRequest } from './pi-live'

export const AGENT_LENS_HTTP_HOST = '127.0.0.1' as const
export const DEFAULT_AGENT_LENS_HTTP_PORT = 56789
const MAX_JSON_BODY_BYTES = 1024 * 1024
const MAX_BACKUP_BODY_BYTES = 256 * 1024 * 1024
const HEALTH_CACHE_TTL_MS = 1_000
const RUNTIME_STARTED_AT = new Date().toISOString()
const BACKUP_KINDS = new Set<BackupAssetKind>([
  'skill', 'mcp', 'plugin', 'extension', 'hook', 'memory', 'rule', 'session', 'config', 'other',
])

export interface HttpStaticMount {
  id: string
  directory: string
  spaFallback?: boolean
}

export interface HttpSurfaceOptions {
  port?: number
  staticDir?: string
  eventHub?: HttpEventHub
  sources?: SourceService
  capabilities?: CapabilityService
  capturePolicy?: CapturePolicyService
  backup?: BackupService
  piLive?: PiLiveService
  hubReview?: Pick<HubReviewProjection, 'get' | 'query'>
}

export interface RunningHttpSurface {
  readonly host: typeof AGENT_LENS_HTTP_HOST
  readonly port: number
  readonly server: Server
  mountStatic(mount: HttpStaticMount): Disposable
  dispose(): Promise<void>
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
}

function currentRuntimeOwner(): RuntimeOwnerDto {
  const value = process.env.AGENT_LENS_RUNTIME_OWNER
  return value === 'cli' || value === 'service' || value === 'desktop' ? value : 'unknown'
}

function currentRuntimeMode(): RuntimeModeDto {
  return process.env.AGENT_LENS_DAEMON_MODE === 'managed' ? 'managed' : 'foreground'
}

function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 16) return '[max-depth]'
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1))
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
      result[key] = jsonValue(item, depth + 1)
    }
    return result
  }
  return null
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const content = JSON.stringify(body)
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-length', Buffer.byteLength(content))
  response.end(content)
}

function writeBytes(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  content: Buffer,
  headers: Record<string, string> = {},
): void {
  response.statusCode = statusCode
  response.setHeader('content-type', contentType)
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-length', content.byteLength)
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value)
  response.end(content)
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number }
  error.statusCode = statusCode
  return error
}

function badRequest(message: string): Error & { statusCode: number } {
  return httpError(400, message)
}

function parseLimit(params: URLSearchParams, max: number): number | undefined {
  const raw = params.get('limit')
  if (!raw) return undefined
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw badRequest(`Limit must be an integer between 1 and ${max}`)
  }
  return limit
}

function optionalTimestamp(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)
  if (!value) return undefined
  if (!Number.isFinite(Date.parse(value))) throw badRequest(`Invalid ${key} timestamp`)
  return value
}

function parseTimelineQuery(params: URLSearchParams): TimelineQueryDto {
  const kindValue = params.get('kind')
  let kind: TimelineObservationKind | undefined
  if (kindValue) {
    if (!(TIMELINE_OBSERVATION_KINDS as readonly string[]).includes(kindValue)) {
      throw badRequest(`Unknown timeline kind: ${kindValue}`)
    }
    kind = kindValue as TimelineObservationKind
  }
  const directionValue = params.get('direction')
  if (directionValue && !['forward', 'backward'].includes(directionValue)) {
    throw badRequest(`Unknown timeline direction: ${directionValue}`)
  }
  const from = optionalTimestamp(params, 'from')
  const to = optionalTimestamp(params, 'to')
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw badRequest('Timeline from must be earlier than or equal to to')
  }
  const limit = parseLimit(params, 1000)
  return {
    ...(params.get('installationId') ? { installationId: params.get('installationId')! } : {}),
    ...(params.get('logicalSessionId') ? { logicalSessionId: params.get('logicalSessionId')! } : {}),
    ...(kind ? { kind } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(params.get('cursor') ? { cursor: params.get('cursor')! } : {}),
    ...(directionValue ? { direction: directionValue as TimelineDirection } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

function parseSessionQuery(params: URLSearchParams): SessionQueryDto {
  const limit = parseLimit(params, 500)
  return {
    ...(params.get('installationId') ? { installationId: params.get('installationId')! } : {}),
    ...(params.get('logicalSessionId') ? { logicalSessionId: params.get('logicalSessionId')! } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

function parseUsageQuery(params: URLSearchParams): ToolAssetUsageQueryDto {
  const limit = parseLimit(params, 500)
  const from = optionalTimestamp(params, 'from')
  const to = optionalTimestamp(params, 'to')
  return {
    ...(params.get('installationId') ? { installationId: params.get('installationId')! } : {}),
    ...(params.get('logicalSessionId') ? { logicalSessionId: params.get('logicalSessionId')! } : {}),
    ...(params.get('sourceId') ? { sourceId: params.get('sourceId')! } : {}),
    ...(params.get('projectId') ? { projectId: params.get('projectId')! } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

function parseInsightsQuery(params: URLSearchParams): InsightsQueryDto {
  const from = optionalTimestamp(params, 'from')
  const to = optionalTimestamp(params, 'to')
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw badRequest('Insights from must be earlier than or equal to to')
  }
  return {
    ...(params.get('sourceId') ? { sourceId: params.get('sourceId')! } : {}),
    ...(params.get('projectId') ? { projectId: params.get('projectId')! } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }
}

function parseReviewQuery(params: URLSearchParams): ReviewQueryDto {
  const limit = parseLimit(params, 500)
  const from = optionalTimestamp(params, 'from')
  const to = optionalTimestamp(params, 'to')
  const statusValue = params.get('status')
  if (statusValue && !['all', 'with-errors', 'clean'].includes(statusValue)) {
    throw badRequest(`Unknown review status: ${statusValue}`)
  }
  return {
    ...(params.get('sourceId') ? { sourceId: params.get('sourceId')! } : {}),
    ...(params.get('projectId') ? { projectId: params.get('projectId')! } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(statusValue ? { status: statusValue as ReviewStatusFilter } : {}),
    ...(params.get('search') ? { search: params.get('search')! } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

function parseReviewDetailQuery(params: URLSearchParams): ReviewDetailQueryDto {
  const limit = parseLimit(params, 100)
  const directionValue = params.get('direction')
  if (directionValue && !['forward', 'backward'].includes(directionValue)) {
    throw badRequest(`Unknown review direction: ${directionValue}`)
  }
  const filterValue = params.get('filter')
  if (filterValue && !['all', 'errors', 'latency', 'latest'].includes(filterValue)) {
    throw badRequest(`Unknown review filter: ${filterValue}`)
  }
  return {
    ...(params.get('cursor') ? { cursor: params.get('cursor')! } : {}),
    ...(directionValue ? { direction: directionValue as ReviewDetailDirection } : {}),
    ...(filterValue ? { filter: filterValue as ReviewDetailFilter } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.byteLength
    if (size > maxBytes) throw httpError(413, 'Request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const bytes = await readBody(request, MAX_JSON_BODY_BYTES)
  if (!bytes.byteLength) return {} as T
  try {
    return JSON.parse(bytes.toString('utf8')) as T
  } catch {
    throw badRequest('Request body must be valid JSON')
  }
}

function parseBackupCreate(value: BackupCreateRequestDto): BackupCreateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Backup request must be an object')
  if (value.sourceIds !== undefined
    && (!Array.isArray(value.sourceIds) || value.sourceIds.some(item => typeof item !== 'string' || !item))) {
    throw badRequest('sourceIds must be an array of non-empty strings')
  }
  if (value.kinds !== undefined
    && (!Array.isArray(value.kinds) || value.kinds.some(item => !BACKUP_KINDS.has(item)))) {
    throw badRequest('kinds contains an unknown backup asset kind')
  }
  return {
    ...(value.sourceIds?.length ? { sourceIds: [...new Set(value.sourceIds)] } : {}),
    ...(value.kinds?.length ? { kinds: [...new Set(value.kinds)] } : {}),
  }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function safeStaticPath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const candidate = resolve(root, decoded.replace(/^\/+/, ''))
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null
}

async function serveStatic(
  response: ServerResponse,
  pathname: string,
  staticDir: string,
  spaFallback = true,
): Promise<boolean> {
  const root = resolve(staticDir)
  const requested = pathname === '/' ? '/index.html' : pathname
  const candidate = safeStaticPath(root, requested)
  if (!candidate) return false
  let target = candidate
  if (!await regularFile(target)) {
    if (!spaFallback || extname(requested)) return false
    target = resolve(root, 'index.html')
    if (!await regularFile(target)) return false
  }
  writeBytes(
    response,
    200,
    MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    await readFile(target),
  )
  return true
}

function backupMeta() {
  return { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: new Date().toISOString() }
}

async function handleBackupRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  backup: BackupService | undefined,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/v1/backups')) return false
  if (!backup) {
    writeJson(response, 503, { error: 'backup_unavailable' })
    return true
  }

  if (url.pathname === '/api/v1/backups') {
    if (request.method === 'GET') {
      const overview = await backup.overview()
      const body: BackupOverviewResponseDto = { ...overview, meta: backupMeta() }
      writeJson(response, 200, body)
      return true
    }
    if (request.method === 'POST') {
      const input = parseBackupCreate(await readJsonBody<BackupCreateRequestDto>(request))
      const snapshot = await backup.createSnapshot(input)
      const body: BackupSnapshotResponseDto = { snapshot, meta: backupMeta() }
      writeJson(response, 201, body)
      return true
    }
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }

  if (url.pathname === '/api/v1/backups/refresh') {
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }
    if (!backup.refreshIndex) {
      writeJson(response, 501, { error: 'backup_refresh_unavailable' })
      return true
    }
    const overview = await backup.refreshIndex()
    const body: BackupOverviewResponseDto = { ...overview, meta: backupMeta() }
    writeJson(response, 200, body)
    return true
  }

  if (url.pathname === '/api/v1/backups/import') {
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }
    const snapshot = await backup.importSnapshot(await readBody(request, MAX_BACKUP_BODY_BYTES))
    const body: BackupSnapshotResponseDto = { snapshot, meta: backupMeta() }
    writeJson(response, 201, body)
    return true
  }

  const match = url.pathname.match(/^\/api\/v1\/backups\/([^/]+)(?:\/(verify|export|restore-preview|restore))?$/)
  if (!match) {
    writeJson(response, 404, { error: 'not_found' })
    return true
  }
  const id = decodeURIComponent(match[1]!)
  const action = match[2]

  if (!action && request.method === 'GET') {
    const snapshot = await backup.getSnapshot(id)
    if (!snapshot) {
      writeJson(response, 404, { error: 'not_found' })
      return true
    }
    const body: BackupSnapshotResponseDto = { snapshot, meta: backupMeta() }
    writeJson(response, 200, body)
    return true
  }
  if (action === 'verify' && request.method === 'POST') {
    const verified = await backup.verifySnapshot(id)
    const body: BackupVerifyResponseDto = { ...verified, meta: backupMeta() }
    writeJson(response, 200, body)
    return true
  }
  if (action === 'restore-preview' && request.method === 'GET') {
    const preview = await backup.previewRestore(id)
    const body: BackupRestorePreviewResponseDto = {
      ...preview,
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
    }
    writeJson(response, 200, body)
    return true
  }
  if (action === 'export' && request.method === 'GET') {
    const bytes = Buffer.from(await backup.exportSnapshot(id))
    writeBytes(response, 200, 'application/vnd.agentlens.backup', bytes, {
      'content-disposition': `attachment; filename="${id}.agentlens-backup"`,
    })
    return true
  }

  writeJson(response, 405, { error: 'method_not_allowed' })
  return true
}

export async function startHttpSurface(
  storage: StorageService,
  options: HttpSurfaceOptions = {},
): Promise<RunningHttpSurface> {
  const timeline = new TimelineProjection(storage)
  const sessions = new SessionProjection(storage)
  const usage = new ToolAssetUsageProjection(storage)
  const insights = new UsageInsightsProjection(storage)
  const review = new ReviewProjection(storage)
  const facets = new FacetProjection(storage, options.sources, options.capturePolicy)
  const agents = new AgentOverviewProjection(storage, options.sources, options.capabilities, options.capturePolicy)
  const relationships = new SessionRelationshipProjection(storage)
  const staticMounts = new Map<string, HttpStaticMount>()
  type StorageHealth = Awaited<ReturnType<StorageService['health']>>
  let cachedStorageHealth: StorageHealth | null = null
  let cachedStorageHealthAt = 0
  let storageHealthProbe: Promise<StorageHealth> | null = null

  const readStorageHealth = async (): Promise<StorageHealth> => {
    if (cachedStorageHealth && Date.now() - cachedStorageHealthAt < HEALTH_CACHE_TTL_MS) {
      return cachedStorageHealth
    }
    if (!storageHealthProbe) {
      storageHealthProbe = storage.health()
        .then(health => {
          cachedStorageHealth = health
          cachedStorageHealthAt = Date.now()
          return health
        })
        .finally(() => {
          storageHealthProbe = null
        })
    }
    return storageHealthProbe
  }

  if (options.staticDir) {
    staticMounts.set('legacy-static-dir', {
      id: 'legacy-static-dir',
      directory: options.staticDir,
      spaFallback: true,
    })
  }

  const requestedPort = options.port ?? DEFAULT_AGENT_LENS_HTTP_PORT
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`Invalid AgentLens HTTP port: ${requestedPort}`)
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${AGENT_LENS_HTTP_HOST}`)
      if (await handlePiLiveRequest(request, response, url, options.piLive)) return
      if (await handleBackupRequest(request, response, url, options.backup)) return

      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' })
        return
      }
      if (url.pathname === '/api/v1/events') {
        if (!options.eventHub) {
          writeJson(response, 503, { error: 'events_unavailable' })
          return
        }
        options.eventHub.connect(response)
        return
      }
      if (url.pathname === '/api/v1/health') {
        const health = await readStorageHealth()
        const details = health.details
          ? Object.fromEntries(Object.entries(health.details).map(([key, value]) => [key, jsonValue(value)]))
          : undefined
        const body: HealthResponseDto = {
          status: health.ok ? 'ok' : 'degraded',
          protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
          runtime: {
            owner: currentRuntimeOwner(),
            mode: currentRuntimeMode(),
            pid: process.pid,
            startedAt: RUNTIME_STARTED_AT,
          },
          storage: {
            ok: health.ok,
            ...(health.schemaVersion === undefined ? {} : { schemaVersion: health.schemaVersion }),
            ...(details ? { details } : {}),
          },
        }
        writeJson(response, health.ok ? 200 : 503, body)
        return
      }
      if (url.pathname === '/api/v1/facets') {
        writeJson(response, 200, await facets.query())
        return
      }
      if (url.pathname === '/api/v1/agents') {
        writeJson(response, 200, await agents.query())
        return
      }
      if (url.pathname === '/api/v1/hub/review') {
        if (!options.hubReview) {
          writeJson(response, 503, { error: 'hub_review_unavailable' })
          return
        }
        const limit = parseLimit(url.searchParams, 500) ?? 100
        writeJson(response, 200, await options.hubReview.query(limit))
        return
      }
      if (url.pathname.startsWith('/api/v1/hub/review/')) {
        if (!options.hubReview) {
          writeJson(response, 503, { error: 'hub_review_unavailable' })
          return
        }
        const id = decodeURIComponent(url.pathname.slice('/api/v1/hub/review/'.length))
        if (!id) {
          writeJson(response, 404, { error: 'not_found' })
          return
        }
        const limit = parseLimit(url.searchParams, 500) ?? 500
        const detail = await options.hubReview.get(id, limit)
        writeJson(response, detail ? 200 : 404, detail ?? { error: 'not_found' })
        return
      }
      if (url.pathname === '/api/v1/review') {
        writeJson(response, 200, await review.query(parseReviewQuery(url.searchParams)))
        return
      }
      if (url.pathname.startsWith('/api/v1/review/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/v1/review/'.length))
        const detail = await review.get(id, parseReviewDetailQuery(url.searchParams))
        writeJson(response, detail ? 200 : 404, detail ?? { error: 'not_found' })
        return
      }
      if (url.pathname === '/api/v1/relationships') {
        const id = url.searchParams.get('logicalSessionId')
        if (!id) throw badRequest('logicalSessionId is required')
        writeJson(response, 200, await relationships.query(id))
        return
      }
      if (url.pathname === '/api/v1/timeline') {
        writeJson(response, 200, await timeline.query(parseTimelineQuery(url.searchParams)))
        return
      }
      if (url.pathname === '/api/v1/sessions') {
        writeJson(response, 200, await sessions.query(parseSessionQuery(url.searchParams)))
        return
      }
      if (url.pathname === '/api/v1/usage') {
        writeJson(response, 200, await usage.query(parseUsageQuery(url.searchParams)))
        return
      }
      if (url.pathname === '/api/v1/insights') {
        writeJson(response, 200, await insights.query(parseInsightsQuery(url.searchParams)))
        return
      }
      if (url.pathname.startsWith('/api/')) {
        writeJson(response, 404, { error: 'not_found' })
        return
      }
      for (const mount of [...staticMounts.values()].reverse()) {
        if (await serveStatic(response, url.pathname, mount.directory, mount.spaFallback ?? true)) return
      }
      writeJson(response, 404, { error: 'not_found' })
    } catch (error) {
      const cursorError = error instanceof Error
        && (error.message === 'Invalid timeline cursor' || error.message === 'Invalid review cursor')
      const statusCode = cursorError
        ? 400
        : error && typeof error === 'object' && 'statusCode' in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : 500
      writeJson(response, statusCode, {
        error: statusCode === 400 ? 'bad_request' : statusCode === 413 ? 'payload_too_large' : 'internal_error',
        ...((statusCode === 400 || statusCode === 413) && error instanceof Error ? { message: error.message } : {}),
      })
    }
  })

  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolvePromise()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(requestedPort, AGENT_LENS_HTTP_HOST)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('AgentLens HTTP server did not expose a TCP address')
  }
  let disposed = false
  return {
    host: AGENT_LENS_HTTP_HOST,
    port: address.port,
    server,
    mountStatic(mount) {
      if (!mount.id || !mount.directory) throw new Error('Static mount requires id and directory')
      const registered = { ...mount }
      staticMounts.set(mount.id, registered)
      return {
        dispose() {
          if (staticMounts.get(mount.id) === registered) staticMounts.delete(mount.id)
        },
      }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      staticMounts.clear()
      options.eventHub?.close()
      await new Promise<void>((resolvePromise, reject) => {
        server.close(error => error ? reject(error) : resolvePromise())
      })
    },
  }
}

export const httpSurfaceInternals = {
  parseTimelineQuery,
  parseSessionQuery,
  parseUsageQuery,
  parseInsightsQuery,
  parseReviewQuery,
  parseReviewDetailQuery,
  parseBackupCreate,
  currentRuntimeOwner,
  currentRuntimeMode,
  jsonValue,
  safeStaticPath,
  serveStatic,
}
