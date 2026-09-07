import { createHash } from 'node:crypto'
import type { SourceRuntimeStatus } from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

type RuntimeStatusRow = Record<string, unknown>
const STAGES = ['detect', 'history', 'runtime', 'assets'] as const
const STATES = ['idle', 'running', 'healthy', 'degraded', 'failed', 'disabled'] as const

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

function rowRecord(value: unknown): RuntimeStatusRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite source runtime status query returned a non-object row')
  }
  return value as RuntimeStatusRow
}

function requiredString(row: RuntimeStatusRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`SQLite source runtime status field ${key} must be a string`)
  return value
}

function optionalString(row: RuntimeStatusRow, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`SQLite source runtime status field ${key} must be a string or null`)
  return value
}

function requiredNumber(row: RuntimeStatusRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`SQLite source runtime status field ${key} must be a finite number`)
  }
  return value
}

function mapRuntimeStatus(value: unknown): SourceRuntimeStatus {
  const row = rowRecord(value)
  const stageValue = requiredString(row, 'stage')
  const stateValue = requiredString(row, 'state')
  if (!(STAGES as readonly string[]).includes(stageValue)) {
    throw new TypeError(`SQLite source runtime status field stage has unsupported value: ${stageValue}`)
  }
  if (!(STATES as readonly string[]).includes(stateValue)) {
    throw new TypeError(`SQLite source runtime status field state has unsupported value: ${stateValue}`)
  }
  const runtimeProfileId = optionalString(row, 'runtime_profile_id')
  const lastStartedAt = optionalString(row, 'last_started_at')
  const lastSuccessAt = optionalString(row, 'last_success_at')
  const lastErrorAt = optionalString(row, 'last_error_at')
  const lastErrorSummary = optionalString(row, 'last_error_summary')
  const checkpointSummary = optionalString(row, 'checkpoint_summary')
  return {
    sourceId: requiredString(row, 'source_id'),
    installationId: requiredString(row, 'installation_id'),
    ...(runtimeProfileId === undefined ? {} : { runtimeProfileId }),
    stage: stageValue as SourceRuntimeStatus['stage'],
    state: stateValue as SourceRuntimeStatus['state'],
    ...(lastStartedAt === undefined ? {} : { lastStartedAt }),
    ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
    ...(lastErrorAt === undefined ? {} : { lastErrorAt }),
    errorCount: requiredNumber(row, 'error_count'),
    ...(lastErrorSummary === undefined ? {} : { lastErrorSummary }),
    ...(checkpointSummary === undefined ? {} : { checkpointSummary }),
  }
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
          last_started_at = COALESCE(excluded.last_started_at, source_runtime_status.last_started_at),
          last_success_at = COALESCE(excluded.last_success_at, source_runtime_status.last_success_at),
          last_error_at = COALESCE(excluded.last_error_at, source_runtime_status.last_error_at),
          error_count = CASE
            WHEN excluded.state = 'failed' THEN source_runtime_status.error_count + 1
            ELSE source_runtime_status.error_count
          END,
          last_error_summary = COALESCE(excluded.last_error_summary, source_runtime_status.last_error_summary),
          checkpoint_summary = COALESCE(excluded.checkpoint_summary, source_runtime_status.checkpoint_summary)
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
        status.state === 'failed' ? 1 : 0,
        status.lastErrorSummary ?? null,
        status.checkpointSummary ?? null,
      )
    })
  }

  async list(): Promise<SourceRuntimeStatus[]> {
    return this.executor.run(() => this.executor.db.prepare(`
      SELECT source_id, installation_id, runtime_profile_id, stage, state,
             last_started_at, last_success_at, last_error_at, error_count,
             last_error_summary, checkpoint_summary
      FROM source_runtime_status
      ORDER BY source_id, installation_id, stage
    `).all().map(mapRuntimeStatus))
  }
}
