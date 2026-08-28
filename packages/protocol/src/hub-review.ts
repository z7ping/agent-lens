import type { JsonValue } from './timeline'

export type HubReadAvailability<T extends JsonValue = JsonValue> =
  | { state: 'value'; value: T }
  | { state: 'null' }
  | { state: 'redacted' }
  | {
      state: 'omitted'
      reason: 'policy' | 'not-captured' | 'history-boundary' | 'dependency-minimized'
    }

export interface HubReviewOriginDto {
  kind: 'local' | 'remote'
  nodeId: string
  entityId: string
  generationId?: string
}

export interface HubReviewReferenceDto {
  entityType: string
  publicId: string
}

export interface HubReviewTimelineItemDto {
  id: string
  origin: HubReviewOriginDto
  kind: HubReadAvailability
  capturedAt: HubReadAvailability
  occurredAt: HubReadAvailability
  payload: HubReadAvailability
  references: Record<string, HubReviewReferenceDto | HubReviewReferenceDto[]>
}

export interface HubReviewDetailDto {
  logicalSessionId: string
  origin: HubReviewOriginDto
  title: HubReadAvailability
  items: HubReviewTimelineItemDto[]
  meta: {
    count: number
    generatedAt: string
  }
}
