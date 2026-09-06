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

export function parseLimit(params: URLSearchParams, max: number): number | undefined {
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

export function parseTimelineQuery(params: URLSearchParams): TimelineQueryDto {
  const kindValue = params.get('kind')
  let kind: TimelineObservationKind | undefined
  if (kindValue) {
    if (!(TIMELINE_OBSERVATION_KINDS as readonly string[]).includes(kindValue)) {
      throw badRequest(`Unknown timeline kind: ${kindValue}`)
    }
    kind = kindValue as TimelineObservationKind
  }
  const directionValue = params.get('direction')
  if (directionValue && directionValue !== 'forward' && directionValue !== 'backward') {
    throw badRequest(`Unknown timeline direction: ${directionValue}`)
  }
  const range = orderedRange(params, 'Timeline')
  const limit = parseLimit(params, 1000)
  return {
    ...(params.get('installationId') ? { installationId: params.get('installationId')! } : {}),
    ...(params.get('logicalSessionId') ? { logicalSessionId: params.get('logicalSessionId')! } : {}),
    ...(kind ? { kind } : {}),
    ...range,
    ...(params.get('cursor') ? { cursor: params.get('cursor')! } : {}),
    ...(directionValue ? { direction: directionValue as TimelineDirection } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

export function parseSessionQuery(params: URLSearchParams): SessionQueryDto {
  const limit = parseLimit(params, 500)
  return {
    ...(params.get('installationId') ? { installationId: params.get('installationId')! } : {}),
    ...(params.get('logicalSessionId') ? { logicalSessionId: params.get('logicalSessionId')! } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

export function parseUsageQuery(params: URLSearchParams): ToolAssetUsageQueryDto {
  const limit = parseLimit(params, 500)
  return {
    ...(params.get('installationId') ? { installationId: params.get('installationId')! } : {}),
    ...(params.get('logicalSessionId') ? { logicalSessionId: params.get('logicalSessionId')! } : {}),
    ...(params.get('projectId') ? { projectId: params.get('projectId')! } : {}),
    ...(params.get('sourceId') ? { sourceId: params.get('sourceId')! } : {}),
    ...(params.get('toolName') ? { toolName: params.get('toolName')! } : {}),
    ...orderedRange(params, 'Usage'),
    ...(limit === undefined ? {} : { limit }),
  }
}

export function parseInsightsQuery(params: URLSearchParams): InsightsQueryDto {
  return {
    ...(params.get('installationId') ? { installationId: params.get('installationId')! } : {}),
    ...(params.get('logicalSessionId') ? { logicalSessionId: params.get('logicalSessionId')! } : {}),
    ...(params.get('projectId') ? { projectId: params.get('projectId')! } : {}),
    ...(params.get('sourceId') ? { sourceId: params.get('sourceId')! } : {}),
    ...orderedRange(params, 'Insights'),
  }
}

function parseReviewStatus(value: string | null): ReviewStatusFilter | undefined {
  if (!value) return undefined
  if (value === 'all' || value === 'with-errors' || value === 'clean') return value
  throw badRequest(`Unknown review status: ${value}`)
}

function parseReviewDetailDirection(value: string | null): ReviewDetailDirection | undefined {
  if (!value) return undefined
  if (value === 'forward' || value === 'backward') return value
  throw badRequest(`Unknown review detail direction: ${value}`)
}

function parseReviewDetailFilter(value: string | null): ReviewDetailFilter | undefined {
  if (!value) return undefined
  if (value === 'all' || value === 'errors' || value === 'latency' || value === 'latest') return value
  throw badRequest(`Unknown review detail filter: ${value}`)
}

function parsePositiveInteger(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key)
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw badRequest(`${key} must be a positive integer`)
  return value
}

export function parseReviewQuery(params: URLSearchParams): ReviewQueryDto {
  const limit = parseLimit(params, 500)
  const status = parseReviewStatus(params.get('status'))
  return {
    ...(params.get('cursor') ? { cursor: params.get('cursor')! } : {}),
    ...(params.get('projectId') ? { projectId: params.get('projectId')! } : {}),
    ...(params.get('sourceId') ? { sourceId: params.get('sourceId')! } : {}),
    ...orderedRange(params, 'Review'),
    ...(status ? { status } : {}),
    ...(params.get('search') ? { search: params.get('search')! } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

export function parseReviewDetailQuery(params: URLSearchParams): ReviewDetailQueryDto {
  const limit = parseLimit(params, 100)
  const direction = parseReviewDetailDirection(params.get('direction'))
  const filter = parseReviewDetailFilter(params.get('filter'))
  const ordinal = parsePositiveInteger(params, 'ordinal')
  return {
    ...(params.get('cursor') ? { cursor: params.get('cursor')! } : {}),
    ...(ordinal === undefined ? {} : { ordinal }),
    ...(direction ? { direction } : {}),
    ...(filter ? { filter } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

export const queryParamInternals = {
  optionalTimestamp,
  orderedRange,
  parseReviewStatus,
  parseReviewDetailDirection,
  parseReviewDetailFilter,
  parsePositiveInteger,
}
