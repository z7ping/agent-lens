import type { KnownReplicationEntityType } from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'

export interface ReplicationSnapshotBootstrapProgress {
  streamId: string
  generationId: string
  entityType: KnownReplicationEntityType
  baselineRevision: number
  cursor?: string
  snapshotComplete: boolean
  updatedAt: string
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
    ...(cursor === undefined ? {} : { cursor }),
    snapshotComplete: requiredNumber(row, 'snapshotComplete') === 1,
    updatedAt: requiredString(row, 'updatedAt'),
  }
}

export class SqliteReplicationSnapshotBootstrapProgressRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async get(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
  }): Promise<ReplicationSnapshotBootstrapProgress | null> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT stream_id AS streamId,
               generation_id AS generationId,
               entity_type AS entityType,
               baseline_revision AS baselineRevision,
               cursor,
               snapshot_complete AS snapshotComplete,
               updated_at AS updatedAt
        FROM replication_snapshot_bootstrap_progress
        WHERE stream_id = ? AND generation_id = ? AND entity_type = ?
      `).get(input.streamId, input.generationId, input.entityType)
      return row ? mapProgress(row) : null
    })
  }

  async put(progress: ReplicationSnapshotBootstrapProgress): Promise<void> {
    if (!Number.isInteger(progress.baselineRevision) || progress.baselineRevision < 0) {
      throw new TypeError('Replication snapshot bootstrap baselineRevision must be a non-negative integer')
    }
    await this.executor.run(() => {
      this.executor.db.prepare(`
        INSERT INTO replication_snapshot_bootstrap_progress(
          stream_id, generation_id, entity_type, baseline_revision,
          cursor, snapshot_complete, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stream_id, generation_id, entity_type) DO UPDATE SET
          baseline_revision = excluded.baseline_revision,
          cursor = excluded.cursor,
          snapshot_complete = excluded.snapshot_complete,
          updated_at = excluded.updated_at
      `).run(
        progress.streamId,
        progress.generationId,
        progress.entityType,
        progress.baselineRevision,
        progress.cursor ?? null,
        progress.snapshotComplete ? 1 : 0,
        progress.updatedAt,
      )
    })
  }
}
