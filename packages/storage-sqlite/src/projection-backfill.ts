import type { SqliteExecutor } from './executor'
import { sqliteRowId } from './repository-row-mappers'

export interface ProjectionBackfillBatchResult {
  scanned: number
  written: number
  cursor?: string
  hasMore: boolean
}

export interface ToolUsageFactProjectionCoverage {
  sourceObservationCount: number
  projectedCount: number
  missingCount: number
  coverageRatio: number
  ready: boolean
}

function batchIds(
  executor: SqliteExecutor,
  where: string,
  after: string | undefined,
  limit: number,
): Array<{ id: string }> {
  const params: unknown[] = []
  const cursor = after ? 'AND id > ?' : ''
  if (after) params.push(after)
  params.push(limit)
  return executor.db.prepare(`
    SELECT id
    FROM observations
    WHERE ${where}
      ${cursor}
    ORDER BY id ASC
    LIMIT ?
  `).all(...params).map(row => ({ id: sqliteRowId(row) }))
}

function countFromRow(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite projection coverage query returned a non-object row')
  }
  const count = (value as Record<string, unknown>).count
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new TypeError('SQLite projection coverage count must be a finite number')
  }
  return count
}

function boundedLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? 250, 1000))
}

function toolUsageFactCoverage(executor: SqliteExecutor): ToolUsageFactProjectionCoverage {
  const sourceObservationCount = countFromRow(executor.db.prepare(`
    SELECT COUNT(*) AS count
    FROM observations
    WHERE kind IN ('tool.call', 'tool.result')
  `).get())
  const projectedCount = countFromRow(executor.db.prepare(`
    SELECT COUNT(*) AS count
    FROM tool_usage_fact_projection
  `).get())
  const missingCount = Math.max(0, sourceObservationCount - projectedCount)
  return {
    sourceObservationCount,
    projectedCount,
    missingCount,
    coverageRatio: sourceObservationCount > 0 ? Math.min(1, projectedCount / sourceObservationCount) : 1,
    ready: missingCount === 0,
  }
}

function repairToolFactCursor(executor: SqliteExecutor, after: string | undefined): string | undefined {
  if (!after) return undefined
  const missingBeforeCursor = executor.db.prepare(`
    SELECT 1 AS missing
    FROM observations o
    LEFT JOIN tool_usage_fact_projection f ON f.observation_id = o.id
    WHERE o.kind IN ('tool.call', 'tool.result')
      AND o.id <= ?
      AND f.observation_id IS NULL
    LIMIT 1
  `).get(after)
  return missingBeforeCursor ? undefined : after
}

export class SqliteProjectionBackfillMaintenance {
  constructor(private readonly executor: SqliteExecutor) {}

  async toolUsageFactCoverage(): Promise<ToolUsageFactProjectionCoverage> {
    return this.executor.run(() => toolUsageFactCoverage(this.executor))
  }

  async toolUsageFactCoverageForMaintenance(): Promise<ToolUsageFactProjectionCoverage> {
    return this.executor.run(() => toolUsageFactCoverage(this.executor))
  }

  async repairToolUsageFactCursor(after?: string): Promise<string | undefined> {
    return this.executor.run(() => repairToolFactCursor(this.executor, after))
  }

  async backfillUnknownObservations(
    after?: string,
    limit?: number,
  ): Promise<ProjectionBackfillBatchResult> {
    const batchLimit = boundedLimit(limit)
    const ids = await this.executor.run(() => batchIds(this.executor, "kind = 'unknown'", after, batchLimit))
    if (!ids.length) return { scanned: 0, written: 0, hasMore: false }

    const placeholders = ids.map(() => '?').join(', ')
    const written = await this.executor.transaction(async () => Number(this.executor.db.prepare(`
      INSERT OR REPLACE INTO unknown_observation_projection(
        observation_id, source_id, native_type, last_seen_at
      )
      SELECT DISTINCT
        o.id,
        sr.source_id,
        sr.native_type,
        COALESCE(o.occurred_at, o.captured_at)
      FROM observations o
      JOIN observation_evidence oe ON oe.observation_id = o.id
      JOIN evidence e ON e.id = oe.evidence_id
      JOIN source_records sr ON sr.id = e.source_record_id
      WHERE o.id IN (${placeholders})
        AND o.kind = 'unknown'
    `).run(...ids.map(row => row.id)).changes))

    return {
      scanned: ids.length,
      written,
      cursor: ids.at(-1)!.id,
      hasMore: ids.length === batchLimit,
    }
  }

