import type { JsonValue } from '../domain/common'
import type { KnownReplicationEntityType } from './types'

export type ReplicationPolicyMode = 'metadata-only' | 'redacted' | 'full'
export type HistoryScopeMode = 'include-existing' | 'from-now'

export interface ReplicationPolicy {
  mode: ReplicationPolicyMode
  revision: string
}

export interface HistoryBoundary {
  mode: HistoryScopeMode
  revision: string
  boundaryCapturedAt?: string
}

export type ReplicationAvailability<T extends JsonValue = JsonValue> =
  | { state: 'value'; value: T }
  | { state: 'null' }
  | { state: 'redacted' }
  | { state: 'omitted'; reason: 'policy' | 'not-captured' | 'history-boundary' | 'dependency-minimized' }

export type ReplicationFieldClass = 'metadata' | 'content' | 'path' | 'raw-content' | 'secret' | 'unclassified'

export interface ReplicationEntityFieldContract {
  field: string
  class: Exclude<ReplicationFieldClass, 'unclassified'>
  minimumDependency?: boolean
}

export interface ReplicationEntityContract {
  entityType: KnownReplicationEntityType
  fields: readonly ReplicationEntityFieldContract[]
}

const CONTRACTS: Partial<Record<KnownReplicationEntityType, ReplicationEntityContract>> = {
  AgentProduct: {
    entityType: 'AgentProduct',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'name', class: 'metadata' },
      { field: 'vendor', class: 'metadata' },
      { field: 'homepage', class: 'metadata' },
    ],
  },
  Host: {
    entityType: 'Host',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'name', class: 'metadata' },
      { field: 'platform', class: 'metadata' },
      { field: 'arch', class: 'metadata' },
      { field: 'createdAt', class: 'metadata' },
      { field: 'lastSeenAt', class: 'metadata' },
    ],
  },
  AgentInstallation: {
    entityType: 'AgentInstallation',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'hostId', class: 'metadata' },
      { field: 'productId', class: 'metadata' },
      { field: 'version', class: 'metadata' },
      { field: 'executable', class: 'path' },
      { field: 'configRoot', class: 'path' },
      { field: 'dataRoot', class: 'path' },
      { field: 'firstSeenAt', class: 'metadata' },
      { field: 'lastSeenAt', class: 'metadata' },
    ],
  },
  RuntimeProfile: {
    entityType: 'RuntimeProfile',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'installationId', class: 'metadata' },
      { field: 'nativeProfileId', class: 'metadata' },
      { field: 'name', class: 'content' },
      { field: 'configRoot', class: 'path' },
      { field: 'dataRoot', class: 'path' },
      { field: 'firstSeenAt', class: 'metadata' },
      { field: 'lastSeenAt', class: 'metadata' },
    ],
  },
  Project: {
    entityType: 'Project',
    fields: [
      { field: 'id', class: 'metadata', minimumDependency: true },
      { field: 'name', class: 'content' },
      { field: 'repositoryIdentity', class: 'metadata', minimumDependency: true },
      { field: 'createdAt', class: 'metadata' },
      { field: 'lastSeenAt', class: 'metadata' },
    ],
  },
  Workspace: {
    entityType: 'Workspace',
    fields: [
      { field: 'id', class: 'metadata', minimumDependency: true },
      { field: 'hostId', class: 'metadata', minimumDependency: true },
      { field: 'projectId', class: 'metadata', minimumDependency: true },
      { field: 'path', class: 'path' },
      { field: 'repositoryId', class: 'metadata', minimumDependency: true },
      { field: 'worktreeId', class: 'metadata', minimumDependency: true },
    ],
  },
  LogicalSession: {
    entityType: 'LogicalSession',
    fields: [
      { field: 'id', class: 'metadata', minimumDependency: true },
      { field: 'installationId', class: 'metadata', minimumDependency: true },
      { field: 'runtimeProfileId', class: 'metadata', minimumDependency: true },
      { field: 'projectId', class: 'metadata', minimumDependency: true },
      { field: 'workspaceId', class: 'metadata', minimumDependency: true },
      { field: 'title', class: 'content' },
      { field: 'startedAt', class: 'metadata' },
      { field: 'endedAt', class: 'metadata' },
    ],
  },
  SourceSession: {
    entityType: 'SourceSession',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'sourceId', class: 'metadata' },
      { field: 'installationId', class: 'metadata' },
      { field: 'runtimeProfileId', class: 'metadata' },
      { field: 'nativeSessionId', class: 'metadata' },
      { field: 'logicalSessionId', class: 'metadata' },
      { field: 'nativeParentSessionId', class: 'metadata' },
    ],
  },
  SessionRelationship: {
    entityType: 'SessionRelationship',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'fromSessionId', class: 'metadata' },
      { field: 'toSessionId', class: 'metadata' },
      { field: 'type', class: 'metadata' },
      { field: 'evidenceRefs', class: 'metadata' },
      { field: 'confidence', class: 'metadata' },
    ],
  },
  AgentActor: {
    entityType: 'AgentActor',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'installationId', class: 'metadata' },
      { field: 'logicalSessionId', class: 'metadata' },
      { field: 'parentActorId', class: 'metadata' },
      { field: 'role', class: 'metadata' },
      { field: 'nativeActorId', class: 'metadata' },
      { field: 'evidenceRefs', class: 'metadata' },
    ],
  },
  SourceRecord: {
    entityType: 'SourceRecord',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'sourceId', class: 'metadata' },
      { field: 'installationId', class: 'metadata' },
      { field: 'sourceSessionNativeId', class: 'metadata' },
      { field: 'nativeType', class: 'metadata' },
      { field: 'nativeId', class: 'metadata' },
      { field: 'sourceSequence', class: 'metadata' },
      { field: 'occurredAt', class: 'metadata' },
      { field: 'capturedAt', class: 'metadata' },
      { field: 'locator', class: 'path' },
      { field: 'fingerprint', class: 'metadata' },
      { field: 'payload', class: 'raw-content' },
      { field: 'parserVersion', class: 'metadata' },
    ],
  },
  Evidence: {
    entityType: 'Evidence',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'captureMethod', class: 'metadata' },
      { field: 'derivation', class: 'metadata' },
      { field: 'confidence', class: 'metadata' },
      { field: 'sourceRecordId', class: 'metadata' },
      { field: 'sourceLocator', class: 'path' },
      { field: 'parserVersion', class: 'metadata' },
      { field: 'eventTime', class: 'metadata' },
      { field: 'capturedAt', class: 'metadata' },
      { field: 'missingReason', class: 'content' },
    ],
  },
  CanonicalObservation: {
    entityType: 'CanonicalObservation',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'hostId', class: 'metadata' },
      { field: 'installationId', class: 'metadata' },
      { field: 'projectId', class: 'metadata' },
      { field: 'workspaceId', class: 'metadata' },
      { field: 'logicalSessionId', class: 'metadata' },
      { field: 'sourceSessionId', class: 'metadata' },
      { field: 'interactionId', class: 'metadata' },
      { field: 'actorId', class: 'metadata' },
      { field: 'kind', class: 'metadata' },
      { field: 'sourceSequence', class: 'metadata' },
      { field: 'canonicalSequence', class: 'metadata' },
      { field: 'occurredAt', class: 'metadata' },
      { field: 'capturedAt', class: 'metadata' },
      { field: 'payload', class: 'content' },
      { field: 'evidenceRefs', class: 'metadata' },
    ],
  },
  Coverage: {
    entityType: 'Coverage',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'subjectType', class: 'metadata' },
      { field: 'subjectId', class: 'metadata' },
      { field: 'capability', class: 'metadata' },
      { field: 'from', class: 'metadata' },
      { field: 'to', class: 'metadata' },
      { field: 'status', class: 'metadata' },
      { field: 'reason', class: 'content' },
      { field: 'evidenceRefs', class: 'metadata' },
    ],
  },
  AssetDefinition: {
    entityType: 'AssetDefinition',
    fields: [
      { field: 'id', class: 'metadata', minimumDependency: true },
      { field: 'type', class: 'metadata', minimumDependency: true },
      { field: 'canonicalName', class: 'metadata', minimumDependency: true },
      { field: 'displayName', class: 'content' },
      { field: 'upstreamIdentity', class: 'metadata', minimumDependency: true },
    ],
  },
  AssetBinding: {
    entityType: 'AssetBinding',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'assetId', class: 'metadata' },
      { field: 'installationId', class: 'metadata' },
      { field: 'runtimeProfileId', class: 'metadata' },
      { field: 'path', class: 'path' },
      { field: 'source', class: 'content' },
      { field: 'version', class: 'metadata' },
    ],
  },
  AssetStateObservation: {
    entityType: 'AssetStateObservation',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'assetBindingId', class: 'metadata' },
      { field: 'state', class: 'metadata' },
      { field: 'value', class: 'metadata' },
      { field: 'observedAt', class: 'metadata' },
      { field: 'evidenceRefs', class: 'metadata' },
    ],
  },
  ToolDefinition: {
    entityType: 'ToolDefinition',
    fields: [
      { field: 'id', class: 'metadata' },
      { field: 'canonicalName', class: 'metadata' },
      { field: 'displayName', class: 'content' },
      { field: 'sourceType', class: 'metadata' },
      { field: 'assetDefinitionId', class: 'metadata' },
      { field: 'installationId', class: 'metadata' },
      { field: 'schemaHash', class: 'metadata' },
    ],
  },
}

