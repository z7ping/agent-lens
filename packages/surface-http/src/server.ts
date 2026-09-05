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
  type CapturePolicyResponseDto,
  type CapturePolicySourceUpdateRequestDto,
  type DataRuntimeHealthDto,
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
  type SourceRecordResponseDto,
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

function dataRuntimeHealth(value: unknown): DataRuntimeHealthDto | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const runtime = value as Partial<DataRuntimeHealthDto>
  if (typeof runtime.ok !== 'boolean' || typeof runtime.recovering !== 'boolean') return undefined
  if (!runtime.writer || !runtime.reader) return undefined
  return value as DataRuntimeHealthDto
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
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw badRequest('Usage from must be earlier than or equal to to')
  }
  return {
    ...(params.get('installationId') ? { installationId: params.get('installationId')! } : {}),
    ...(params.get('logicalSessionId') ? { logicalSessionId: params.get('logicalSessionId')! } : {}),
    ...(params.get('projectId') ? { projectId: params.get('projectId')! } : {}),
    ...(params.get('sourceId') ? { sourceId: params.get('sourceId')! } : {}),
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
    ...(params.get('installationId') ? { installationId: params.get('installationId')! } : {}),
    ...(params.get('logicalSessionId') ? { logicalSessionId: params.get('logicalSessionId')! } : {}),
    ...(params.get('projectId') ? { projectId: params.get('projectId')! } : {}),
    ...(params.get('sourceId') ? { sourceId: params.get('sourceId')! } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }
}

function parseReviewStatus(value: string | null): ReviewStatusFilter | undefined {
  if (!value) return undefined
  if (value === 'all' || value === 'running' || value === 'error') return value
  throw badRequest(`Unknown review status: ${value}`)
}

function parseReviewDetailDirection(value: string | null): ReviewDetailDirection | undefined {
  if (!value) return undefined
  if (value === 'forward' || value === 'backward') return value
  throw badRequest(`Unknown review detail direction: ${value}`)
}

function parseReviewDetailFilter(value: string | null): ReviewDetailFilter | undefined {
  if (!value) return undefined
  if (value === 'all' || value === 'messages' || value === 'tools' || value === 'system') return value
  throw badRequest(`Unknown review detail filter: ${value}`)
}

function parseReviewQuery(params: URLSearchParams): ReviewQueryDto {
  const limit = parseLimit(params, 500)
  return {
    ...(params.get('installationId') ? { installationId: params.get('installationId')! } : {}),
    ...(params.get('logicalSessionId') ? { logicalSessionId: params.get('logicalSessionId')! } : {}),
    ...(params.get('projectId') ? { projectId: params.get('projectId')! } : {}),
    ...(params.get('sourceId') ? { sourceId: params.get('sourceId')! } : {}),
    ...(params.get('q') ? { q: params.get('q')! } : {}),
    ...(parseReviewStatus(params.get('status')) ? { status: parseReviewStatus(params.get('status'))! } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

function parseReviewDetailQuery(params: URLSearchParams): ReviewDetailQueryDto {
  const limit = parseLimit(params, 1000)
  const direction = parseReviewDetailDirection(params.get('direction'))
  const filter = parseReviewDetailFilter(params.get('filter'))
  return {
    ...(params.get('cursor') ? { cursor: params.get('cursor')! } : {}),
    ...(direction ? { direction } : {}),
    ...(filter ? { filter } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw httpError(415, 'Content-Type must be application/json')

  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > maxBytes) throw httpError(413, 'Request body is too large')
    chunks.push(bytes)
  }
  if (!chunks.length) throw badRequest('JSON body is required')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw badRequest('Request body must be valid JSON')
  }
}

function safeFilePath(root: string, pathname: string): string | null {
  const relative = pathname.replace(/^\/+/, '')
  const fullPath = resolve(root, relative)
  if (fullPath === root || fullPath.startsWith(`${root}${sep}`)) return fullPath
  return null
}

async function tryServeFile(response: ServerResponse, filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return false
    const content = await readFile(filePath)
    const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    response.statusCode = 200
    response.setHeader('content-type', contentType)
    response.setHeader('cache-control', 'no-cache')
    response.setHeader('content-length', content.byteLength)
    response.end(content)
    return true
  } catch {
    return false
  }
}

async function handleStatic(
  response: ServerResponse,
  pathname: string,
  mounts: Iterable<HttpStaticMount>,
): Promise<boolean> {
  for (const mount of mounts) {
    const root = resolve(mount.directory)
    const requestedPath = pathname === '/' ? 'index.html' : pathname
    const candidate = safeFilePath(root, requestedPath)
    if (candidate && await tryServeFile(response, candidate)) return true

    if (mount.spaFallback && !extname(pathname)) {
      const indexPath = safeFilePath(root, 'index.html')
      if (indexPath && await tryServeFile(response, indexPath)) return true
    }
  }
  return false
}

function backupMeta(): { protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION } {
  return { protocolVersion: AGENT_LENS_PROTOCOL_VERSION }
}

async function handleCapturePolicyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  capturePolicy?: CapturePolicyService,
): Promise<boolean> {
  if (url.pathname !== '/api/v1/capture-policy/sources') return false
  if (!capturePolicy) {
    writeJson(response, 503, { error: 'capture_policy_unavailable' })
    return true
  }

  if (request.method === 'GET') {
    const body: CapturePolicyResponseDto = {
      settings: {
        prompt: capturePolicy.settings.prompt,
        tool: capturePolicy.settings.tool,
        config: capturePolicy.settings.config,
        environment: capturePolicy.settings.environment,
        enabledSources: capturePolicy.settings.enabledSources,
        ...capturePolicy.getSourceConfiguration(),
      },
      meta: backupMeta(),
    }
    writeJson(response, 200, body)
    return true
  }

  if (request.method !== 'PUT') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }

  const payload = await readJsonBody(request) as CapturePolicySourceUpdateRequestDto
  if (!payload || !Array.isArray(payload.enabledSources)) {
    throw badRequest('enabledSources must be an array')
  }
  const enabledSources = payload.enabledSources.map(value => String(value).trim()).filter(Boolean)
  if (!enabledSources.length) throw badRequest('enabledSources must contain at least one source')
  await capturePolicy.setEnabledSources(enabledSources)
  const body: CapturePolicyResponseDto = {
    settings: {
      prompt: capturePolicy.settings.prompt,
      tool: capturePolicy.settings.tool,
      config: capturePolicy.settings.config,
      environment: capturePolicy.settings.environment,
      enabledSources: capturePolicy.settings.enabledSources,
      ...capturePolicy.getSourceConfiguration(),
    },
    meta: backupMeta(),
  }
  writeJson(response, 200, body)
  return true
}

