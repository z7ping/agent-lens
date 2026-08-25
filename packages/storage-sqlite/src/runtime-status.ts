import { createHash } from 'node:crypto'
import type { SourceRuntimeStatus } from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

function statusId(status: SourceRuntimeStatus): string {
  return `source-status-${createHash('sha256')
    .update(JSON.stringify([
      status.sourceId,
      status.installationId,
      status.runtimeProfileId ?? '',
      status.stage,
    ]))
    .digest('hex')
    .slice(0, 32)}`
}

export class SqliteSourceRuntimeStatusRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async put(status: SourceRuntimeStatus): Promise<void> {
    await this.executor.run(() => {
      this.executor.db.prepare(`
        INSERT INTO source_runtime_status(
          id, source_id, installation_id, runtime_profile_id, stage, state,
          last_started_at, last_success_at, last_error_at, error_count,
          last_error_summary, checkpoint_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state = excluded.state,
          last_started_at = excluded.last_started_at,
          last_success_at = excluded.last_success_at,
          last_error_at = excluded.last_error_at,
          error_count = excluded.error_count,
          last_error_summary = excluded.last_error_summary,
          checkpoint_summary = excluded.checkpoint_summary
      `).run(
        statusId(status),
        status.sourceId,
        status.installationId,
        status.runtimeProfileId ?? null,
        status.stage,
        status.state,
        status.lastStartedAt ?? null,
        status.lastSuccessAt ?? null,
        status.lastErrorAt ?? null,
        status.errorCount,
        status.lastErrorSummary ?? null,
        status.checkpointSummary ?? null,
      )
    })
  }

  async list(): Promise<SourceRuntimeStatus[]> {
    return this.executor.run(() => {
      const rows = this.executor.db.prepare(`
        SELECT source_id, installation_id, runtime_profile_id, stage, state,
               last_started_at, last_success_at, last_error_at, error_count,
               last_error_summary, checkpoint_summary
        FROM source_runtime_status
        ORDER BY source_id, installation_id, stage
      `).all() as Array<{
        source_id: string
        installation_id: string
        runtime_profile_id: string | null
        stage: SourceRuntimeStatus['stage']
        state: SourceRuntimeStatus['state']
        last_started_at: string | null
        last_success_at: string | null
        last_error_at: string | null
        error_count: number
        last_error_summary: string | null
        checkpoint_summary: string | null
      }>

      return rows.map(row => ({
        sourceId: row.source_id,
        installationId: row.installation_id,
        ...(row.runtime_profile_id ? { runtimeProfileId: row.runtime_profile_id } : {}),
        stage: row.stage,
        state: row.state,
        ...(row.last_started_at ? { lastStartedAt: row.last_started_at } : {}),
        ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
        ...(row.last_error_at ? { lastErrorAt: row.last_error_at } : {}),
        errorCount: row.error_count,
        ...(row.last_error_summary ? { lastErrorSummary: row.last_error_summary } : {}),
        ...(row.checkpoint_summary ? { checkpointSummary: row.checkpoint_summary } : {}),
      }))
    })
  }
}
