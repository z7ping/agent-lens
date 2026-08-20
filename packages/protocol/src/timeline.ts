export const AGENT_LENS_PROTOCOL_VERSION = '1.0' as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export const TIMELINE_OBSERVATION_KINDS = [
  'session.lifecycle',
  'message.user',
  'message.assistant',
  'message.reasoning',
  'model.call',
  'model.changed',
  'tool.call',
  'tool.progress',
  'tool.result',
  'permission.request',
  'permission.response',
  'subagent.spawn',
  'subagent.end',
  'context.compaction',
  'context.summary',
  'artifact.action',
  'usage',
  'unknown',
] as const

export type TimelineObservationKind = typeof TIMELINE_OBSERVATION_KINDS[number]

export type TimelineCaptureMethod =
  | 'runtime-hook'
  | 'native-log'
  | 'native-db'
  | 'static-scan'
  | 'external-import'

export type TimelineDerivation =
  | 'observed'
  | 'reported'
  | 'derived'
  | 'estimated'
  | 'inferred'

export type TimelineConfidence = 'exact' | 'high' | 'medium' | 'low' | 'unknown'

export interface TimelineSourceLocatorDto {
  kind: 'file' | 'database' | 'runtime-hook' | 'external'
  path?: string
  offset?: number
  rowId?: string
  table?: string
  hookEventId?: string
}

export interface TimelineEvidenceDto {
  id: string
  captureMethod: TimelineCaptureMethod
  derivation: TimelineDerivation
  confidence: TimelineConfidence
  sourceRecordId?: string
  sourceLocator?: TimelineSourceLocatorDto
  parserVersion?: string
  eventTime?: string
  capturedAt: string
  missingReason?: string
}

export interface TimelineItemDto {
  id: string
  kind: TimelineObservationKind
  sourceId: string
  productId: string
  hostId: string
  installationId: string
  projectId?: string
  workspaceId?: string
  logicalSessionId: string
  sourceSessionId: string
  interactionId?: string
  actorId?: string
  sourceSequence?: number
  canonicalSequence?: number
  occurredAt?: string
  capturedAt: string
  effectiveAt: string
  payload: JsonValue
  evidence: TimelineEvidenceDto[]
}

export interface TimelineQueryDto {
  installationId?: string
  logicalSessionId?: string
  kind?: TimelineObservationKind
  from?: string
  to?: string
  limit?: number
}

export interface TimelineResponseDto {
  items: TimelineItemDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    count: number
    hasMore: boolean
    generatedAt: string
  }
}
