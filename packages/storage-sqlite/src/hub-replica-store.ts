import type { JsonValue } from '@agent-lens/core'
import {
  KNOWN_REPLICATION_ENTITY_TYPES,
  type KnownReplicationEntityType,
} from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'

export type SqliteHubReplicaGenerationStatus = 'staged' | 'active' | 'retired'
export type SqliteHubReplicationStreamStatus = 'active' | 'paused' | 'revoked'
export type SqliteHubRemoteScope = 'node' | 'shared'

export interface SqliteHubReplicaGenerationRecord {
  originNodeId: string
  generationId: string
  status: SqliteHubReplicaGenerationStatus
  createdAt: string
  activatedAt?: string
  retiredAt?: string
}

export interface SqliteHubReplicationStreamRecord {
  streamId: string
  originNodeId: string
  status: SqliteHubReplicationStreamStatus
  ackSequence: number
  createdAt: string
  updatedAt: string
}

export interface SqliteHubCommittedBatchRecord {
  streamId: string
  sequence: number
  originNodeId: string
  generationId: string
  batchId: string
  contentHash: string
  committedAt: string
}

export interface SqliteHubRemoteReplicaEntityRecord {
  originNodeId: string
  generationId: string
  entityType: KnownReplicationEntityType
  originEntityId: string
  replicaKey: string
  scope: SqliteHubRemoteScope
  entityVersion: number
  contentHash: string
  body: JsonValue
  references?: unknown
  sharedIdentity?: unknown
  updatedSequence: number
  updatedAt: string
}

export interface SqliteHubRemoteSharedIdentityRecord {
  originNodeId: string
  generationId: string
  entityType: KnownReplicationEntityType
  originEntityId: string
  stateKind: 'shared-root' | 'conditional-membership'
  identityAlgorithm: string
  normalizedIdentity?: string
  sharedKey: string
  updatedSequence: number
  updatedAt: string
}

type HubRow = Record<string, unknown>
const GENERATION_STATUSES = ['staged', 'active', 'retired'] as const
const STREAM_STATUSES = ['active', 'paused', 'revoked'] as const
const REMOTE_SCOPES = ['node', 'shared'] as const

function rowRecord(value: unknown): HubRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Hub replica SQLite query returned a non-object row')
  }
  return value as HubRow
}

function requiredString(row: HubRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`Hub replica SQLite field ${key} must be a string`)
  return value
}

function optionalString(row: HubRow, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`Hub replica SQLite field ${key} must be a string or null`)
  return value
}

