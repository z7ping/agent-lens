import type { KnownReplicationEntityType } from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'

export interface ReplicationSnapshotBootstrapProgress {
  streamId: string
  generationId: string
  entityType: KnownReplicationEntityType
  baselineRevision: number
  policyRevision: string
  historyRevision: string
  cursor?: string
  snapshotComplete: boolean
  updatedAt: string
}

export type ReplicationSnapshotBootstrapProgressFor<
  TEntityType extends KnownReplicationEntityType,
> = Omit<ReplicationSnapshotBootstrapProgress, 'entityType'> & {
  entityType: TEntityType
}

type Row = Record<string, unknown>

function rowRecord(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Replication snapshot bootstrap progress row must be an object')
  }
  return value as Row
}

function requiredString(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new TypeError(`Replication snapshot bootstrap progress field ${key} must be a string`)
  }
  return value
}

function optionalString(row: Row, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') {
    throw new TypeError(`Replication snapshot bootstrap progress field ${key} must be a string or null`)
  }
  return value
}

function requiredNumber(row: Row, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`Replication snapshot bootstrap progress field ${key} must be a non-negative integer`)
  }
  return value
}

function mapProgress(value: unknown): ReplicationSnapshotBootstrapProgress {
  const row = rowRecord(value)
  const cursor = optionalString(row, 'cursor')
  return {
    streamId: requiredString(row, 'streamId'),
    generationId: requiredString(row, 'generationId'),
    entityType: requiredString(row, 'entityType') as KnownReplicationEntityType,
    baselineRevision: requiredNumber(row, 'baselineRevision'),
    policyRevision: requiredString(row, 'policyRevision'),
    historyRevision: requiredString(row, 'historyRevision'),
    ...(cursor === undefined ? {} : { cursor }),
    snapshotComplete: requiredNumber(row, 'snapshotComplete') === 1,
    updatedAt: requiredString(row, 'updatedAt'),
  }
}

export class SqliteReplicationSnapshotBootstrapProgressRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async get<TEntityType extends KnownReplicationEntityType>(input: {
    streamId: string
    generationId: string
    entityType: TEntityType
  }): Promise<ReplicationSnapshotBootstrapProgressFor<TEntityType> | null> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT stream_id AS streamId,
               generation_id AS generationId,
               entity_type AS entityType,
               baseline_revision AS baselineRevision,
               policy_revision AS policyRevision,
               history_revision AS historyRevision,
               cursor,
               snapshot_complete AS snapshotComplete,
               updated_at AS updatedAt
        FROM replication_snapshot_bootstrap_progress
        WHERE stream_id = ? AND generation_id = ? AND entity_type = ?
      `).get(input.streamId, input.generationId, input.entityType)
      if (!row) return null
      return {
        ...mapProgress(row),
        entityType: input.entityType,
      }
    })
  }

  async put(progress: ReplicationSnapshotBootstrapProgress): Promise<void> {
    if (!Number.isInteger(progress.baselineRevision) || progress.baselineRevision < 0) {
      throw new TypeError('Replication snapshot bootstrap baselineRevision must be a non-negative integer')
    }
    await this.executor.run(() => {
      const stream = this.executor.db.prepare(`
        SELECT generation_id AS generationId
        FROM replication_streams
        WHERE stream_id = ?
      `).get(progress.streamId)
      if (!stream) throw new Error(`Replication stream not found: ${progress.streamId}`)
      const streamGeneration = requiredString(rowRecord(stream), 'generationId')
      if (streamGeneration !== progress.generationId) {
        throw new Error('Snapshot Bootstrap progress generation does not match stream')
      }

      const rawExisting = this.executor.db.prepare(`
        SELECT stream_id AS streamId,
               generation_id AS generationId,
               entity_type AS entityType,
               baseline_revision AS baselineRevision,
               policy_revision AS policyRevision,
               history_revision AS historyRevision,
               cursor,
               snapshot_complete AS snapshotComplete,
               updated_at AS updatedAt
        FROM replication_snapshot_bootstrap_progress
        WHERE stream_id = ? AND generation_id = ? AND entity_type = ?
      `).get(progress.streamId, progress.generationId, progress.entityType)
      const existing = rawExisting ? mapProgress(rawExisting) : null
      if (existing) {
        if (
          existing.baselineRevision !== progress.baselineRevision
          || existing.policyRevision !== progress.policyRevision
          || existing.historyRevision !== progress.historyRevision
        ) {
          throw new Error('Snapshot Bootstrap baseline/policy/history cannot be rebound in place')
        }
        if (existing.snapshotComplete && !progress.snapshotComplete) {
          throw new Error('Snapshot Bootstrap progress cannot move from complete back to scanning')
        }
        if (
          existing.cursor !== undefined
          && (progress.cursor === undefined || progress.cursor < existing.cursor)
        ) {
          throw new Error('Snapshot Bootstrap cursor cannot move backwards')
        }
      }

      this.executor.db.prepare(`
        INSERT INTO replication_snapshot_bootstrap_progress(
          stream_id, generation_id, entity_type, baseline_revision,
          policy_revision, history_revision, cursor, snapshot_complete, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stream_id, generation_id, entity_type) DO UPDATE SET
          cursor = excluded.cursor,
          snapshot_complete = excluded.snapshot_complete,
          updated_at = excluded.updated_at
      `).run(
        progress.streamId,
        progress.generationId,
        progress.entityType,
        progress.baselineRevision,
        progress.policyRevision,
        progress.historyRevision,
        progress.cursor ?? null,
        progress.snapshotComplete ? 1 : 0,
        progress.updatedAt,
      )
    })
  }
}
