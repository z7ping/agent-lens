import { createServer, type Server, type ServerResponse } from 'node:http'
import type { StorageService } from '@agent-lens/core'
import { TimelineProjection } from '@agent-lens/projection-timeline'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  TIMELINE_OBSERVATION_KINDS,
  type HealthResponseDto,
  type JsonValue,
  type TimelineObservationKind,
  type TimelineQueryDto,
} from '@agent-lens/protocol'

export const AGENT_LENS_HTTP_HOST = '127.0.0.1' as const
export const DEFAULT_AGENT_LENS_HTTP_PORT = 56789

export interface HttpSurfaceOptions {
  port?: number
}

export interface RunningHttpSurface {
  readonly host: typeof AGENT_LENS_HTTP_HOST
  readonly port: number
  readonly server: Server
  dispose(): Promise<void>
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

function badRequest(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number }
  error.statusCode = 400
  return error
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

  const limitValue = params.get('limit')
  let limit: number | undefined
  if (limitValue) {
    limit = Number(limitValue)
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw badRequest('Timeline limit must be an integer between 1 and 1000')
    }
  }

  const from = optionalTimestamp(params, 'from')
  const to = optionalTimestamp(params, 'to')
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw badRequest('Timeline from must be earlier than or equal to to')
  }

  return {
    ...(params.get('installationId') ? { installationId: params.get('installationId')! } : {}),
    ...(params.get('logicalSessionId') ? { logicalSessionId: params.get('logicalSessionId')! } : {}),
    ...(kind ? { kind } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

export async function startHttpSurface(
  storage: StorageService,
  options: HttpSurfaceOptions = {},
): Promise<RunningHttpSurface> {
  const timeline = new TimelineProjection(storage)
  const requestedPort = options.port ?? DEFAULT_AGENT_LENS_HTTP_PORT
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`Invalid AgentLens HTTP port: ${requestedPort}`)
  }

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' })
        return
      }

      const url = new URL(request.url ?? '/', `http://${AGENT_LENS_HTTP_HOST}`)
      if (url.pathname === '/api/v1/health') {
        const health = await storage.health()
        const details = health.details
          ? Object.fromEntries(
            Object.entries(health.details).map(([key, value]) => [key, jsonValue(value)]),
          )
          : undefined
        const body: HealthResponseDto = {
          status: health.ok ? 'ok' : 'degraded',
          protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
          storage: {
            ok: health.ok,
            ...(health.schemaVersion === undefined ? {} : { schemaVersion: health.schemaVersion }),
            ...(details ? { details } : {}),
          },
        }
        writeJson(response, health.ok ? 200 : 503, body)
        return
      }

      if (url.pathname === '/api/v1/timeline') {
        writeJson(response, 200, await timeline.query(parseTimelineQuery(url.searchParams)))
        return
      }

      writeJson(response, 404, { error: 'not_found' })
    } catch (error) {
      const statusCode = error && typeof error === 'object' && 'statusCode' in error
        ? Number((error as { statusCode: unknown }).statusCode)
        : 500
      writeJson(response, statusCode, {
        error: statusCode === 400 ? 'bad_request' : 'internal_error',
        ...(statusCode === 400 && error instanceof Error ? { message: error.message } : {}),
      })
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
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
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}

export const httpSurfaceInternals = {
  parseTimelineQuery,
  jsonValue,
}
