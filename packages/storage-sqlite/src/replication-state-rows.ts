import type { JsonValue } from '@agent-lens/core'
import {
  KNOWN_REPLICATION_ENTITY_TYPES,
  type FrozenReplicationBatch,
  type KnownReplicationEntityType,
  type PendingReplicationEntity,
  type ReplicationHistoryPhase,
  type ReplicationReconciliationCursor,
  type ReplicationStreamState,
  type ReplicationStreamStatus,
} from '@agent-lens/core/replication'

export interface StreamRow extends ReplicationStreamState {}

export interface PendingRow {
  id: string
  streamId: string
  generationId: string
  dedupKey: string
  entityType: KnownReplicationEntityType
  originEntityId: string
  candidateHash: string
  phase: ReplicationHistoryPhase
  policyRevision: string
  historyRevision: string
  payloadJson: string
  frozenSequence: number | null
  createdAt: string
  updatedAt: string
}

export interface FrozenBatchRow {
  streamId: string
  generationId: string
  sequence: number
  batchId: string
  contentHash: string
  phase: ReplicationHistoryPhase
  policyRevision: string
  historyRevision: string
  payloadJson: string
  status: FrozenReplicationBatch['status']
  frozenAt: string
  ackedAt: string | null
}

type Row = Record<string, unknown>
const STREAM_STATUS = ['active', 'paused', 'rollover-required'] as const
const HISTORY_PHASE = ['bootstrap', 'incremental', 'reconcile'] as const
const BATCH_STATUS = ['frozen', 'acked'] as const

function rowRecord(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Replication SQLite query returned a non-object row')
  }
  return value as Row
}

function requiredString(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`Replication SQLite field ${key} must be a string`)
  return value
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key]
  if (value == null) return null
  if (typeof value !== 'string') throw new TypeError(`Replication SQLite field ${key} must be a string or null`)
  return value
}

function requiredNumber(row: Row, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Replication SQLite field ${key} must be a finite number`)
  }
  return value
}

function nullableNumber(row: Row, key: string): number | null {
  const value = row[key]
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Replication SQLite field ${key} must be a finite number or null`)
  }
  return value
}

function enumString<const T extends readonly string[]>(row: Row, key: string, allowed: T): T[number] {
  const value = requiredString(row, key)
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`Replication SQLite field ${key} has unsupported value: ${value}`)
  }
  return value as T[number]
}

function entityType(row: Row, key: string): KnownReplicationEntityType {
  return enumString(row, key, KNOWN_REPLICATION_ENTITY_TYPES)
}

function jsonValue(value: unknown, key: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(item => jsonValue(item, key))
  if (typeof value === 'object') {
    const output: { [key: string]: JsonValue } = {}
    for (const [entryKey, entryValue] of Object.entries(value)) output[entryKey] = jsonValue(entryValue, key)
    return output
  }
  throw new TypeError(`Replication SQLite field ${key} must contain JSON data`)
}

export function parseReplicationJson(value: unknown, key = 'payloadJson'): JsonValue {
  if (typeof value !== 'string') throw new TypeError(`Replication SQLite field ${key} must contain JSON text`)
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new TypeError(`Replication SQLite field ${key} contains invalid JSON`)
  }
  return jsonValue(parsed, key)
}

export function streamRow(value: unknown): StreamRow {
  const row = rowRecord(value)
  return {
    relationshipId: requiredString(row, 'relationshipId'),
    hubId: requiredString(row, 'hubId'),
    streamId: requiredString(row, 'streamId'),
    generationId: requiredString(row, 'generationId'),
    status: enumString(row, 'status', STREAM_STATUS) as ReplicationStreamStatus,
    nextSequence: requiredNumber(row, 'nextSequence'),
    ackSequence: requiredNumber(row, 'ackSequence'),
    policyRevision: requiredString(row, 'policyRevision'),
    historyRevision: requiredString(row, 'historyRevision'),
    createdAt: requiredString(row, 'createdAt'),
    updatedAt: requiredString(row, 'updatedAt'),
  }
}

export function pendingRow(value: unknown): PendingRow {
  const row = rowRecord(value)
  return {
    id: requiredString(row, 'id'),
    streamId: requiredString(row, 'streamId'),
    generationId: requiredString(row, 'generationId'),
    dedupKey: requiredString(row, 'dedupKey'),
    entityType: entityType(row, 'entityType'),
    originEntityId: requiredString(row, 'originEntityId'),
    candidateHash: requiredString(row, 'candidateHash'),
    phase: enumString(row, 'phase', HISTORY_PHASE) as ReplicationHistoryPhase,
    policyRevision: requiredString(row, 'policyRevision'),
    historyRevision: requiredString(row, 'historyRevision'),
    payloadJson: requiredString(row, 'payloadJson'),
    frozenSequence: nullableNumber(row, 'frozenSequence'),
    createdAt: requiredString(row, 'createdAt'),
    updatedAt: requiredString(row, 'updatedAt'),
  }
}

export function frozenBatchRow(value: unknown): FrozenBatchRow {
  const row = rowRecord(value)
  return {
    streamId: requiredString(row, 'streamId'),
    generationId: requiredString(row, 'generationId'),
    sequence: requiredNumber(row, 'sequence'),
    batchId: requiredString(row, 'batchId'),
    contentHash: requiredString(row, 'contentHash'),
    phase: enumString(row, 'phase', HISTORY_PHASE) as ReplicationHistoryPhase,
    policyRevision: requiredString(row, 'policyRevision'),
    historyRevision: requiredString(row, 'historyRevision'),
    payloadJson: requiredString(row, 'payloadJson'),
    status: enumString(row, 'status', BATCH_STATUS),
    frozenAt: requiredString(row, 'frozenAt'),
    ackedAt: nullableString(row, 'ackedAt'),
  }
}

export function candidateStateRow(value: unknown): { lastCandidateHash: string; lastPendingId: string | null } {
  const row = rowRecord(value)
  return {
    lastCandidateHash: requiredString(row, 'lastCandidateHash'),
    lastPendingId: nullableString(row, 'lastPendingId'),
  }
}

export function pendingBindingRow(value: unknown): {
  id: string
  streamId: string
  generationId: string
  frozenSequence: number | null
} {
  const row = rowRecord(value)
  return {
    id: requiredString(row, 'id'),
    streamId: requiredString(row, 'streamId'),
    generationId: requiredString(row, 'generationId'),
    frozenSequence: nullableNumber(row, 'frozenSequence'),
  }
}

export function reconciliationCursorRow(value: unknown): ReplicationReconciliationCursor {
  const row = rowRecord(value)
  return {
    streamId: requiredString(row, 'streamId'),
    entityType: entityType(row, 'entityType'),
    cursor: requiredString(row, 'cursor'),
    updatedAt: requiredString(row, 'updatedAt'),
  }
}

export function pendingIdRow(value: unknown): string {
  return requiredString(rowRecord(value), 'pendingId')
}

export function mapPendingReplication(row: PendingRow): PendingReplicationEntity {
  return {
    id: row.id,
    streamId: row.streamId,
    generationId: row.generationId,
    dedupKey: row.dedupKey,
    entityType: row.entityType,
    originEntityId: row.originEntityId,
    candidateHash: row.candidateHash,
    phase: row.phase,
    policyRevision: row.policyRevision,
    historyRevision: row.historyRevision,
    payload: parseReplicationJson(row.payloadJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.frozenSequence === null ? {} : { frozenSequence: row.frozenSequence }),
  }
}
