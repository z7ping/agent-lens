import type { JsonValue, TimelineEvidenceDto, TimelineObservationKind } from './timeline'
import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type ReviewStatusFilter = 'all' | 'with-errors' | 'clean'
export type ReviewMessageRole = 'user' | 'assistant' | 'commentary' | 'reasoning'
export type ReviewEventCategory = 'permission' | 'subagent' | 'context' | 'model' | 'lifecycle' | 'artifact' | 'usage' | 'unknown'
export type ReviewDetailFilter = 'all' | 'errors' | 'latency' | 'latest'
export type ReviewDetailDirection = 'forward' | 'backward'
export type ReviewSessionActivity = 'user-task' | 'branch-task' | 'subagent' | 'internal-review' | 'system-activity'

export interface ReviewNodeSourceDto {
  nativeEventId?: string
  nativeParentEventId?: string
  parentObservationId?: string
  occurredAt?: string
  capturedAt: string
}

export interface ReviewSessionSummaryDto {
  id: string
  installationId: string
  productId: string
  sourceIds: string[]
  projectId?: string
  projectName?: string
  workspaceId?: string
  workspacePath?: string
  title?: string
  preview?: string
  startedAt: string
  endedAt: string
  durationMs: number
  observationCount: number
  /** 兼容字段：严格等于真实用户轮次。 */
  interactionCount: number
  userTurnCount?: number
  systemContextCount?: number
  internalReviewCount?: number
  otherEventCount?: number
  toolCount: number
  errorCount: number
  hasErrors: boolean
  sessionActivity?: ReviewSessionActivity
  activitySourceLabel?: string
  parentSessionId?: string
  /** 搜索命中系统/工具/审查内容时由服务端返回来源。 */
  searchMatchSources?: Array<'title' | 'user' | 'system' | 'review' | 'tool' | 'other'>
}

export interface ReviewMessageNodeDto extends ReviewNodeSourceDto {
  type: 'message'
  id: string
  role: ReviewMessageRole
  at: string
  sourceId: string
  text: string
  payload: JsonValue
  evidence: TimelineEvidenceDto[]
  observationIds: string[]
}

export interface ReviewToolNodeDto extends ReviewNodeSourceDto {
  type: 'tool'
  id: string
  at: string
  sourceId: string
  name: string
  callId?: string
  status: 'running' | 'success' | 'error' | 'unknown'
  startedAt: string
  endedAt?: string
  durationMs?: number
  input?: JsonValue
  output?: JsonValue
  payload: JsonValue
  evidence: TimelineEvidenceDto[]
  observationIds: string[]
}

export interface ReviewEventNodeDto extends ReviewNodeSourceDto {
  type: 'event'
  id: string
  at: string
  sourceId: string
  kind: TimelineObservationKind
  category: ReviewEventCategory
  label: string
  payload: JsonValue
  evidence: TimelineEvidenceDto[]
  observationIds: string[]
}

export type ReviewNodeDto = ReviewMessageNodeDto | ReviewToolNodeDto | ReviewEventNodeDto

export interface ReviewInteractionDto {
  id: string
  ordinal: number
  trigger: 'user' | 'background'
  startedAt: string
  endedAt: string
  nodes: ReviewNodeDto[]
}

export interface ReviewInteractionIndexDto {
  id: string
  ordinal: number
  trigger: 'user' | 'background'
  startedAt: string
  endedAt: string
  hasError: boolean
  preview?: string
}

export interface ReviewDetailPageDto {
  count: number
  hasMore: boolean
  nextCursor?: string
  direction: ReviewDetailDirection
  filter: ReviewDetailFilter
  latencyThresholdMs?: number
}

export interface ReviewSessionDetailDto extends ReviewSessionSummaryDto {
  interactions: ReviewInteractionDto[]
  interactionIndex?: ReviewInteractionIndexDto[]
  page: ReviewDetailPageDto
}

export interface ReviewDetailQueryDto {
  cursor?: string
  ordinal?: number
  limit?: number
  direction?: ReviewDetailDirection
  filter?: ReviewDetailFilter
}

export interface ReviewQueryDto {
  cursor?: string
  sourceId?: string
  projectId?: string
  from?: string
  to?: string
  status?: ReviewStatusFilter
  search?: string
  limit?: number
}

export interface ReviewResponseDto {
  items: ReviewSessionSummaryDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    count: number
    hasMore: boolean
    nextCursor?: string
    generatedAt: string
  }
}
