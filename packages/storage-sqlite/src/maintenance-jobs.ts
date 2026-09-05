import type {
  JsonValue,
  MaintenanceJob,
  MaintenanceJobEnsureInput,
  MaintenanceJobState,
  MaintenanceJobStore,
  MaintenanceJobTransitionInput,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

function encodeJson(value: JsonValue | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

function decodeJson(value: unknown): JsonValue | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return JSON.parse(value) as JsonValue
}

function mapJob(row: any): MaintenanceJob {
  return {
    id: row.id,
    type: row.type,
    scope: row.scope,
    priority: Number(row.priority),
    state: row.state,
    revision: Number(row.revision),
    ...(decodeJson(row.progress_json) === undefined ? {} : { progress: decodeJson(row.progress_json)! }),
    ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  }
}

export class SqliteMaintenanceJobStore implements MaintenanceJobStore {
  constructor(private readonly executor: SqliteExecutor) {}

  async ensure(input: MaintenanceJobEnsureInput): Promise<MaintenanceJob> {
    return this.executor.run(() => {
      const now = new Date().toISOString()
      this.executor.db.prepare(`
        INSERT INTO maintenance_jobs(
          id, type, scope, priority, state, progress_json, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?)
        ON CONFLICT(type, scope) DO UPDATE SET
          priority = excluded.priority,
          progress_json = COALESCE(maintenance_jobs.progress_json, excluded.progress_json),
          updated_at = CASE
            WHEN maintenance_jobs.priority != excluded.priority THEN excluded.updated_at
            ELSE maintenance_jobs.updated_at
          END
      `).run(
        input.id,
        input.type,
        input.scope,
        input.priority,
        encodeJson(input.progress),
        now,
        now,
      )
      const row = this.executor.db.prepare(`
        SELECT * FROM maintenance_jobs WHERE type = ? AND scope = ?
      `).get(input.type, input.scope)
      if (!row) throw new Error(`Failed to ensure maintenance job: ${input.type}/${input.scope}`)
      return mapJob(row)
    })
  }

  async get(id: string): Promise<MaintenanceJob | null> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare('SELECT * FROM maintenance_jobs WHERE id = ?').get(id)
      return row ? mapJob(row) : null
    })
  }

  async list(states?: readonly MaintenanceJobState[]): Promise<MaintenanceJob[]> {
    return this.executor.run(() => {
      if (!states?.length) {
        return (this.executor.db.prepare(`
          SELECT * FROM maintenance_jobs
          ORDER BY priority ASC, updated_at ASC, id ASC
        `).all() as any[]).map(mapJob)
      }
      const placeholders = states.map(() => '?').join(', ')
      return (this.executor.db.prepare(`
        SELECT * FROM maintenance_jobs
        WHERE state IN (${placeholders})
        ORDER BY priority ASC, updated_at ASC, id ASC
      `).all(...states) as any[]).map(mapJob)
    })
  }

  async transition(
    id: string,
    expectedRevision: number,
    input: MaintenanceJobTransitionInput,
  ): Promise<MaintenanceJob | null> {
    return this.executor.run(() => {
      const now = new Date().toISOString()
      const current = this.executor.db.prepare(`
        SELECT * FROM maintenance_jobs WHERE id = ? AND revision = ?
      `).get(id, expectedRevision) as any
      if (!current) return null

      const startedAt = input.state === 'running'
        ? current.started_at ?? now
        : current.started_at
      const completedAt = input.state === 'completed'
        ? now
        : input.state === 'pending' || input.state === 'running' || input.state === 'paused'
          ? null
          : current.completed_at
      const errorSummary = input.errorSummary === undefined
        ? (input.state === 'running' || input.state === 'completed' ? null : current.error_summary)
        : input.errorSummary.slice(0, 2000)
      const progressJson = input.progress === undefined
        ? current.progress_json
        : encodeJson(input.progress)

      const result = this.executor.db.prepare(`
        UPDATE maintenance_jobs
        SET state = ?,
            progress_json = ?,
            error_summary = ?,
            revision = revision + 1,
            updated_at = ?,
            started_at = ?,
            completed_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        input.state,
        progressJson,
        errorSummary,
        now,
        startedAt,
        completedAt,
        id,
        expectedRevision,
      )
      if (Number(result.changes) !== 1) return null
      const updated = this.executor.db.prepare('SELECT * FROM maintenance_jobs WHERE id = ?').get(id)
      return updated ? mapJob(updated) : null
    })
  }
}