export function getReplicationEntityContract(entityType: KnownReplicationEntityType): ReplicationEntityContract | undefined {
  return CONTRACTS[entityType]
}

const CREDENTIAL_KEY = /^(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|passwd|authorization|cookie|secret|private[-_]?key)$/i
const CREDENTIAL_TEXT = /\b(?:bearer\s+[a-z0-9._~+\/-]+=*|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/gi
const WINDOWS_HOME = /([A-Za-z]:\\Users\\)[^\\/]+/g
const POSIX_HOME = /\/(Users|home)\/[^/]+/g

function redactCredentialText(value: string): string {
  return value.replace(CREDENTIAL_TEXT, '[REDACTED]')
}

function redactLocalHome(value: string): string {
  return redactCredentialText(value)
    .replace(WINDOWS_HOME, '$1[USER]')
    .replace(POSIX_HOME, '/$1/[USER]')
}

export function sanitizeReplicationValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactCredentialText(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(item => sanitizeReplicationValue(item))

  const output: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = CREDENTIAL_KEY.test(key) ? '[REDACTED]' : sanitizeReplicationValue(item)
  }
  return output
}

export function sanitizeReplicationPath(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactLocalHome(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(item => sanitizeReplicationPath(item))

  const output: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = CREDENTIAL_KEY.test(key) ? '[REDACTED]' : sanitizeReplicationPath(item)
  }
  return output
}

