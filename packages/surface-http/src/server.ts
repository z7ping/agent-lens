import { createServer, type Server } from 'node:http'
import {
  auditSourceRawRecoveryBatch,
  type AgentIntegrationRuntimeStatus,
  type BackupService,
  type CapabilityService,
  type CapturePolicyService,
  type Disposable,
  type LiveAttachmentService,
  type LiveService,
  type SourceService,
  type StorageService,
} from '@agent-lens/core'
import { UsageInsightsProjection } from '@agent-lens/projection-insights'
import { AgentOverviewProjection, FacetProjection, SessionRelationshipProjection } from '@agent-lens/projection-overview'
import { ReviewProjection, type HubReviewProjection } from '@agent-lens/projection-review'
import { SessionProjection } from '@agent-lens/projection-session'
import { TimelineProjection } from '@agent-lens/projection-timeline'
import { ToolAssetUsageProjection } from '@agent-lens/projection-usage'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  reviewMessageAttachmentsFromPayload,
  type AgentRescanResponseDto,
  type AgentRescanSummaryDto,
  type HealthResponseDto,
  type JsonValue,
  type PiEcosystemQueryService,
  type RuntimeModeDto,
  type RuntimeOwnerDto,
  type ReviewMessageAttachmentsResponseDto,
  type SourceRecordResponseDto,
  type SourceRecordsResponseDto,
  type StorageDiagnosticsResponseDto,
} from '@agent-lens/protocol'
import type { PiLiveService } from '@agent-lens/runtime-cordis'
import { handleAgentFilesRequest } from './agent-files-http'
import { readBackgroundActivity } from './background-activity'
import { handleBackupRequest } from './backup-http'
import { handleCapturePolicyRequest } from './capture-policy-http'
import {
  handleIntegrationAuthorizationRequest,
  type IntegrationAuthorizationController,
} from './integration-http'
import {
  handleIntegrationDiscoveryRequest,
  type IntegrationDiscoveryController,
} from './integration-discovery-http'
import {
  handleIntegrationManagementRequest,
  type IntegrationManagementController,
} from './integration-management-http'
import {
  handleIntegrationPackageRequest,
  type IntegrationPackageController,
} from './integration-packages-http'
import { parseDataRuntimeHealth } from './data-runtime-health'
import type { HttpEventHub } from './events'
import { badRequest, statusCodeForError, writeJson } from './http-utils'
import { handleLiveAttachmentRequest } from './live-attachments-http'
import { handleLiveRequest } from './live-http'
import { handleManagedAssetFilesRequest } from './managed-asset-files'
import { readLaunchableProjects } from './launchable-projects'
import { discoverLocalePacks } from './locale-packs'
import { handlePiEcosystemRequest } from './pi-ecosystem-http'
import { handlePiLiveRequest } from './pi-live'
import {
  parseInsightsQuery,
  parseLimit,
  parseReviewDetailQuery,
  parseReviewQuery,
  parseSessionQuery,
  parseTimelineQuery,
  parseUsageQuery,
} from './query-params'
import { handleStatic, type HttpStaticMount } from './static-files'

export type { HttpStaticMount } from './static-files'

export const AGENT_LENS_HTTP_HOST = '127.0.0.1' as const
export const DEFAULT_AGENT_LENS_HTTP_PORT = 56789
const HEALTH_CACHE_TTL_MS = 2_000
const USAGE_DETAIL_LIMIT = 5
const RUNTIME_STARTED_AT = new Date().toISOString()
const SLOW_HTTP_REQUEST_LOG_MS = 500

type ForegroundReadPriority = 'critical' | 'supporting' | 'opportunistic'
type PriorityAwareStorage = StorageService & {
  withReadPriority?<T>(priority: ForegroundReadPriority, operation: () => Promise<T>): Promise<T>
}

function withReadPriority<T>(
  storage: StorageService,
  priority: ForegroundReadPriority,
  operation: () => Promise<T>,
): Promise<T> {
  const scoped = (storage as PriorityAwareStorage).withReadPriority
  return scoped ? scoped.call(storage, priority, operation) : operation()
}

