import type { JsonValue } from '@agent-lens/core'
import {
  DurableReplicationError,
  assertAckAdvance,
  assertFreezeSequence,
  assertReplicationStreamState,
  type FrozenReplicationBatch,
  type KnownReplicationEntityType,
  type PendingReplicationEntity,
  type ReplicationHistoryPhase,
  type ReplicationReconciliationCursor,
  type ReplicationStreamState,
  type ReplicationStreamStatus,
} from '@agent-lens/core/replication'
import { SqliteExecutor } from './executor'

function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue
}

function stringifyJson(value: JsonValue): string {
  return JSON.stringify(value)
}

interface StreamRow {
  relationshipId: string
  hubId: string
  streamId: string
  generationId: string
  status: ReplicationStreamStatus
  nextSequence: number
  ackSequence: number
  policyRevision: string
  historyRevision: string
  createdAt: string
  updatedAt: string
}

interface PendingRow {
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

interface FrozenBatchRow {
  streamId: string
  generationId: string
  sequence: number
  batchId: string
  contentHash: string
  phase: ReplicationHistoryPhase
  policyRevision: string
  historyRevision: string
  payloadJson: string
  status: 'frozen' | 'acked'
  frozenAt: string
  ackedAt: string | null
}

function mapStream(row: StreamRow): ReplicationStreamState {
  return { ...row }
}

function mapPending(row: PendingRow): PendingReplicationEntity {
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
    payload: parseJson(row.payloadJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.frozenSequence === null ? {} : { frozenSequence: row.frozenSequence }),
  }
}

export interface EnsureReplicationStreamInput {
  relationshipId: string
  hubId: string
  streamId: string
  generationId: string
  policyRevision: string
  historyRevision: string
  status?: ReplicationStreamStatus
  now?: string
}

export interface EnqueueReplicationEntityInput {
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
  payload: JsonValue
  now?: string
}

export interface EnqueueReplicationEntityResult {
  item: PendingReplicationEntity
  created: boolean
  replaced: boolean
}

export interface FreezeReplicationBatchInput {
  streamId: string
  generationId: string
  sequence: number
  batchId: string
  contentHash: string
  phase: ReplicationHistoryPhase
  policyRevision: string
  historyRevision: string
  payload: JsonValue
  pendingItemIds: readonly string[]
  now?: string
}

