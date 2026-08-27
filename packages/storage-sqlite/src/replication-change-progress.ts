import type { KnownReplicationEntityType, ReplicationHistoryPhase } from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'

export interface ReplicationChangeProgress {
  streamId: string
  generationId: string
  phase: Extract<ReplicationHistoryPhase, 'bootstrap' | 'incremental' | 'reconcile'>
  entityType: KnownReplicationEntityType
  revision: number
  throughRevision: number
  updatedAt: string
}

export class SqliteReplicationChangeProgressRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async get(input: {
    streamId: string
    generationId: string
    phase: ReplicationChangeProgress['phase']
    entityType: KnownReplicationEntityType
  }): Promise<ReplicationChangeProgress | null> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT stream_id AS streamId,
               generation_id AS generationId,
               phase,
               entity_type AS entityType,
               revision,
               through_revision AS throughRevision,
               updated_at AS updatedAt
        FROM replication_change_progress
        WHERE stream_id = ? AND generation_id = ? AND phase = ? AND entity_type = ?
      `).get(input.streamId, input.generationId, input.phase, input.entityType) as ReplicationChangeProgress | undefined
      return row ?? null
    })
  }

  async put(progress: ReplicationChangeProgress): Promise<void> {
    if (!Number.isInteger(progress.revision) || progress.revision < 0) {
      throw new TypeError('Replication change progress revision must be a non-negative integer')
    }
    if (!Number.isInteger(progress.throughRevision) || progress.throughRevision < progress.revision) {
      throw new TypeError('Replication change progress throughRevision must be >= revision')
    }

    await this.executor.run(() => {
      this.executor.db.prepare(`
        INSERT INTO replication_change_progress(
          stream_id, generation_id, phase, entity_type, revision, through_revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stream_id, generation_id, phase, entity_type) DO UPDATE SET
          revision = excluded.revision,
          through_revision = excluded.through_revision,
          updated_at = excluded.updated_at
      `).run(
        progress.streamId,
        progress.generationId,
        progress.phase,
        progress.entityType,
        progress.revision,
        progress.throughRevision,
        progress.updatedAt,
      )
    })
  }
}
