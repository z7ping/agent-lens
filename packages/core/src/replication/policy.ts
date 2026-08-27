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

export type ReplicationFieldClass = 'metadata' | 'content' | 'path' | 'raw-content'

export interface ReplicationEntityFieldContract {
  field: string
  class: ReplicationFieldClass
  minimumDependency?: boolean
}

export interface ReplicationEntityContract {
  entityType: KnownReplicationEntityType
  fields: readonly ReplicationEntityFieldContract[]
}

const CONTRACTS: Partial<Record<KnownReplicationEntityType, ReplicationEntityContract>> = {
  AgentProduct: { entityType: 'AgentProduct', fields: [] },
  Host: { entityType: 'Host', fields: [] },
  AgentInstallation: {
    entityType: 'AgentInstallation',
    fields: [
      { field: 'executable', class: 'path' },
      { field: 'configRoot', class: 'path' },
      { field: 'dataRoot', class: 'path' },
    ],
  },
  RuntimeProfile: {
    entityType: 'RuntimeProfile',
    fields: [
      { field: 'name', class: 'content' },
      { field: 'configRoot', class: 'path' },
      { field: 'dataRoot', class: 'path' },
    ],
  },
  Project: {
    entityType: 'Project',
    fields: [
      { field: 'name', class: 'content' },
      { field: 'repositoryIdentity', class: 'metadata', minimumDependency: true },
    ],
  },
  Workspace: {
    entityType: 'Workspace',
    fields: [
      { field: 'path', class: 'path' },
      { field: 'repositoryId', class: 'metadata', minimumDependency: true },
      { field: 'worktreeId', class: 'metadata', minimumDependency: true },
    ],
  },
  LogicalSession: {
    entityType: 'LogicalSession',
    fields: [
      { field: 'title', class: 'content' },
      { field: 'startedAt', class: 'metadata' },
      { field: 'endedAt', class: 'metadata' },
    ],
  },
  SourceSession: { entityType: 'SourceSession', fields: [] },
  SessionRelationship: { entityType: 'SessionRelationship', fields: [] },
  AgentActor: { entityType: 'AgentActor', fields: [] },
  SourceRecord: {
    entityType: 'SourceRecord',
    fields: [
      { field: 'payload', class: 'raw-content' },
      { field: 'locator', class: 'path' },
    ],
  },
  Evidence: {
    entityType: 'Evidence',
    fields: [
      { field: 'sourceLocator', class: 'path' },
      { field: 'missingReason', class: 'content' },
    ],
  },
  CanonicalObservation: {
    entityType: 'CanonicalObservation',
    fields: [{ field: 'payload', class: 'content' }],
  },
  Coverage: {
    entityType: 'Coverage',
    fields: [{ field: 'reason', class: 'content' }],
  },
  AssetDefinition: {
    entityType: 'AssetDefinition',
    fields: [
      { field: 'displayName', class: 'content' },
      { field: 'upstreamIdentity', class: 'metadata', minimumDependency: true },
    ],
  },
  AssetBinding: {
    entityType: 'AssetBinding',
    fields: [
      { field: 'path', class: 'path' },
      { field: 'source', class: 'content' },
    ],
  },
  AssetStateObservation: { entityType: 'AssetStateObservation', fields: [] },
  ToolDefinition: {
    entityType: 'ToolDefinition',
    fields: [{ field: 'displayName', class: 'content' }],
  },
}

export function getReplicationEntityContract(entityType: KnownReplicationEntityType): ReplicationEntityContract {
  return CONTRACTS[entityType] ?? { entityType, fields: [] }
}

const CREDENTIAL_KEY = /^(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|passwd|authorization|cookie|secret|private[-_]?key)$/i
const CREDENTIAL_TEXT = /\b(?:bearer\s+[a-z0-9._~+\/-]+=*|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/gi

function redactCredentialText(value: string): string {
  return value.replace(CREDENTIAL_TEXT, '[REDACTED]')
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

  if (input.policy.mode === 'metadata-only' && input.fieldClass !== 'metadata') {
    return { state: 'omitted', reason: 'policy' }
  }
  if (input.fieldClass === 'raw-content') {
    return input.policy.mode === 'full'
      ? { state: 'value', value: sanitizeReplicationValue(input.value) }
      : { state: 'omitted', reason: 'policy' }
  }
  if (input.policy.mode === 'redacted' && (input.fieldClass === 'content' || input.fieldClass === 'path')) {
    return { state: 'value', value: sanitizeReplicationValue(input.value) }
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