export class SqliteReplicationStateRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async ensureStream(input: EnsureReplicationStreamInput): Promise<ReplicationStreamState> {
    return this.executor.transaction(async () => {
      const existing = this.getStreamRow(input.streamId)
      if (existing) {
        if (
          existing.relationshipId !== input.relationshipId
          || existing.hubId !== input.hubId
          || existing.generationId !== input.generationId
        ) {
          throw new DurableReplicationError('STREAM_INVALID', 'Existing stream identity cannot be rebound in place')
        }
        return mapStream(existing)
      }

      const now = input.now ?? new Date().toISOString()
      const state: ReplicationStreamState = {
        relationshipId: input.relationshipId,
        hubId: input.hubId,
        streamId: input.streamId,
        generationId: input.generationId,
        status: input.status ?? 'active',
        nextSequence: 1,
        ackSequence: 0,
        policyRevision: input.policyRevision,
        historyRevision: input.historyRevision,
        createdAt: now,
        updatedAt: now,
      }
      assertReplicationStreamState(state)
      this.executor.db.prepare(`
        INSERT INTO replication_streams(
          stream_id, relationship_id, hub_id, generation_id, status,
          next_sequence, ack_sequence, policy_revision, history_revision,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        state.streamId,
        state.relationshipId,
        state.hubId,
        state.generationId,
        state.status,
        state.nextSequence,
        state.ackSequence,
        state.policyRevision,
        state.historyRevision,
        state.createdAt,
        state.updatedAt,
      )
      return state
    })
  }

  async getStream(streamId: string): Promise<ReplicationStreamState | undefined> {
    return this.executor.run(() => {
      const row = this.getStreamRow(streamId)
      return row ? mapStream(row) : undefined
    })
  }

  async setStreamPolicyState(input: {
    streamId: string
    status: ReplicationStreamStatus
    policyRevision: string
    historyRevision: string
    now?: string
  }): Promise<ReplicationStreamState> {
    return this.executor.transaction(async () => {
      const existing = this.requireStreamRow(input.streamId)
      const now = input.now ?? new Date().toISOString()
      this.executor.db.prepare(`
        UPDATE replication_streams
        SET status = ?, policy_revision = ?, history_revision = ?, updated_at = ?
        WHERE stream_id = ?
      `).run(input.status, input.policyRevision, input.historyRevision, now, input.streamId)
      return mapStream({
        ...existing,
        status: input.status,
        policyRevision: input.policyRevision,
        historyRevision: input.historyRevision,
        updatedAt: now,
      })
    })
  }

  async enqueuePending(input: EnqueueReplicationEntityInput): Promise<EnqueueReplicationEntityResult> {
    return this.executor.transaction(async () => {
      const stream = this.requireStreamRow(input.streamId)
      if (stream.generationId !== input.generationId) {
        throw new DurableReplicationError('PENDING_ITEM_INVALID', 'Pending item generation does not match stream')
      }

      const state = this.executor.db.prepare(`
        SELECT last_candidate_hash AS lastCandidateHash,
               last_pending_id AS lastPendingId
        FROM replication_entity_state
        WHERE stream_id = ? AND generation_id = ? AND dedup_key = ?
      `).get(input.streamId, input.generationId, input.dedupKey) as
        | { lastCandidateHash: string; lastPendingId: string | null }
        | undefined

      if (state?.lastCandidateHash === input.candidateHash && state.lastPendingId) {
        const existing = this.getPendingRow(state.lastPendingId)
        if (existing) return { item: mapPending(existing), created: false, replaced: false }
      }

      const open = this.executor.db.prepare(`
        SELECT id,
               stream_id AS streamId,
               generation_id AS generationId,
               dedup_key AS dedupKey,
               entity_type AS entityType,
               origin_entity_id AS originEntityId,
               candidate_hash AS candidateHash,
               phase,
               policy_revision AS policyRevision,
               history_revision AS historyRevision,
               payload_json AS payloadJson,
               frozen_sequence AS frozenSequence,
               created_at AS createdAt,
               updated_at AS updatedAt
        FROM replication_pending_entities
        WHERE stream_id = ? AND generation_id = ? AND dedup_key = ? AND frozen_sequence IS NULL
      `).get(input.streamId, input.generationId, input.dedupKey) as PendingRow | undefined

      const now = input.now ?? new Date().toISOString()
      let itemId = input.id
      let createdAt = now
      let created = true
      let replaced = false

      if (open) {
        itemId = open.id
        createdAt = open.createdAt
        created = false
        replaced = open.candidateHash !== input.candidateHash
        this.executor.db.prepare(`
          UPDATE replication_pending_entities
          SET entity_type = ?, origin_entity_id = ?, candidate_hash = ?, phase = ?,
              policy_revision = ?, history_revision = ?, payload_json = ?, updated_at = ?
          WHERE id = ?
        `).run(
          input.entityType,
          input.originEntityId,
          input.candidateHash,
          input.phase,
          input.policyRevision,
          input.historyRevision,
          stringifyJson(input.payload),
          now,
          itemId,
        )
      } else {
        this.executor.db.prepare(`
          INSERT INTO replication_pending_entities(
            id, stream_id, generation_id, dedup_key, entity_type, origin_entity_id,
            candidate_hash, phase, policy_revision, history_revision, payload_json,
            frozen_sequence, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `).run(
          itemId,
          input.streamId,
          input.generationId,
          input.dedupKey,
          input.entityType,
          input.originEntityId,
          input.candidateHash,
          input.phase,
          input.policyRevision,
          input.historyRevision,
          stringifyJson(input.payload),
          createdAt,
          now,
        )
      }

      this.executor.db.prepare(`
        INSERT INTO replication_entity_state(
          stream_id, generation_id, dedup_key, last_candidate_hash, last_pending_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(stream_id, generation_id, dedup_key) DO UPDATE SET
          last_candidate_hash = excluded.last_candidate_hash,
          last_pending_id = excluded.last_pending_id,
          updated_at = excluded.updated_at
      `).run(input.streamId, input.generationId, input.dedupKey, input.candidateHash, itemId, now)

      return {
        item: {
          id: itemId,
          streamId: input.streamId,
          generationId: input.generationId,
          dedupKey: input.dedupKey,
          entityType: input.entityType,
          originEntityId: input.originEntityId,
          candidateHash: input.candidateHash,
          phase: input.phase,
          policyRevision: input.policyRevision,
          historyRevision: input.historyRevision,
          payload: input.payload,
          createdAt,
          updatedAt: now,
        },
        created,
        replaced,
      }
    })
  }

  async listPending(streamId: string, limit = 100): Promise<readonly PendingReplicationEntity[]> {
    return this.executor.run(() => {
      const rows = this.executor.db.prepare(`
        SELECT id,
               stream_id AS streamId,
               generation_id AS generationId,
               dedup_key AS dedupKey,
               entity_type AS entityType,
               origin_entity_id AS originEntityId,
               candidate_hash AS candidateHash,
               phase,
               policy_revision AS policyRevision,
               history_revision AS historyRevision,
               payload_json AS payloadJson,
               frozen_sequence AS frozenSequence,
               created_at AS createdAt,
               updated_at AS updatedAt
        FROM replication_pending_entities
        WHERE stream_id = ? AND frozen_sequence IS NULL
        ORDER BY created_at, id
        LIMIT ?
      `).all(streamId, limit) as PendingRow[]
      return rows.map(mapPending)
    })
  }

  async freezeBatch(input: FreezeReplicationBatchInput): Promise<FrozenReplicationBatch> {
    return this.executor.transaction(async () => {
      const streamRow = this.requireStreamRow(input.streamId)
      if (streamRow.generationId !== input.generationId) {
        throw new DurableReplicationError('STREAM_INVALID', 'Batch generation does not match active stream')
      }

      const existing = this.getFrozenBatchRow(input.streamId, input.sequence)
      const decision = assertFreezeSequence({
        stream: mapStream(streamRow),
        incomingSequence: input.sequence,
        incomingContentHash: input.contentHash,
        ...(existing ? { existingBatch: { sequence: existing.sequence, contentHash: existing.contentHash } } : {}),
      })
      if (decision === 'exact-retry' && existing) return this.mapFrozenBatch(existing)

      if (input.pendingItemIds.length === 0) {
        throw new DurableReplicationError('PENDING_ITEM_INVALID', 'Cannot freeze an empty batch')
      }
      const placeholders = input.pendingItemIds.map(() => '?').join(', ')
      const rows = this.executor.db.prepare(`
        SELECT id, stream_id AS streamId, generation_id AS generationId, frozen_sequence AS frozenSequence
        FROM replication_pending_entities
        WHERE id IN (${placeholders})
      `).all(...input.pendingItemIds) as Array<{
        id: string
        streamId: string
        generationId: string
        frozenSequence: number | null
      }>
      if (rows.length !== input.pendingItemIds.length || rows.some(row =>
        row.streamId !== input.streamId
        || row.generationId !== input.generationId
        || row.frozenSequence !== null
      )) {
        throw new DurableReplicationError('PENDING_ITEM_INVALID', 'Batch contains missing, foreign, or already frozen pending items')
      }

      const now = input.now ?? new Date().toISOString()
      this.executor.db.prepare(`
        INSERT INTO replication_frozen_batches(
          stream_id, sequence, generation_id, batch_id, content_hash, phase,
          policy_revision, history_revision, payload_json, status, frozen_at, acked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'frozen', ?, NULL)
      `).run(
        input.streamId,
        input.sequence,
        input.generationId,
        input.batchId,
        input.contentHash,
        input.phase,
        input.policyRevision,
        input.historyRevision,
        stringifyJson(input.payload),
        now,
      )
      const bindItem = this.executor.db.prepare(`
        INSERT INTO replication_batch_items(stream_id, sequence, pending_id) VALUES (?, ?, ?)
      `)
      const freezeItem = this.executor.db.prepare(`
        UPDATE replication_pending_entities SET frozen_sequence = ?, updated_at = ? WHERE id = ?
      `)
      for (const pendingId of input.pendingItemIds) {
        bindItem.run(input.streamId, input.sequence, pendingId)
        freezeItem.run(input.sequence, now, pendingId)
      }
      this.executor.db.prepare(`
        UPDATE replication_streams SET next_sequence = next_sequence + 1, updated_at = ? WHERE stream_id = ?
      `).run(now, input.streamId)

      return {
        streamId: input.streamId,
        generationId: input.generationId,
        sequence: input.sequence,
        batchId: input.batchId,
        contentHash: input.contentHash,
        phase: input.phase,
        policyRevision: input.policyRevision,
        historyRevision: input.historyRevision,
        payload: input.payload,
        status: 'frozen',
        frozenAt: now,
        pendingItemIds: [...input.pendingItemIds],
      }
    })
  }

  async getFrozenBatch(streamId: string, sequence: number): Promise<FrozenReplicationBatch | undefined> {
    return this.executor.run(() => {
      const row = this.getFrozenBatchRow(streamId, sequence)
      return row ? this.mapFrozenBatch(row) : undefined
    })
  }

  async acknowledge(streamId: string, sequence: number, now = new Date().toISOString()): Promise<ReplicationStreamState> {
    return this.executor.transaction(async () => {
      const streamRow = this.requireStreamRow(streamId)
      const decision = assertAckAdvance({ stream: mapStream(streamRow), sequence })
      if (decision === 'already-acked') return mapStream(streamRow)

      const batch = this.getFrozenBatchRow(streamId, sequence)
      if (!batch) throw new DurableReplicationError('SEQUENCE_GAP', 'Cannot ACK a batch that is not frozen locally')

      this.executor.db.prepare(`
        UPDATE replication_frozen_batches SET status = 'acked', acked_at = ?
        WHERE stream_id = ? AND sequence = ?
      `).run(now, streamId, sequence)
      this.executor.db.prepare(`
        UPDATE replication_streams SET ack_sequence = ?, updated_at = ? WHERE stream_id = ?
      `).run(sequence, now, streamId)

      return mapStream({ ...streamRow, ackSequence: sequence, updatedAt: now })
    })
  }

  async getReconciliationCursor(
    streamId: string,
    entityType: KnownReplicationEntityType,
  ): Promise<ReplicationReconciliationCursor | undefined> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT stream_id AS streamId, entity_type AS entityType, cursor, updated_at AS updatedAt
        FROM replication_reconciliation_cursors
        WHERE stream_id = ? AND entity_type = ?
      `).get(streamId, entityType) as ReplicationReconciliationCursor | undefined
      return row
    })
  }

  async setReconciliationCursor(input: ReplicationReconciliationCursor): Promise<void> {
    await this.executor.run(() => {
      this.requireStreamRow(input.streamId)
      this.executor.db.prepare(`
        INSERT INTO replication_reconciliation_cursors(stream_id, entity_type, cursor, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(stream_id, entity_type) DO UPDATE SET
          cursor = excluded.cursor,
          updated_at = excluded.updated_at
      `).run(input.streamId, input.entityType, input.cursor, input.updatedAt)
    })
  }

  private getStreamRow(streamId: string): StreamRow | undefined {
    return this.executor.db.prepare(`
      SELECT relationship_id AS relationshipId,
             hub_id AS hubId,
             stream_id AS streamId,
             generation_id AS generationId,
             status,
             next_sequence AS nextSequence,
             ack_sequence AS ackSequence,
             policy_revision AS policyRevision,
             history_revision AS historyRevision,
             created_at AS createdAt,
             updated_at AS updatedAt
      FROM replication_streams
      WHERE stream_id = ?
    `).get(streamId) as StreamRow | undefined
  }

  private requireStreamRow(streamId: string): StreamRow {
    const row = this.getStreamRow(streamId)
    if (!row) throw new DurableReplicationError('STREAM_INVALID', `Unknown replication stream: ${streamId}`)
    return row
  }

  private getPendingRow(id: string): PendingRow | undefined {
    return this.executor.db.prepare(`
      SELECT id,
             stream_id AS streamId,
             generation_id AS generationId,
             dedup_key AS dedupKey,
             entity_type AS entityType,
             origin_entity_id AS originEntityId,
             candidate_hash AS candidateHash,
             phase,
             policy_revision AS policyRevision,
             history_revision AS historyRevision,
             payload_json AS payloadJson,
             frozen_sequence AS frozenSequence,
             created_at AS createdAt,
             updated_at AS updatedAt
      FROM replication_pending_entities
      WHERE id = ?
    `).get(id) as PendingRow | undefined
  }

  private getFrozenBatchRow(streamId: string, sequence: number): FrozenBatchRow | undefined {
    return this.executor.db.prepare(`
      SELECT stream_id AS streamId,
             generation_id AS generationId,
             sequence,
             batch_id AS batchId,
             content_hash AS contentHash,
             phase,
             policy_revision AS policyRevision,
             history_revision AS historyRevision,
             payload_json AS payloadJson,
             status,
             frozen_at AS frozenAt,
             acked_at AS ackedAt
      FROM replication_frozen_batches
      WHERE stream_id = ? AND sequence = ?
    `).get(streamId, sequence) as FrozenBatchRow | undefined
  }

  private mapFrozenBatch(row: FrozenBatchRow): FrozenReplicationBatch {
    const items = this.executor.db.prepare(`
      SELECT pending_id AS pendingId
      FROM replication_batch_items
      WHERE stream_id = ? AND sequence = ?
      ORDER BY pending_id
    `).all(row.streamId, row.sequence) as Array<{ pendingId: string }>
    return {
      streamId: row.streamId,
      generationId: row.generationId,
      sequence: row.sequence,
      batchId: row.batchId,
      contentHash: row.contentHash,
      phase: row.phase,
      policyRevision: row.policyRevision,
      historyRevision: row.historyRevision,
      payload: parseJson(row.payloadJson),
      status: row.status,
      frozenAt: row.frozenAt,
      ...(row.ackedAt ? { ackedAt: row.ackedAt } : {}),
      pendingItemIds: items.map(item => item.pendingId),
    }
  }
}
