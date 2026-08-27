import type { JsonValue } from '@agent-lens/core'
import type { KnownReplicationEntityType, PendingReplicationEntity } from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'

interface PendingRow {
  id: string
  streamId: string
  generationId: string
  dedupKey: string
  entityType: KnownReplicationEntityType
  originEntityId: string
  candidateHash: string
  phase: PendingReplicationEntity['phase']
  policyRevision: string
  historyRevision: string
  payloadJson: string
  createdAt: string
  updatedAt: string
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
    payload: JSON.parse(row.payloadJson) as JsonValue,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const SELECT = `
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
         created_at AS createdAt,
         updated_at AS updatedAt
  FROM replication_pending_entities
`

/** Read-only helper for dependency closure when an initial Pending page is truncated. */
export class SqliteReplicationPendingDependencyReader {
  constructor(private readonly executor: SqliteExecutor) {}

  async findOpen(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    originEntityId: string
  }): Promise<PendingReplicationEntity | undefined> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`${SELECT}
        WHERE stream_id = ? AND generation_id = ? AND entity_type = ?
          AND origin_entity_id = ? AND frozen_sequence IS NULL
        ORDER BY rowid ASC
        LIMIT 1
      `).get(input.streamId, input.generationId, input.entityType, input.originEntityId) as PendingRow | undefined
      return row ? mapPending(row) : undefined
    })
  }

  async listOpenByType(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    limit?: number
  }): Promise<readonly PendingReplicationEntity[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 1000, 5000))
    return this.executor.run(() => {
      const rows = this.executor.db.prepare(`${SELECT}
        WHERE stream_id = ? AND generation_id = ? AND entity_type = ? AND frozen_sequence IS NULL
        ORDER BY rowid ASC
        LIMIT ?
      `).all(input.streamId, input.generationId, input.entityType, limit) as PendingRow[]
      return rows.map(mapPending)
    })
  }
}
