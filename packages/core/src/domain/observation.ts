import type {
  AgentActorId,
  AgentInstallationId,
  CaptureMethod,
  Confidence,
  CoverageId,
  Derivation,
  EvidenceId,
  HostId,
  InteractionId,
  JsonValue,
  LogicalSessionId,
  ObservationId,
  ProjectId,
  SourceRecordId,
  SourceSessionId,
  WorkspaceId,
} from './common'
import type { ObservationIdentityHints } from './identity'

export interface SourceLocator {
  kind: 'file' | 'database' | 'runtime-hook' | 'external'
  path?: string
  offset?: number
  rowId?: string
  table?: string
  hookEventId?: string
}

export interface SourceRecord {
  id: SourceRecordId
  sourceId: string
  installationId: AgentInstallationId
  sourceSessionNativeId?: string
  nativeType: string
  nativeId?: string
  sourceSequence?: number
  occurredAt?: string
  capturedAt: string
  locator: SourceLocator
  fingerprint?: string
  payload: unknown
  parserVersion: string
}

export interface Evidence {
  id: EvidenceId
  captureMethod: CaptureMethod
  derivation: Derivation
  confidence: Confidence
  sourceRecordId?: SourceRecordId
  sourceLocator?: SourceLocator
  parserVersion?: string
  eventTime?: string
  capturedAt: string
  missingReason?: string
}

export interface EvidenceCandidate {
  captureMethod: CaptureMethod
  derivation: Derivation
  sourceRecordId?: SourceRecordId
  sourceLocator?: SourceLocator
  parserVersion?: string
  nativeStableId?: string
  eventTime?: string
  capturedAt: string
  missingReason?: string
  confidenceHint?: Confidence
}

export type ObservationKind =
  | 'session.lifecycle'
  | 'message.user'
  | 'message.assistant'
  | 'message.reasoning'
  | 'model.call'
  | 'model.changed'
  | 'tool.call'
  | 'tool.progress'
  | 'tool.result'
  | 'permission.request'
  | 'permission.response'
  | 'subagent.spawn'
  | 'subagent.end'
  | 'context.compaction'
  | 'context.summary'
  | 'artifact.action'
  | 'usage'
  | 'unknown'

export interface CanonicalObservation {
  id: ObservationId
  hostId: HostId
  installationId: AgentInstallationId
  projectId?: ProjectId
  workspaceId?: WorkspaceId
  logicalSessionId: LogicalSessionId
  sourceSessionId: SourceSessionId
  interactionId?: InteractionId
  actorId?: AgentActorId
  kind: ObservationKind
  sourceSequence?: number
  canonicalSequence?: number
  occurredAt?: string
  capturedAt: string
  payload: unknown
  evidenceRefs: EvidenceId[]
}

export interface ObservationCandidate {
  kind: ObservationKind
  nativeEventId?: string
  nativeCallId?: string
  sourceSequence?: number
  occurredAt?: string
  capturedAt: string
  payload: unknown
  identityHints: ObservationIdentityHints
  dedupHints?: ObservationDedupHints
}

export interface ObservationDedupHints {
  nativeEventId?: string
  nativeCallId?: string
  sourceSequence?: number
  sharedEventKey?: string
  payloadFingerprint?: string
}

export type CoverageStatus = 'complete' | 'partial' | 'unavailable' | 'unknown'

export interface ObservationCoverage {
  id: CoverageId
  subjectType: string
  subjectId: string
  capability: string
  from?: string
  to?: string
  status: CoverageStatus
  reason?: string
  evidenceRefs: EvidenceId[]
}

export interface CoverageDeclaration {
  subjectType: string
  subjectId: string
  capability: string
  from?: string
  to?: string
  status: CoverageStatus
  reason?: string
  evidenceCandidates?: EvidenceCandidate[]
}

export type CapabilityStatus =
  | 'available'
  | 'partial'
  | 'experimental'
  | 'unavailable'
  | 'not-applicable'

export interface ObservationCapability {
  sourceId: string
  name: string
  status: CapabilityStatus
  captureModes: string[]
  reason?: string
  evidenceRefs?: EvidenceId[]
}

export interface NormalizedSourceOutput {
  observations: ObservationCandidate[]
  evidenceCandidates: EvidenceCandidate[]
  coverage?: CoverageDeclaration[]
  assetHints?: unknown[]
  sessionRelationshipHints?: unknown[]
}

export interface UnknownObservationPayload {
  rawType: string
  rawPayload: JsonValue
}
