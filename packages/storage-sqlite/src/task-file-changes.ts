import type {
  LogicalSessionId,
  TaskFileChangeCapture,
  TaskFileChangeProjectionStore,
  TaskFileChangeRecord,
} from '@agent-lens/core'
import { SqliteExecutor } from './executor'

type Row = Record<string, unknown>

function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Task file change query returned a non-object row')
  }
  return value as Row
}

function requiredString(value: Row, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string' || !candidate) {
    throw new TypeError(`Task file change field ${key} must be a non-empty string`)
  }
  return candidate
}

function optionalString(value: Row, key: string): string | undefined {
  const candidate = value[key]
  if (candidate == null) return undefined
  if (typeof candidate !== 'string') {
    throw new TypeError(`Task file change field ${key} must be a string or null`)
  }
  return candidate || undefined
}

function optionalNumber(value: Row, key: string): number | undefined {
  const candidate = value[key]
  if (candidate == null) return undefined
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new TypeError(`Task file change field ${key} must be a finite number or null`)
  }
  return candidate
}

function parseEvidence(value: unknown): TaskFileChangeRecord['evidence'] {
  if (typeof value !== 'string') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is TaskFileChangeRecord['evidence'][number] =>
    item === 'tool' || item === 'filesystem' || item === 'git'
  )
}

function parseChangeRecord(value: unknown): TaskFileChangeRecord {
  const item = row(value)
  const rawType = requiredString(item, 'change_type')
  const rawConfidence = requiredString(item, 'confidence')
  if (!['added', 'modified', 'deleted', 'renamed', 'unknown'].includes(rawType)) {
    throw new TypeError(`Unsupported task file change type: ${rawType}`)
  }
  if (!['exact', 'high', 'medium', 'low'].includes(rawConfidence)) {
    throw new TypeError(`Unsupported task file change confidence: ${rawConfidence}`)
  }
  return {
    logicalSessionId: requiredString(item, 'logical_session_id'),
    path: requiredString(item, 'path'),
    changeType: rawType as TaskFileChangeRecord['changeType'],
    ...(optionalString(item, 'old_path') ? { oldPath: optionalString(item, 'old_path') } : {}),
    ...(optionalNumber(item, 'additions') === undefined ? {} : { additions: optionalNumber(item, 'additions') }),
    ...(optionalNumber(item, 'deletions') === undefined ? {} : { deletions: optionalNumber(item, 'deletions') }),
    firstChangedAt: requiredString(item, 'first_changed_at'),
    lastChangedAt: requiredString(item, 'last_changed_at'),
    evidence: parseEvidence(item.evidence_json),
    confidence: rawConfidence as TaskFileChangeRecord['confidence'],
  }
}

function parseCapture(value: unknown): TaskFileChangeCapture {
  const item = row(value)
  let changes: TaskFileChangeRecord[] | undefined
  const rawChanges = optionalString(item, 'changes_json')
  if (rawChanges) {
    try {
      const parsed = JSON.parse(rawChanges)
      if (Array.isArray(parsed)) changes = parsed as TaskFileChangeRecord[]
    } catch {
      changes = undefined
    }
  }
  return {
    runtimeSessionId: requiredString(item, 'runtime_session_id'),
    ...(optionalString(item, 'logical_session_id')
      ? { logicalSessionId: optionalString(item, 'logical_session_id')! }
      : {}),
    workspacePath: requiredString(item, 'workspace_path'),
    ...(optionalString(item, 'git_root_path') ? { gitRootPath: optionalString(item, 'git_root_path') } : {}),
    ...(optionalString(item, 'baseline_tree_sha') ? { baselineTreeSha: optionalString(item, 'baseline_tree_sha') } : {}),
    baselineCapturedAt: requiredString(item, 'baseline_captured_at'),
    ...(optionalString(item, 'final_tree_sha') ? { finalTreeSha: optionalString(item, 'final_tree_sha') } : {}),
    ...(optionalString(item, 'finalized_at') ? { finalizedAt: optionalString(item, 'finalized_at') } : {}),
    ...(changes ? { changes } : {}),
  }
}