function requiredNumber(row: HubRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Hub replica SQLite field ${key} must be a finite number`)
  }
  return value
}

function enumString<const T extends readonly string[]>(row: HubRow, key: string, allowed: T): T[number] {
  const value = requiredString(row, key)
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`Hub replica SQLite field ${key} has unsupported value: ${value}`)
  }
  return value as T[number]
}

function entityType(row: HubRow): KnownReplicationEntityType {
  return enumString(row, 'entityType', KNOWN_REPLICATION_ENTITY_TYPES)
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
  throw new TypeError(`Hub replica SQLite field ${key} must contain JSON data`)
}

function parseJson(value: unknown, key: string): JsonValue {
  if (typeof value !== 'string') throw new TypeError(`Hub replica SQLite field ${key} must contain JSON text`)
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new TypeError(`Hub replica SQLite field ${key} contains invalid JSON`)
  }
  return jsonValue(parsed, key)
}

function mapGeneration(value: unknown): SqliteHubReplicaGenerationRecord {
  const row = rowRecord(value)
  const activatedAt = optionalString(row, 'activatedAt')
  const retiredAt = optionalString(row, 'retiredAt')
  return {
    originNodeId: requiredString(row, 'originNodeId'),
    generationId: requiredString(row, 'generationId'),
    status: enumString(row, 'status', GENERATION_STATUSES),
    createdAt: requiredString(row, 'createdAt'),
    ...(activatedAt === undefined ? {} : { activatedAt }),
    ...(retiredAt === undefined ? {} : { retiredAt }),
  }
}

function mapStream(value: unknown): SqliteHubReplicationStreamRecord {
  const row = rowRecord(value)
  return {
    streamId: requiredString(row, 'streamId'),
    originNodeId: requiredString(row, 'originNodeId'),
    status: enumString(row, 'status', STREAM_STATUSES),
    ackSequence: requiredNumber(row, 'ackSequence'),
    createdAt: requiredString(row, 'createdAt'),
    updatedAt: requiredString(row, 'updatedAt'),
  }
}

function mapBatch(value: unknown): SqliteHubCommittedBatchRecord {
  const row = rowRecord(value)
  return {
    streamId: requiredString(row, 'streamId'),
    sequence: requiredNumber(row, 'sequence'),
    originNodeId: requiredString(row, 'originNodeId'),
    generationId: requiredString(row, 'generationId'),
    batchId: requiredString(row, 'batchId'),
    contentHash: requiredString(row, 'contentHash'),
    committedAt: requiredString(row, 'committedAt'),
  }
}

function mapEntity(value: unknown): SqliteHubRemoteReplicaEntityRecord {
  const row = rowRecord(value)
  const referencesJson = optionalString(row, 'referencesJson')
  const sharedIdentityJson = optionalString(row, 'sharedIdentityJson')
  return {
    originNodeId: requiredString(row, 'originNodeId'),
    generationId: requiredString(row, 'generationId'),
    entityType: entityType(row),
    originEntityId: requiredString(row, 'originEntityId'),
    replicaKey: requiredString(row, 'replicaKey'),
    scope: enumString(row, 'scope', REMOTE_SCOPES),
    entityVersion: requiredNumber(row, 'entityVersion'),
    contentHash: requiredString(row, 'contentHash'),
    body: parseJson(row.bodyJson, 'bodyJson'),
    ...(referencesJson === undefined ? {} : { references: parseJson(referencesJson, 'referencesJson') }),
    ...(sharedIdentityJson === undefined ? {} : { sharedIdentity: parseJson(sharedIdentityJson, 'sharedIdentityJson') }),
    updatedSequence: requiredNumber(row, 'updatedSequence'),
    updatedAt: requiredString(row, 'updatedAt'),
  }
}

function stringify(value: unknown): string {
  const result = JSON.stringify(value)
  if (result === undefined) throw new TypeError('Hub replica persistence requires JSON-serializable values')
  return result
}

/**
 * Durable Hub-side store for remote replica state.
 * It deliberately persists Wire availability/body instead of casting remote data into Local Canonical rows.
 */
export class SqliteHubReplicaStore {
  constructor(private readonly executor: SqliteExecutor) {}

  transaction<T>(operation: (tx: SqliteHubReplicaStore) => Promise<T>): Promise<T> {
    return this.executor.transaction(() => operation(this))
  }

  async getStream(streamId: string): Promise<SqliteHubReplicationStreamRecord | undefined> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT stream_id AS streamId,
               origin_node_id AS originNodeId,
               status,
               ack_sequence AS ackSequence,
               created_at AS createdAt,
               updated_at AS updatedAt
        FROM hub_replication_streams
        WHERE stream_id = ?
      `).get(streamId)
      return row ? mapStream(row) : undefined
    })
  }

  async putStream(record: SqliteHubReplicationStreamRecord): Promise<void> {
    await this.executor.run(() => {
      this.executor.db.prepare(`
        INSERT INTO hub_replication_streams(
          stream_id, origin_node_id, status, ack_sequence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(stream_id) DO UPDATE SET
          status = excluded.status,
          ack_sequence = excluded.ack_sequence,
          updated_at = excluded.updated_at
      `).run(record.streamId, record.originNodeId, record.status, record.ackSequence, record.createdAt, record.updatedAt)
    })
  }

  async getGeneration(originNodeId: string, generationId: string): Promise<SqliteHubReplicaGenerationRecord | undefined> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT origin_node_id AS originNodeId,
               generation_id AS generationId,
               status,
               created_at AS createdAt,
               activated_at AS activatedAt,
               retired_at AS retiredAt
        FROM hub_replica_generations
        WHERE origin_node_id = ? AND generation_id = ?
      `).get(originNodeId, generationId)
      return row ? mapGeneration(row) : undefined
    })
  }

  async putGeneration(record: SqliteHubReplicaGenerationRecord): Promise<void> {
    await this.executor.run(() => {
      this.executor.db.prepare(`
        INSERT INTO hub_replica_generations(
          origin_node_id, generation_id, status, created_at, activated_at, retired_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(origin_node_id, generation_id) DO UPDATE SET
          status = excluded.status,
          activated_at = excluded.activated_at,
          retired_at = excluded.retired_at
      `).run(
        record.originNodeId,
        record.generationId,
        record.status,
        record.createdAt,
        record.activatedAt ?? null,
        record.retiredAt ?? null,
      )
    })
  }

  async getCommittedBatch(streamId: string, sequence: number): Promise<SqliteHubCommittedBatchRecord | undefined> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT stream_id AS streamId,
               sequence,
               origin_node_id AS originNodeId,
               generation_id AS generationId,
               batch_id AS batchId,
               content_hash AS contentHash,
               committed_at AS committedAt
        FROM hub_committed_batches
        WHERE stream_id = ? AND sequence = ?
      `).get(streamId, sequence)
      return row ? mapBatch(row) : undefined
    })
  }

  async putCommittedBatch(record: SqliteHubCommittedBatchRecord): Promise<void> {
    await this.executor.run(() => {
      this.executor.db.prepare(`
        INSERT INTO hub_committed_batches(
          stream_id, sequence, origin_node_id, generation_id, batch_id, content_hash, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.streamId,
        record.sequence,
        record.originNodeId,
        record.generationId,
        record.batchId,
        record.contentHash,
        record.committedAt,
      )
    })
  }

  async putEntity(record: SqliteHubRemoteReplicaEntityRecord): Promise<void> {
    await this.executor.run(() => {
      this.executor.db.prepare(`
        INSERT INTO hub_remote_replica_entities(
          origin_node_id, generation_id, entity_type, origin_entity_id, replica_key,
          scope, entity_version, content_hash, body_json, references_json,
          shared_identity_json, updated_sequence, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(origin_node_id, generation_id, entity_type, origin_entity_id) DO UPDATE SET
          replica_key = excluded.replica_key,
          scope = excluded.scope,
          entity_version = excluded.entity_version,
          content_hash = excluded.content_hash,
          body_json = excluded.body_json,
          references_json = excluded.references_json,
          shared_identity_json = excluded.shared_identity_json,
          updated_sequence = excluded.updated_sequence,
          updated_at = excluded.updated_at
      `).run(
        record.originNodeId,
        record.generationId,
        record.entityType,
        record.originEntityId,
        record.replicaKey,
        record.scope,
        record.entityVersion,
        record.contentHash,
        stringify(record.body),
        record.references === undefined ? null : stringify(record.references),
        record.sharedIdentity === undefined ? null : stringify(record.sharedIdentity),
        record.updatedSequence,
        record.updatedAt,
      )
    })
  }

  async hasEntity(input: {
    originNodeId: string
    generationId: string
    entityType: string
    originEntityId: string
  }): Promise<boolean> {
    return this.executor.run(() => Boolean(this.executor.db.prepare(`
      SELECT 1 AS ok
      FROM hub_remote_replica_entities
      WHERE origin_node_id = ? AND generation_id = ? AND entity_type = ? AND origin_entity_id = ?
      LIMIT 1
    `).get(input.originNodeId, input.generationId, input.entityType, input.originEntityId)))
  }

  async getEntity(input: {
    originNodeId: string
    generationId: string
    entityType: string
    originEntityId: string
  }): Promise<SqliteHubRemoteReplicaEntityRecord | undefined> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT origin_node_id AS originNodeId,
               generation_id AS generationId,
               entity_type AS entityType,
               origin_entity_id AS originEntityId,
               replica_key AS replicaKey,
               scope,
               entity_version AS entityVersion,
               content_hash AS contentHash,
               body_json AS bodyJson,
               references_json AS referencesJson,
               shared_identity_json AS sharedIdentityJson,
               updated_sequence AS updatedSequence,
               updated_at AS updatedAt
        FROM hub_remote_replica_entities
        WHERE origin_node_id = ? AND generation_id = ? AND entity_type = ? AND origin_entity_id = ?
      `).get(input.originNodeId, input.generationId, input.entityType, input.originEntityId)
      return row ? mapEntity(row) : undefined
    })
  }

  async putSharedIdentity(record: SqliteHubRemoteSharedIdentityRecord): Promise<void> {
    await this.executor.run(() => {
      this.executor.db.prepare(`
        INSERT INTO hub_remote_shared_identity_state(
          origin_node_id, generation_id, entity_type, origin_entity_id, state_kind,
          identity_algorithm, normalized_identity, shared_key, updated_sequence, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(origin_node_id, generation_id, entity_type, origin_entity_id, state_kind) DO UPDATE SET
          identity_algorithm = excluded.identity_algorithm,
          normalized_identity = excluded.normalized_identity,
          shared_key = excluded.shared_key,
          updated_sequence = excluded.updated_sequence,
          updated_at = excluded.updated_at
      `).run(
        record.originNodeId,
        record.generationId,
        record.entityType,
        record.originEntityId,
        record.stateKind,
        record.identityAlgorithm,
        record.normalizedIdentity ?? null,
        record.sharedKey,
        record.updatedSequence,
        record.updatedAt,
      )
    })
  }

  async hasSharedIdentityKey(input: {
    originNodeId: string
    generationId: string
    entityType: string
    sharedKey: string
  }): Promise<boolean> {
    return this.executor.run(() => Boolean(this.executor.db.prepare(`
      SELECT 1 AS ok
      FROM hub_remote_shared_identity_state
      WHERE origin_node_id = ? AND generation_id = ? AND entity_type = ? AND shared_key = ?
      LIMIT 1
    `).get(input.originNodeId, input.generationId, input.entityType, input.sharedKey)))
  }

  async setStreamAck(streamId: string, ackSequence: number, updatedAt: string): Promise<void> {
    await this.executor.run(() => {
      const result = this.executor.db.prepare(`
        UPDATE hub_replication_streams
        SET ack_sequence = ?, updated_at = ?
        WHERE stream_id = ?
      `).run(ackSequence, updatedAt, streamId)
      if (result.changes !== 1) throw new Error(`Unknown Hub replication stream: ${streamId}`)
    })
  }

  async activateGeneration(originNodeId: string, generationId: string, activatedAt: string): Promise<void> {
    await this.executor.run(() => {
      this.executor.db.prepare(`
        UPDATE hub_replica_generations
        SET status = 'retired', retired_at = ?
        WHERE origin_node_id = ? AND status = 'active' AND generation_id <> ?
      `).run(activatedAt, originNodeId, generationId)
      const result = this.executor.db.prepare(`
        UPDATE hub_replica_generations
        SET status = 'active', activated_at = ?, retired_at = NULL
        WHERE origin_node_id = ? AND generation_id = ? AND status <> 'retired'
      `).run(activatedAt, originNodeId, generationId)
      if (result.changes !== 1) throw new Error(`Replica generation cannot be activated: ${originNodeId}/${generationId}`)
    })
  }
}