export function applyReplicationFieldPolicy(input: {
  value: JsonValue | undefined
  fieldClass: ReplicationFieldClass
  policy: ReplicationPolicy
  captureState?: 'available' | 'not-captured' | 'redacted'
  historyState?: 'allowed' | 'history-boundary' | 'dependency-minimized'
}): ReplicationAvailability {
  if (input.captureState === 'not-captured') return { state: 'omitted', reason: 'not-captured' }
  if (input.captureState === 'redacted') return { state: 'redacted' }
  if (input.historyState === 'history-boundary') return { state: 'omitted', reason: 'history-boundary' }
  if (input.historyState === 'dependency-minimized') return { state: 'omitted', reason: 'dependency-minimized' }
  if (input.value === undefined) return { state: 'omitted', reason: 'not-captured' }
  if (input.value === null) return { state: 'null' }
  if (input.fieldClass === 'unclassified') return { state: 'omitted', reason: 'policy' }

  if (input.policy.mode === 'metadata-only' && input.fieldClass !== 'metadata') {
    return { state: 'omitted', reason: 'policy' }
  }
  if (input.fieldClass === 'secret') return { state: 'redacted' }
  if (input.fieldClass === 'raw-content') {
    return input.policy.mode === 'full'
      ? { state: 'value', value: sanitizeReplicationValue(input.value) }
      : { state: 'omitted', reason: 'policy' }
  }
  if (input.policy.mode === 'redacted' && input.fieldClass === 'path') {
    return { state: 'value', value: sanitizeReplicationPath(input.value) }
  }
  return { state: 'value', value: sanitizeReplicationValue(input.value) }
}

const POLICY_RANK: Record<ReplicationPolicyMode, number> = {
  'metadata-only': 0,
  redacted: 1,
  full: 2,
}

export interface ReplicationPolicyTransitionDecision {
  relation: 'same' | 'tightened' | 'relaxed'
  requireStreamRollover: boolean
  requireReconcile: boolean
  allowAutomaticHistoricalBackfill: false
}

export function decideReplicationPolicyTransition(
  previous: ReplicationPolicy,
  next: ReplicationPolicy,
): ReplicationPolicyTransitionDecision {
  const previousRank = POLICY_RANK[previous.mode]
  const nextRank = POLICY_RANK[next.mode]
  if (nextRank < previousRank) {
    return {
      relation: 'tightened',
      requireStreamRollover: true,
      requireReconcile: true,
      allowAutomaticHistoricalBackfill: false,
    }
  }
  if (nextRank > previousRank) {
    return {
      relation: 'relaxed',
      requireStreamRollover: false,
      requireReconcile: true,
      allowAutomaticHistoricalBackfill: false,
    }
  }
  return {
    relation: 'same',
    requireStreamRollover: false,
    requireReconcile: previous.revision !== next.revision,
    allowAutomaticHistoricalBackfill: false,
  }
}