export interface HttpSurfaceOptions {
  port?: number
  staticDir?: string
  eventHub?: HttpEventHub
  sources?: SourceService
  capabilities?: CapabilityService
  capturePolicy?: CapturePolicyService
  backup?: BackupService
  lives?: LiveService
  liveAttachments?: LiveAttachmentService
  piLive?: PiLiveService
  piEcosystem?: PiEcosystemQueryService
  rescanAgents?: (sourceId?: string) => Promise<AgentRescanSummaryDto>
  sourceDetection?: (sourceId: string) => boolean | undefined
  integrationStatus?: (
    productId: string,
  ) => AgentIntegrationRuntimeStatus | null | Promise<AgentIntegrationRuntimeStatus | null>
  integrationAuthorization?: IntegrationAuthorizationController
  integrationDiscovery?: IntegrationDiscoveryController
  integrationManagement?: IntegrationManagementController
  integrationPackages?: IntegrationPackageController
  localePackDirectory?: string
  selectProjectDirectory?: () => Promise<string | undefined>
  openHostPath?: (path: string) => Promise<'opened' | 'revealed'>
  reviewQueryObserved?: (visibleCount: number) => void
  hubReview?: Pick<HubReviewProjection, 'get' | 'query'>
}

export interface RunningHttpSurface {
  readonly host: typeof AGENT_LENS_HTTP_HOST
  readonly port: number
  readonly server: Server
  mountStatic(mount: HttpStaticMount): Disposable
  dispose(): Promise<void>
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

function httpRouteLabel(pathname: string): string {
  if (/^\/api\/v1\/(?:review|source-records)\//.test(pathname)) {
    return pathname.replace(/^(\/api\/v1\/(?:review|source-records))\/.+$/, '$1/:id')
  }
  return pathname
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
  const facets = new FacetProjection(storage, options.sources, options.capturePolicy, options.sourceDetection)
  const agents = new AgentOverviewProjection(
    storage,
    options.sources,
    options.capabilities,
    options.capturePolicy,
    options.sourceDetection,
    options.integrationStatus,
  )
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
    const startedAt = performance.now()
    let route = '<invalid-url>'
    let finished = false
    response.once('finish', () => {
      finished = true
      const durationMs = performance.now() - startedAt
      if (!route.startsWith('/api/') || (durationMs < SLOW_HTTP_REQUEST_LOG_MS && response.statusCode < 500)) return
      const contentLength = response.getHeader('content-length')
      console.warn('[AgentLens] HTTP request observed', {
        method: request.method ?? 'UNKNOWN',
        route,
        statusCode: response.statusCode,
        durationMs: Math.round(durationMs),
        ...(typeof contentLength === 'number'
          ? { responseBytes: contentLength }
          : typeof contentLength === 'string' && /^\d+$/.test(contentLength)
            ? { responseBytes: Number(contentLength) }
            : {}),
      })
    })
    response.once('close', () => {
      if (finished || !route.startsWith('/api/')) return
      console.warn('[AgentLens] HTTP request aborted', {
        method: request.method ?? 'UNKNOWN',
        route,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
    })
    try {
      const url = new URL(request.url ?? '/', `http://${AGENT_LENS_HTTP_HOST}`)
      route = httpRouteLabel(url.pathname)
      if (await handleLiveAttachmentRequest(request, response, url, options.liveAttachments)) return
      if (await handleLiveRequest(request, response, url, options.lives)) return
      if (await handlePiLiveRequest(request, response, url, options.piLive, storage, options.lives, options.selectProjectDirectory)) return
      const backgroundBackupRead = request.method === 'GET'
        && url.pathname === '/api/v1/backups'
        && url.searchParams.get('background') === '1'
      const backupHandled = backgroundBackupRead
        ? await withReadPriority(storage, 'supporting', () => handleBackupRequest(request, response, url, options.backup))
        : await handleBackupRequest(request, response, url, options.backup)
      if (backupHandled) return
      if (await handleCapturePolicyRequest(request, response, url, options.capturePolicy)) return
      if (await handleAgentFilesRequest(request, response, url, storage, options.sources)) return
      if (await handleIntegrationAuthorizationRequest(
        request,
        response,
        url,
        options.integrationAuthorization,
      )) return
      if (await handleIntegrationDiscoveryRequest(
        request,
        response,
        url,
        options.integrationDiscovery,
      )) return
      if (await handleIntegrationManagementRequest(
        request,
        response,
        url,
        options.integrationManagement,
      )) return
      if (await handleIntegrationPackageRequest(
        request,
        response,
        url,
        options.integrationPackages,
      )) return
      if (await handlePiEcosystemRequest(
        request,
        response,
        url,
        options.piEcosystem,
      )) return
      if (await handleManagedAssetFilesRequest(
        request,
        response,
        url,
        storage,
        options.integrationStatus,
      )) return

      if (url.pathname === '/api/v1/host/open-path' || url.pathname === '/api/v1/host/open-directory') {
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'method_not_allowed' })
          return
        }
        const generic = url.pathname === '/api/v1/host/open-path'
        const rawResult = request.headers[
          generic ? 'x-agentlens-host-open-path-result' : 'x-agentlens-host-open-directory-result'
        ]
        const result = Array.isArray(rawResult) ? rawResult[0] : rawResult
        if (result === 'opened' || result === 'revealed') {
          writeJson(response, 200, {
            opened: true,
            action: result === 'revealed' ? 'revealed' : 'opened',
          })
          return
        }
        if (!result && options.openHostPath) {
          const rawPath = request.headers[
            generic ? 'x-agentlens-host-open-path-path' : 'x-agentlens-host-open-directory-path'
          ]
          if (Array.isArray(rawPath)) {
            writeJson(response, 400, {
              error: generic ? 'open_path_failed' : 'open_directory_failed',
              message: '目标路径请求头无效。',
            })
            return
          }
          let path = ''
          try {
            path = rawPath ? decodeURIComponent(rawPath).trim() : ''
          } catch {
            path = ''
          }
          if (!path) {
            writeJson(response, 400, {
              error: generic ? 'open_path_failed' : 'open_directory_failed',
              message: '目标路径无效。',
            })
            return
          }
          try {
            const action = await options.openHostPath(path)
            writeJson(response, 200, { opened: true, action })
          } catch (error) {
            writeJson(response, 400, {
              error: generic ? 'open_path_failed' : 'open_directory_failed',
              message: error instanceof Error ? error.message : String(error),
            })
          }
          return
        }
        if (!result) {
          writeJson(response, 501, {
            error: 'desktop_host_required',
            message: '当前运行环境不支持直接定位本地路径。',
          })
          return
        }
        const message = result.startsWith('open-error:')
          ? decodeURIComponent(result.slice('open-error:'.length))
          : result === 'missing'
            ? '目标路径不存在或无法访问。'
            : result === 'unsupported-path'
              ? '当前路径类型不支持在文件管理器中打开。'
              : result === 'not-directory'
                ? '目标路径不是目录。'
                : '目标路径无效。'
        writeJson(response, 400, {
          error: generic ? 'open_path_failed' : 'open_directory_failed',
          message,
        })
        return
      }

      if (url.pathname === '/api/v1/agents/rescan') {
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'method_not_allowed' })
          return
        }
        if (!options.rescanAgents) {
          writeJson(response, 503, { error: 'agents_rescan_unavailable' })
          return
        }
        const sourceId = url.searchParams.get('sourceId')?.trim() || undefined
        const summary = await options.rescanAgents(sourceId)
        agents.invalidate()
        facets.invalidate()
        const [freshAgents, freshFacets] = await Promise.all([
          agents.query(),
          facets.query(),
        ])
        const body: AgentRescanResponseDto = {
          ...summary,
          agents: freshAgents,
          facets: freshFacets,
        }
        writeJson(response, 200, body)
        return
      }

      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' })
        return
      }
      if (url.pathname === '/api/v1/background-activity') {
        writeJson(response, 200, await withReadPriority(storage, 'opportunistic', () => readBackgroundActivity(storage)))
        return
      }
      if (url.pathname === '/api/v1/locales') {
        writeJson(response, 200, await discoverLocalePacks(options.localePackDirectory))
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
      if (url.pathname === '/api/v1/storage/source-raw-recovery-audit') {
        if (!options.sources || !storage.sourceRawAudit) {
          writeJson(response, 501, { error: 'source_raw_recovery_audit_unavailable' })
          return
        }
        const cursor = url.searchParams.get('cursor')?.trim() || url.searchParams.get('after')?.trim() || undefined
        const limit = parseLimit(url.searchParams, 500) ?? 100
        writeJson(response, 200, await auditSourceRawRecoveryBatch({
          sources: options.sources,
          storage,
          ...(cursor ? { cursor } : {}),
          limit,
        }))
        return
      }

      if (url.pathname === '/api/v1/storage/diagnostics') {
        if (!storage.diagnostics) {
          writeJson(response, 501, { error: 'storage_diagnostics_unavailable' })
          return
        }
        const diagnostics = await storage.diagnostics()
        const details = diagnostics.details
          ? Object.fromEntries(Object.entries(diagnostics.details).map(([key, value]) => [key, jsonValue(value)]))
          : undefined
        const body: StorageDiagnosticsResponseDto = {
          protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
          generatedAt: new Date().toISOString(),
          storage: {
            ok: diagnostics.ok,
            ...(diagnostics.schemaVersion === undefined ? {} : { schemaVersion: diagnostics.schemaVersion }),
            ...(details ? { details } : {}),
          },
        }
        writeJson(response, diagnostics.ok ? 200 : 503, body)
        return
      }
      if (url.pathname === '/api/v1/health') {
        const health = await readStorageHealth()
        const runtimeHealth = parseDataRuntimeHealth(health.details?.dataRuntime)
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
        writeJson(response, 200, await withReadPriority(storage, 'supporting', () => facets.query()))
        return
      }
      if (url.pathname === '/api/v1/projects/launchable') {
        writeJson(response, 200, await withReadPriority(storage, 'supporting', () => readLaunchableProjects(storage, url.searchParams)))
        return
      }
      if (url.pathname === '/api/v1/agents/summary') {
        writeJson(response, 200, await agents.querySummary())
        return
      }
      if (url.pathname === '/api/v1/agents/coverage') {
        writeJson(response, 200, await withReadPriority(storage, 'opportunistic', () => agents.queryCoverage()))
        return
      }
      const agentEnrichmentMatch = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)\/enrichment$/)
      if (agentEnrichmentMatch) {
        const sourceId = decodeURIComponent(agentEnrichmentMatch[1] ?? '')
        if (!sourceId) throw badRequest('sourceId is required')
        const enrichment = await withReadPriority(storage, 'supporting', () => agents.getEnrichment(sourceId))
        writeJson(response, enrichment ? 200 : 404, enrichment ?? { error: 'not_found' })
        return
      }
      if (url.pathname.startsWith('/api/v1/agents/')) {
        const sourceId = decodeURIComponent(url.pathname.slice('/api/v1/agents/'.length))
        if (!sourceId) throw badRequest('sourceId is required')
        const detail = await agents.get(sourceId)
        writeJson(response, detail ? 200 : 404, detail ?? { error: 'not_found' })
        return
      }
      if (url.pathname === '/api/v1/agents') {
        writeJson(response, 200, await withReadPriority(storage, 'opportunistic', () => agents.query()))
        return
      }
      if (url.pathname === '/api/v1/hub/review') {
        if (!options.hubReview) {
          writeJson(response, 503, { error: 'hub_review_unavailable' })
          return
        }
        const limit = parseLimit(url.searchParams, 500) ?? 100
        writeJson(response, 200, await withReadPriority(storage, 'supporting', () => options.hubReview!.query(limit)))
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
        const detail = await withReadPriority(storage, 'supporting', () => options.hubReview!.get(id, limit))
        writeJson(response, detail ? 200 : 404, detail ?? { error: 'not_found' })
        return
      }
      if (url.pathname === '/api/v1/source-records') {
        const ids = [...new Set(url.searchParams.getAll('id').map(id => id.trim()).filter(Boolean))].slice(0, 50)
        if (!ids.length) throw badRequest('at least one source record id is required')
        const records = await withReadPriority(storage, 'opportunistic', async () => {
          if (storage.repositories.sourceRecords.getMany) {
            return storage.repositories.sourceRecords.getMany(ids)
          }
          return (await Promise.all(ids.map(id => storage.repositories.sourceRecords.get(id))))
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
        })
        const byId = new Map(records.map(record => [record.id, record]))
        const items: SourceRecordResponseDto[] = ids.flatMap(id => {
          const record = byId.get(id)
          if (!record) return []
          return [{
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
          }]
        })
        const body: SourceRecordsResponseDto = { items }
        writeJson(response, 200, body)
        return
      }
      if (url.pathname.startsWith('/api/v1/source-records/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/v1/source-records/'.length))
        if (!id) throw badRequest('sourceRecordId is required')
        const record = await withReadPriority(storage, 'opportunistic', () => storage.repositories.sourceRecords.get(id))
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
        const result = await review.query(parseReviewQuery(url.searchParams))
        options.reviewQueryObserved?.(result.items.length)
        writeJson(response, 200, result)
        return
      }
      const reviewAttachmentMatch = url.pathname.match(/^\/api\/v1\/review\/observations\/([^/]+)\/attachments$/)
      if (reviewAttachmentMatch) {
        const observationId = decodeURIComponent(reviewAttachmentMatch[1] ?? '')
        if (!observationId) throw badRequest('observationId is required')
        const observation = await withReadPriority(
          storage,
          'opportunistic',
          () => storage.repositories.observations.get(observationId),
        )
        if (!observation) {
          writeJson(response, 404, { error: 'not_found' })
          return
        }
        const body: ReviewMessageAttachmentsResponseDto = {
          observationId,
          items: reviewMessageAttachmentsFromPayload(observation.payload),
        }
        writeJson(response, 200, body)
        return
      }

      const reviewSummaryMatch = url.pathname.match(/^\/api\/v1\/review\/([^/]+)\/summary$/)
      if (reviewSummaryMatch) {
        const id = decodeURIComponent(reviewSummaryMatch[1] ?? '')
        if (!id) throw badRequest('logicalSessionId is required')
        const summary = await review.getSummary(id)
        writeJson(response, summary ? 200 : 404, summary ?? { error: 'not_found' })
        return
      }
      if (url.pathname.startsWith('/api/v1/review/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/v1/review/'.length))
        if (!id) throw badRequest('logicalSessionId is required')
        const detail = await review.get(id, parseReviewDetailQuery(url.searchParams))
        writeJson(response, detail ? 200 : 404, detail ?? { error: 'not_found' })
        return
      }
      if (url.pathname === '/api/v1/usage/detail') {
        writeJson(response, 200, await usage.query(parseUsageQuery(url.searchParams), USAGE_DETAIL_LIMIT))
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
        const logicalSessionId = url.searchParams.get('logicalSessionId')
        if (!logicalSessionId) throw badRequest('logicalSessionId is required')
        writeJson(response, 200, await withReadPriority(storage, 'supporting', () => relationships.query(logicalSessionId)))
        return
      }

      if (url.pathname.startsWith('/api/v1/')) {
        writeJson(response, 404, { error: 'not_found' })
        return
      }

      if (await handleStatic(response, url.pathname, staticMounts.values())) return
      writeJson(response, 404, { error: 'not_found' })
    } catch (error) {
      const statusCode = statusCodeForError(error)
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
      options.eventHub?.close()
      await new Promise<void>((resolvePromise, reject) => {
        server.close(error => error ? reject(error) : resolvePromise())
      })
    },
  }
}
