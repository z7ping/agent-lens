import { createServer, type Server } from 'node:http'
import type {
  AgentIntegrationRuntimeStatus,
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
  type AgentRescanResponseDto,
  type AgentRescanSummaryDto,
  type HealthResponseDto,
  type JsonValue,
  type RuntimeModeDto,
  type RuntimeOwnerDto,
  type SourceRecordResponseDto,
} from '@agent-lens/protocol'
import type { PiLiveService } from '@agent-lens/runtime-cordis'
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
import { handleManagedAssetFilesRequest } from './managed-asset-files'
import { readLaunchableProjects } from './launchable-projects'
import { discoverLocalePacks } from './locale-packs'
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

export interface HttpSurfaceOptions {
  port?: number
  staticDir?: string
  eventHub?: HttpEventHub
  sources?: SourceService
  capabilities?: CapabilityService
  capturePolicy?: CapturePolicyService
  backup?: BackupService
  piLive?: PiLiveService
  rescanAgents?: () => Promise<AgentRescanSummaryDto>
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
      console.warn('[AgentLens] HTTP request observed', {
        method: request.method ?? 'UNKNOWN',
        route,
        statusCode: response.statusCode,
        durationMs: Math.round(durationMs),
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
      if (await handlePiLiveRequest(request, response, url, options.piLive, storage, options.selectProjectDirectory)) return
      if (await handleBackupRequest(request, response, url, options.backup)) return
      if (await handleCapturePolicyRequest(request, response, url, options.capturePolicy)) return
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
      if (await handleManagedAssetFilesRequest(
        request,
        response,
        url,
        storage,
        options.integrationStatus,
      )) return

      if (url.pathname === '/api/v1/agents/rescan') {
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'method_not_allowed' })
          return
        }
        if (!options.rescanAgents) {
          writeJson(response, 503, { error: 'agents_rescan_unavailable' })
          return
        }
        const summary = await options.rescanAgents()
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
        writeJson(response, 200, await readBackgroundActivity(storage))
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
        writeJson(response, 200, await facets.query())
        return
      }
      if (url.pathname === '/api/v1/projects/launchable') {
        writeJson(response, 200, await readLaunchableProjects(storage, url.searchParams))
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
        writeJson(response, 200, await relationships.query(logicalSessionId))
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