function insertProjection(
  executor: SqliteExecutor,
  logicalSessionId: LogicalSessionId,
  changes: readonly TaskFileChangeRecord[],
): void {
  const statement = executor.db.prepare(`
    INSERT INTO task_file_change_projection(
      logical_session_id,
      path,
      change_type,
      old_path,
      additions,
      deletions,
      first_changed_at,
      last_changed_at,
      evidence_json,
      confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const change of changes) {
    statement.run(
      logicalSessionId,
      change.path,
      change.changeType,
      change.oldPath ?? null,
      change.additions ?? null,
      change.deletions ?? null,
      change.firstChangedAt,
      change.lastChangedAt,
      JSON.stringify(change.evidence),
      change.confidence,
    )
  }
}

export class SqliteTaskFileChangeProjectionStore implements TaskFileChangeProjectionStore {
  constructor(private readonly executor: SqliteExecutor) {}

  listBySession(logicalSessionId: LogicalSessionId): Promise<TaskFileChangeRecord[]> {
    return this.executor.run(() => this.executor.db.prepare(`
      SELECT *
      FROM task_file_change_projection
      WHERE logical_session_id = ?
      ORDER BY path ASC
    `).all(logicalSessionId).map(parseChangeRecord))
  }

  putBaseline(capture: TaskFileChangeCapture): Promise<void> {
    return this.executor.run(() => {
      const now = new Date().toISOString()
      this.executor.db.prepare(`
        INSERT INTO task_file_change_capture(
          runtime_session_id,
          logical_session_id,
          workspace_path,
          git_root_path,
          baseline_tree_sha,
          baseline_captured_at,
          final_tree_sha,
          finalized_at,
          changes_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(runtime_session_id) DO NOTHING
      `).run(
        capture.runtimeSessionId,
        capture.logicalSessionId ?? null,
        capture.workspacePath,
        capture.gitRootPath ?? null,
        capture.baselineTreeSha ?? null,
        capture.baselineCapturedAt,
        capture.finalTreeSha ?? null,
        capture.finalizedAt ?? null,
        capture.changes ? JSON.stringify(capture.changes) : null,
        now,
        now,
      )
    })
  }

  getByRuntime(runtimeSessionId: string): Promise<TaskFileChangeCapture | null> {
    return this.executor.run(() => {
      const value = this.executor.db.prepare(`
        SELECT *
        FROM task_file_change_capture
        WHERE runtime_session_id = ?
      `).get(runtimeSessionId)
      return value ? parseCapture(value) : null
    })
  }

  bindRuntime(runtimeSessionId: string, logicalSessionId: LogicalSessionId): Promise<void> {
    return this.executor.transaction(async () => {
      const current = this.executor.db.prepare(`
        SELECT logical_session_id
        FROM task_file_change_capture
        WHERE runtime_session_id = ?
      `).get(runtimeSessionId) as { logical_session_id?: string | null } | undefined
      if (!current) throw new Error(`Task file change baseline not found: ${runtimeSessionId}`)
      if (current.logical_session_id && current.logical_session_id !== logicalSessionId) {
        throw new Error(
          `Task file change runtime ${runtimeSessionId} is already bound to ${current.logical_session_id}`,
        )
      }
      this.executor.db.prepare(`
        UPDATE task_file_change_capture
        SET logical_session_id = ?, updated_at = ?
        WHERE runtime_session_id = ?
      `).run(logicalSessionId, new Date().toISOString(), runtimeSessionId)
    })
  }

  finalizeRuntime(
    runtimeSessionId: string,
    input: {
      logicalSessionId: LogicalSessionId
      finalTreeSha?: string
      finalizedAt: string
      changes: TaskFileChangeRecord[]
    },
  ): Promise<void> {
    return this.executor.transaction(async () => {
      const current = this.executor.db.prepare(`
        SELECT runtime_session_id, logical_session_id
        FROM task_file_change_capture
        WHERE runtime_session_id = ?
      `).get(runtimeSessionId) as {
        runtime_session_id?: string
        logical_session_id?: string | null
      } | undefined
      if (!current) throw new Error(`Task file change baseline not found: ${runtimeSessionId}`)
      if (current.logical_session_id && current.logical_session_id !== input.logicalSessionId) {
        throw new Error(
          `Task file change runtime ${runtimeSessionId} is already bound to ${current.logical_session_id}`,
        )
      }

      this.executor.db.prepare(`
        UPDATE task_file_change_capture
        SET logical_session_id = ?,
            final_tree_sha = ?,
            finalized_at = ?,
            changes_json = ?,
            updated_at = ?
        WHERE runtime_session_id = ?
      `).run(
        input.logicalSessionId,
        input.finalTreeSha ?? null,
        input.finalizedAt,
        JSON.stringify(input.changes),
        new Date().toISOString(),
        runtimeSessionId,
      )

      this.executor.db.prepare(`
        DELETE FROM task_file_change_projection
        WHERE logical_session_id = ?
      `).run(input.logicalSessionId)
      insertProjection(this.executor, input.logicalSessionId, input.changes)
    })
  }

  replaceObservedSession(
    logicalSessionId: LogicalSessionId,
    changes: TaskFileChangeRecord[],
  ): Promise<boolean> {
    return this.executor.transaction(async () => {
      const finalized = this.executor.db.prepare(`
        SELECT 1 AS present
        FROM task_file_change_capture
        WHERE logical_session_id = ?
          AND finalized_at IS NOT NULL
          AND changes_json IS NOT NULL
        LIMIT 1
      `).get(logicalSessionId)
      if (finalized) return false

      this.executor.db.prepare(`
        DELETE FROM task_file_change_projection
        WHERE logical_session_id = ?
      `).run(logicalSessionId)
      insertProjection(this.executor, logicalSessionId, changes)
      return true
    })
  }

  replaceSession(
    logicalSessionId: LogicalSessionId,
    changes: TaskFileChangeRecord[],
  ): Promise<void> {
    return this.executor.transaction(async () => {
      this.executor.db.prepare(`
        DELETE FROM task_file_change_projection
        WHERE logical_session_id = ?
      `).run(logicalSessionId)
      insertProjection(this.executor, logicalSessionId, changes)
    })
  }

  rebuild(input: { logicalSessionId?: LogicalSessionId; signal?: AbortSignal } = {}): Promise<void> {
    return this.executor.transaction(async () => {
      if (input.signal?.aborted) return

      if (input.logicalSessionId) {
        this.executor.db.prepare(`
          DELETE FROM task_file_change_projection
          WHERE logical_session_id = ?
        `).run(input.logicalSessionId)
      } else {
        this.executor.db.prepare('DELETE FROM task_file_change_projection').run()
      }

      const captures = this.executor.db.prepare(`
        WITH ranked AS (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY logical_session_id
                   ORDER BY finalized_at DESC, updated_at DESC, runtime_session_id DESC
                 ) AS capture_rank
          FROM task_file_change_capture
          WHERE logical_session_id IS NOT NULL
            AND finalized_at IS NOT NULL
            AND changes_json IS NOT NULL
            ${input.logicalSessionId ? 'AND logical_session_id = ?' : ''}
        )
        SELECT *
        FROM ranked
        WHERE capture_rank = 1
        ORDER BY logical_session_id
      `).all(...(input.logicalSessionId ? [input.logicalSessionId] : []))

      for (const value of captures) {
        if (input.signal?.aborted) return
        const capture = parseCapture(value)
        if (!capture.logicalSessionId || !capture.changes) continue
        insertProjection(this.executor, capture.logicalSessionId, capture.changes)
      }
    })
  }
}
