import type { JsonValue, WireEntityEnvelope } from '@agent-lens/protocol/replication'
import type { KnownReplicationEntityType } from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'

export type SqliteHubReplicaGenerationStatus = 'staged' | 'active' | 'retired'
export type SqliteHubReplicationStreamStatus = 'active' | 'paused' | 'revoked'

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
  scope: WireEntityEnvelope['scope']
  entityVersion: number
  contentHash: string
  body: JsonValue
  references?: WireEntityEnvelope['references']
  sharedIdentity?: WireEntityEnvelope['sharedIdentity']
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

interface GenerationRow {
  originNodeId: string
  generationId: string
  status: SqliteHubReplicaGenerationStatus
  createdAt: string
  activatedAt: string | null
  retiredAt: string | null
}

interface StreamRow {
  streamId: string
  originNodeId: string
  status: SqliteHubReplicationStreamStatus
  ackSequence: number
  createdAt: string
  updatedAt: string
}

interface BatchRow {
  streamId: string
  sequence: number
  originNodeId: string
  generationId: string
  batchId: string
  contentHash: string
  committedAt: string
}

function mapGeneration(row: GenerationRow): SqliteHubReplicaGenerationRecord {
  return {
    originNodeId: row.originNodeId,
    generationId: row.generationId,
    status: row.status,
    createdAt: row.createdAt,
    ...(row.activatedAt ? { activatedAt: row.activatedAt } : {}),
    ...(row.retiredAt ? { retiredAt: row.retiredAt } : {}),
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value)
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
      `).get(streamId) as StreamRow | undefined
      return row
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
      `).run(
        record.streamId,
        record.originNodeId,
        record.status,
        record.ackSequence,
        record.createdAt,
        record.updatedAt,
      )
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
      `).get(originNodeId, generationId) as GenerationRow | undefined
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
      `).get(streamId, sequence) as BatchRow | undefined
      return row
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
      `).get(input.originNodeId, input.generationId, input.entityType, input.originEntityId) as any
      if (!row) return undefined
      return {
        originNodeId: row.originNodeId,
        generationId: row.generationId,
        entityType: row.entityType,
        originEntityId: row.originEntityId,
        replicaKey: row.replicaKey,
        scope: row.scope,
        entityVersion: Number(row.entityVersion),
        contentHash: row.contentHash,
        body: JSON.parse(row.bodyJson) as JsonValue,
        ...(row.referencesJson ? { references: JSON.parse(row.referencesJson) } : {}),
        ...(row.sharedIdentityJson ? { sharedIdentity: JSON.parse(row.sharedIdentityJson) } : {}),
        updatedSequence: Number(row.updatedSequence),
        updatedAt: row.updatedAt,
      }
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
