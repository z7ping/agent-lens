import type {
  JsonValue,
  MaintenanceJob,
  MaintenanceJobEnsureInput,
  MaintenanceJobState,
  MaintenanceJobStore,
  MaintenanceJobTransitionInput,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

type MaintenanceJobRow = Record<string, unknown>
const JOB_TYPES = ['deferred-indexes', 'projection-rebuild', 'parser-replay', 'source-record-compression', 'retention-purge', 'vacuum'] as const
const JOB_STATES = ['pending', 'running', 'paused', 'completed', 'failed'] as const

function encodeJson(value: JsonValue | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

function rowRecord(value: unknown): MaintenanceJobRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite maintenance job query returned a non-object row')
  }
  return value as MaintenanceJobRow
}

function requiredString(row: MaintenanceJobRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`SQLite maintenance job field ${key} must be a string`)
  return value
}

function optionalString(row: MaintenanceJobRow, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`SQLite maintenance job field ${key} must be a string or null`)
  return value
}

function requiredNumber(row: MaintenanceJobRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`SQLite maintenance job field ${key} must be a finite number`)
  }
  return value
}

function jsonValue(value: unknown, key: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(item => jsonValue(item, key))
  if (typeof value === 'object') {
    const result: { [key: string]: JsonValue } = {}
    for (const [entryKey, entryValue] of Object.entries(value)) result[entryKey] = jsonValue(entryValue, key)
    return result
  }
  throw new TypeError(`SQLite maintenance job field ${key} must contain JSON data`)
}

function decodeJson(value: unknown): JsonValue | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string') throw new TypeError('SQLite maintenance job field progress_json must contain JSON text')
  try {
    return jsonValue(JSON.parse(value), 'progress_json')
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError('SQLite maintenance job field progress_json contains invalid JSON')
  }
}

function mapJob(value: unknown): MaintenanceJob {
  const row = rowRecord(value)
  const typeValue = requiredString(row, 'type')
  const stateValue = requiredString(row, 'state')
  if (!(JOB_TYPES as readonly string[]).includes(typeValue)) {
    throw new TypeError(`SQLite maintenance job field type has unsupported value: ${typeValue}`)
  }
  if (!(JOB_STATES as readonly string[]).includes(stateValue)) {
    throw new TypeError(`SQLite maintenance job field state has unsupported value: ${stateValue}`)
  }
  const progress = decodeJson(row.progress_json)
  const errorSummary = optionalString(row, 'error_summary')
  const startedAt = optionalString(row, 'started_at')
  const completedAt = optionalString(row, 'completed_at')
  return {
    id: requiredString(row, 'id'),
    type: typeValue as MaintenanceJob['type'],
    scope: requiredString(row, 'scope'),
    priority: requiredNumber(row, 'priority'),
    state: stateValue as MaintenanceJobState,
    revision: requiredNumber(row, 'revision'),
    ...(progress === undefined ? {} : { progress }),
    ...(errorSummary === undefined ? {} : { errorSummary }),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
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
        return this.executor.db.prepare(`
          SELECT * FROM maintenance_jobs
          ORDER BY priority ASC, updated_at ASC, id ASC
        `).all().map(mapJob)
      }
      const placeholders = states.map(() => '?').join(', ')
      return this.executor.db.prepare(`
        SELECT * FROM maintenance_jobs
        WHERE state IN (${placeholders})
        ORDER BY priority ASC, updated_at ASC, id ASC
      `).all(...states).map(mapJob)
    })
  }

  async transition(
    id: string,
    expectedRevision: number,
    input: MaintenanceJobTransitionInput,
  ): Promise<MaintenanceJob | null> {
    return this.executor.run(() => {
      const now = new Date().toISOString()
      const rawCurrent = this.executor.db.prepare(`
        SELECT * FROM maintenance_jobs WHERE id = ? AND revision = ?
      `).get(id, expectedRevision)
      if (!rawCurrent) return null
      const current = rowRecord(rawCurrent)

      const startedAt = input.state === 'running'
        ? optionalString(current, 'started_at') ?? now
        : optionalString(current, 'started_at')
      const completedAt = input.state === 'completed'
        ? now
        : input.state === 'pending' || input.state === 'running' || input.state === 'paused'
          ? null
          : optionalString(current, 'completed_at') ?? null
      const currentErrorSummary = optionalString(current, 'error_summary')
      const errorSummary = input.errorSummary === undefined
        ? (input.state === 'running' || input.state === 'completed' ? null : currentErrorSummary ?? null)
        : input.errorSummary.slice(0, 2000)
      const currentProgressJson = current.progress_json
      if (currentProgressJson != null && typeof currentProgressJson !== 'string') {
        throw new TypeError('SQLite maintenance job field progress_json must be a string or null')
      }
      const progressJson = input.progress === undefined
        ? currentProgressJson ?? null
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
        startedAt ?? null,
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