async function handleBackupRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  backup?: BackupService,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/v1/backups')) return false
  if (!backup) {
    writeJson(response, 503, { error: 'backup_unavailable' })
    return true
  }

  if (url.pathname === '/api/v1/backups' && request.method === 'GET') {
    const query = {
      ...(url.searchParams.get('kind') ? { kind: url.searchParams.get('kind') as BackupAssetKind } : {}),
      ...(url.searchParams.get('q') ? { q: url.searchParams.get('q')! } : {}),
      ...(url.searchParams.get('sourceId') ? { sourceId: url.searchParams.get('sourceId')! } : {}),
      ...(url.searchParams.get('installationId') ? { installationId: url.searchParams.get('installationId')! } : {}),
      ...(url.searchParams.get('state') ? { state: url.searchParams.get('state')! } : {}),
    }
    if (query.kind && !BACKUP_KINDS.has(query.kind)) throw badRequest(`Unknown backup kind: ${query.kind}`)
    const body: BackupOverviewResponseDto = {
      ...await backup.overview(query),
      meta: backupMeta(),
    }
    writeJson(response, 200, body)
    return true
  }

  if (url.pathname === '/api/v1/backups' && request.method === 'POST') {
    const payload = await readJsonBody(request, MAX_BACKUP_BODY_BYTES) as BackupCreateRequestDto
    if (!payload || !Array.isArray(payload.assetBindingIds) || !payload.assetBindingIds.length) {
      throw badRequest('assetBindingIds must contain at least one asset')
    }
    const input: BackupCreateInput = {
      assetBindingIds: payload.assetBindingIds,
      ...(typeof payload.label === 'string' && payload.label.trim() ? { label: payload.label.trim() } : {}),
    }
    const snapshot = await backup.createSnapshot(input)
    const body: BackupSnapshotResponseDto = { snapshot, meta: backupMeta() }
    writeJson(response, 201, body)
    return true
  }

  if (url.pathname === '/api/v1/backups/import' && request.method === 'POST') {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += bytes.byteLength
      if (total > MAX_BACKUP_BODY_BYTES) throw httpError(413, 'Backup file is too large')
      chunks.push(bytes)
    }
    if (!chunks.length) throw badRequest('Backup payload is required')
    const snapshot = await backup.importSnapshot(Buffer.concat(chunks))
    const body: BackupSnapshotResponseDto = { snapshot, meta: backupMeta() }
    writeJson(response, 201, body)
    return true
  }

  const match = url.pathname.match(/^\/api\/v1\/backups\/([^/]+)(?:\/(verify|restore-preview|export))?$/)
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
      const deferRefresh = cachedStorageHealth
        ? new Promise<void>(resolve => setImmediate(resolve))
        : Promise.resolve()
      storageHealthProbe = deferRefresh
        .then(() => storage.health())
        .then(health => {
          cachedStorageHealth = health
          cachedStorageHealthAt = Date.now()
          return health
        })
        .catch(error => {
          if (cachedStorageHealth) return cachedStorageHealth
          throw error
        })
        .finally(() => {
          storageHealthProbe = null
        })
    }
    if (cachedStorageHealth) return cachedStorageHealth
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
      if (await handlePiLiveRequest(request, response, url, options.piLive, storage)) return
      if (await handleBackupRequest(request, response, url, options.backup)) return
      if (await handleCapturePolicyRequest(request, response, url, options.capturePolicy)) return

      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' })
        return
      }
      if (url.pathname === '/api/v1/ready') {
        writeJson(response, 200, {
          status: 'ok',
          protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
          runtime: {
            owner: currentRuntimeOwner(),
            mode: currentRuntimeMode(),
            pid: process.pid,
            startedAt: RUNTIME_STARTED_AT,
          },
        })
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
        const runtimeHealth = dataRuntimeHealth(health.details?.dataRuntime)
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
          ...(runtimeHealth ? { dataRuntime: runtimeHealth } : {}),
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
      if (url.pathname.startsWith('/api/v1/source-records/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/v1/source-records/'.length))
        if (!id) throw badRequest('sourceRecordId is required')
        const record = await storage.repositories.sourceRecords.get(id)
        if (!record) {
          writeJson(response, 404, { error: 'not_found' })
          return
        }
        const body: SourceRecordResponseDto = {
          id: record.id,
          sourceId: record.sourceId,
          installationId: record.installationId,
          ...(record.sourceSessionNativeId ? { sourceSessionNativeId: record.sourceSessionNativeId } : {}),
          nativeType: record.nativeType,
          ...(record.nativeId ? { nativeId: record.nativeId } : {}),
          ...(record.sourceSequence === undefined ? {} : { sourceSequence: record.sourceSequence }),
          ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
          capturedAt: record.capturedAt,
          locator: record.locator,
          ...(record.fingerprint ? { fingerprint: record.fingerprint } : {}),
          payload: jsonValue(record.payload),
          parserVersion: record.parserVersion,
        }
        writeJson(response, 200, body)
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
      if (url.pathname === '/api/v1/review') {
        writeJson(response, 200, await review.query(parseReviewQuery(url.searchParams)))
        return
      }
      if (url.pathname.startsWith('/api/v1/review/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/v1/review/'.length))
        if (!id) throw badRequest('logicalSessionId is required')
        const detail = await review.get(id, parseReviewDetailQuery(url.searchParams))
        writeJson(response, detail ? 200 : 404, detail ?? { error: 'not_found' })
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
      if (url.pathname === '/api/v1/relationships') {
        const limit = parseLimit(url.searchParams, 1000) ?? 500
        writeJson(response, 200, await relationships.query({ limit }))
        return
      }

      if (options.eventHub && url.pathname === '/api/v1/events/snapshot') {
        writeJson(response, 200, options.eventHub.snapshot())
        return
      }

      if (await handleStatic(response, url.pathname, staticMounts.values())) return
      writeJson(response, 404, { error: 'not_found' })
    } catch (error) {
      const statusCode = error && typeof error === 'object' && 'statusCode' in error
        ? Number((error as { statusCode?: unknown }).statusCode) || 500
        : 500
      writeJson(response, statusCode, {
        error: statusCode >= 500 ? 'internal_error' : 'bad_request',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, AGENT_LENS_HTTP_HOST, () => resolvePromise())
  })

  const address = server.address()
  const actualPort = address && typeof address !== 'string' ? address.port : requestedPort

  return {
    host: AGENT_LENS_HTTP_HOST,
    port: actualPort,
    server,
    mountStatic(mount) {
      staticMounts.set(mount.id, mount)
      return { dispose: () => { staticMounts.delete(mount.id) } }
    },
    async dispose() {
      for (const response of options.eventHub?.connections() ?? []) response.end()
      await new Promise<void>((resolvePromise, reject) => {
        server.close(error => error ? reject(error) : resolvePromise())
      })
    },
  }
}
