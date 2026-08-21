import type { TimelineObservationKind } from './timeline'
import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type SessionInteractionTrigger = 'user' | 'background'

export interface SessionInteractionDto {
  id: string
  ordinal: number
  trigger: SessionInteractionTrigger
  startedAt: string
  endedAt: string
  startObservationId: string
  endObservationId: string
  observationCount: number
  observationIds: string[]
}

export interface SessionSummaryDto {
  id: string
  installationId: string
  productId: string
  projectId?: string
  workspaceId?: string
  sourceIds: string[]
  nativeSessionIds: string[]
  nativeParentSessionIds: string[]
  startedAt: string
  endedAt: string
  observationCount: number
  interactionCount: number
  observationCounts: Partial<Record<TimelineObservationKind, number>>
}

export interface SessionDetailDto extends SessionSummaryDto {
  interactions: SessionInteractionDto[]
}

export interface SessionQueryDto {
  installationId?: string
  logicalSessionId?: string
  limit?: number
}

export interface SessionResponseDto {
  items: SessionDetailDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    count: number
    hasMore: boolean
    generatedAt: string
  }
}
