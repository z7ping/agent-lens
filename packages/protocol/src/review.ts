import type { JsonValue, TimelineEvidenceDto, TimelineObservationKind } from './timeline'
import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type ReviewStatusFilter = 'all' | 'with-errors' | 'clean'
export type ReviewMessageRole = 'user' | 'assistant' | 'reasoning'
export type ReviewEventCategory = 'permission' | 'subagent' | 'context' | 'model' | 'lifecycle' | 'artifact' | 'usage' | 'unknown'

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
  interactionCount: number
  toolCount: number
  errorCount: number
  hasErrors: boolean
}

export interface ReviewMessageNodeDto {
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

export interface ReviewToolNodeDto {
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

export interface ReviewEventNodeDto {
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

export interface ReviewDetailPageDto {
  count: number
  hasMore: boolean
  nextCursor?: string
}

export interface ReviewSessionDetailDto extends ReviewSessionSummaryDto {
  interactions: ReviewInteractionDto[]
  page: ReviewDetailPageDto
}

export interface ReviewDetailQueryDto {
  cursor?: string
  limit?: number
}

export interface ReviewQueryDto {
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
    generatedAt: string
  }
}
