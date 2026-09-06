import {
  TIMELINE_OBSERVATION_KINDS,
  type InsightsQueryDto,
  type ReviewDetailDirection,
  type ReviewDetailFilter,
  type ReviewDetailQueryDto,
  type ReviewQueryDto,
  type ReviewStatusFilter,
  type SessionQueryDto,
  type TimelineDirection,
  type TimelineObservationKind,
  type TimelineQueryDto,
  type ToolAssetUsageQueryDto,
} from '@agent-lens/protocol'
import { badRequest } from './http-utils'

function optionalParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)
  return value ? value : undefined
}
export function parseLimit(params: URLSearchParams, max: number): number | undefined {
  const raw = optionalParam(params, 'limit')
  if (!raw) return undefined
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw badRequest(`Limit must be an integer between 1 and ${max}`)
  }
  return limit
}

function optionalTimestamp(params: URLSearchParams, key: string): string | undefined {
  const value = optionalParam(params, key)
  if (!value) return undefined
  if (!Number.isFinite(Date.parse(value))) throw badRequest(`Invalid ${key} timestamp`)
  return value
}

function orderedRange(
  params: URLSearchParams,
  label: string,
): { from?: string; to?: string } {
  const from = optionalTimestamp(params, 'from')
  const to = optionalTimestamp(params, 'to')
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw badRequest(`${label} from must be earlier than or equal to to`)
  }
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }
}

function timelineKind(value: string | undefined): TimelineObservationKind | undefined {
  if (!value) return undefined
  if ((TIMELINE_OBSERVATION_KINDS as readonly string[]).includes(value)) {
    return value as TimelineObservationKind
  }
  throw badRequest(`Unknown timeline kind: ${value}`)
}

function timelineDirection(value: string | undefined): TimelineDirection | undefined {
  if (!value) return undefined
  if (value === 'forward' || value === 'backward') return value
  throw badRequest(`Unknown timeline direction: ${value}`)
}

export function parseTimelineQuery(params: URLSearchParams): TimelineQueryDto {
  const kind = timelineKind(optionalParam(params, 'kind'))
  const direction = timelineDirection(optionalParam(params, 'direction'))
  const cursor = optionalParam(params, 'cursor')
  const installationId = optionalParam(params, 'installationId')
  const logicalSessionId = optionalParam(params, 'logicalSessionId')
  const range = orderedRange(params, 'Timeline')
  const limit = parseLimit(params, 1000)
  return {
    ...(installationId ? { installationId } : {}),
    ...(logicalSessionId ? { logicalSessionId } : {}),
    ...(kind ? { kind } : {}),
    ...range,
    ...(cursor ? { cursor } : {}),
    ...(direction ? { direction } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}
export function parseSessionQuery(params: URLSearchParams): SessionQueryDto {
  const installationId = optionalParam(params, 'installationId')
  const logicalSessionId = optionalParam(params, 'logicalSessionId')
  const limit = parseLimit(params, 500)
  return {
    ...(installationId ? { installationId } : {}),
    ...(logicalSessionId ? { logicalSessionId } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

export function parseUsageQuery(params: URLSearchParams): ToolAssetUsageQueryDto {
  const installationId = optionalParam(params, 'installationId')
  const logicalSessionId = optionalParam(params, 'logicalSessionId')
  const projectId = optionalParam(params, 'projectId')
  const sourceId = optionalParam(params, 'sourceId')
  const toolName = optionalParam(params, 'toolName')
  const limit = parseLimit(params, 500)
  return {
    ...(installationId ? { installationId } : {}),
    ...(logicalSessionId ? { logicalSessionId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(toolName ? { toolName } : {}),
    ...orderedRange(params, 'Usage'),
    ...(limit === undefined ? {} : { limit }),
  }
}

export function parseInsightsQuery(params: URLSearchParams): InsightsQueryDto {
  const installationId = optionalParam(params, 'installationId')
  const logicalSessionId = optionalParam(params, 'logicalSessionId')
  const projectId = optionalParam(params, 'projectId')
  const sourceId = optionalParam(params, 'sourceId')
  return {
    ...(installationId ? { installationId } : {}),
    ...(logicalSessionId ? { logicalSessionId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...orderedRange(params, 'Insights'),
  }
}

function parseReviewStatus(value: string | undefined): ReviewStatusFilter | undefined {
  if (!value) return undefined
  if (value === 'all' || value === 'with-errors' || value === 'clean') return value
  throw badRequest(`Unknown review status: ${value}`)
}

function parseReviewDetailDirection(value: string | undefined): ReviewDetailDirection | undefined {
  if (!value) return undefined
  if (value === 'forward' || value === 'backward') return value
  throw badRequest(`Unknown review detail direction: ${value}`)
}

function parseReviewDetailFilter(value: string | undefined): ReviewDetailFilter | undefined {
  if (!value) return undefined
  if (value === 'all' || value === 'errors' || value === 'latency' || value === 'latest') return value
  throw badRequest(`Unknown review detail filter: ${value}`)
}

function parsePositiveInteger(params: URLSearchParams, key: string): number | undefined {
  const raw = optionalParam(params, key)
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw badRequest(`${key} must be a positive integer`)
  return value
}

export function parseReviewQuery(params: URLSearchParams): ReviewQueryDto {
  const cursor = optionalParam(params, 'cursor')
  const projectId = optionalParam(params, 'projectId')
  const sourceId = optionalParam(params, 'sourceId')
  const search = optionalParam(params, 'search')
  const limit = parseLimit(params, 500)
  const status = parseReviewStatus(optionalParam(params, 'status'))
  return {
    ...(cursor ? { cursor } : {}),
    ...(projectId ? { projectId } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...orderedRange(params, 'Review'),
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

export function parseReviewDetailQuery(params: URLSearchParams): ReviewDetailQueryDto {
  const cursor = optionalParam(params, 'cursor')
  const limit = parseLimit(params, 100)
  const direction = parseReviewDetailDirection(optionalParam(params, 'direction'))
  const filter = parseReviewDetailFilter(optionalParam(params, 'filter'))
  const ordinal = parsePositiveInteger(params, 'ordinal')
  return {
    ...(cursor ? { cursor } : {}),
    ...(ordinal === undefined ? {} : { ordinal }),
    ...(direction ? { direction } : {}),
    ...(filter ? { filter } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}