  async backfillToolUsageFacts(
    after?: string,
    limit?: number,
  ): Promise<ProjectionBackfillBatchResult> {
    const batchLimit = boundedLimit(limit)
    const ids = await this.executor.run(() => batchIds(
      this.executor,
      "kind IN ('tool.call', 'tool.result')",
      after,
      batchLimit,
    ))
    if (!ids.length) return { scanned: 0, written: 0, hasMore: false }

    const placeholders = ids.map(() => '?').join(', ')
    const written = await this.executor.transaction(async () => Number(this.executor.db.prepare(`
      INSERT OR REPLACE INTO tool_usage_fact_projection(
        observation_id,
        installation_id,
        logical_session_id,
        project_id,
        source_id,
        product_id,
        kind,
        effective_at,
        tool_name,
        call_id,
        skill_name,
        success,
        duration_ms
      )
      SELECT
        o.id,
        o.installation_id,
        o.logical_session_id,
        o.project_id,
        ss.source_id,
        ai.product_id,
        o.kind,
        COALESCE(o.occurred_at, o.captured_at),
        COALESCE(
          CASE WHEN json_type(o.payload_json, '$.nativeToolName') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.nativeToolName'), '') END,
          CASE WHEN json_type(o.payload_json, '$.toolName') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.toolName'), '') END,
          CASE WHEN json_type(o.payload_json, '$.tool_name') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.tool_name'), '') END,
          CASE WHEN json_type(o.payload_json, '$.name') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.name'), '') END
        ),
        COALESCE(
          CASE WHEN json_type(o.payload_json, '$.callId') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.callId'), '') END,
          CASE WHEN json_type(o.payload_json, '$.call_id') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.call_id'), '') END,
          CASE WHEN json_type(o.payload_json, '$.toolUseId') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.toolUseId'), '') END,
          CASE WHEN json_type(o.payload_json, '$.tool_use_id') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.tool_use_id'), '') END
        ),
        COALESCE(
          CASE WHEN json_type(o.payload_json, '$.input.skill') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.input.skill'), '') END,
          CASE WHEN json_type(o.payload_json, '$.input.name') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.input.name'), '') END
        ),
        CASE
          WHEN json_type(o.payload_json, '$.success') IN ('true', 'false', 'integer')
            THEN json_extract(o.payload_json, '$.success')
        END,
        COALESCE(
          CASE WHEN json_type(o.payload_json, '$.durationMs') IN ('integer', 'real') THEN json_extract(o.payload_json, '$.durationMs') END,
          CASE WHEN json_type(o.payload_json, '$.duration_ms') IN ('integer', 'real') THEN json_extract(o.payload_json, '$.duration_ms') END
        )
      FROM observations o
      JOIN source_sessions ss ON ss.id = o.source_session_id
      JOIN agent_installations ai ON ai.id = o.installation_id
      WHERE o.id IN (${placeholders})
        AND o.kind IN ('tool.call', 'tool.result')
    `).run(...ids.map(row => row.id)).changes))

    return {
      scanned: ids.length,
      written,
      cursor: ids.at(-1)!.id,
      hasMore: ids.length === batchLimit,
    }
  }
}

export const projectionBackfillInternals = {
  toolUsageFactCoverage,
  repairToolFactCursor,
}
