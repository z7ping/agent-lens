import type {
  JsonValue,
  SessionSummaryProjectionStore,
  SessionSummaryRecord,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

const MAX_LIMIT = 500
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER

function decodeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return JSON.parse(value) as T
}

function mapSummary(row: any): SessionSummaryRecord {
  const leadingBackground = typeof row.leading_kind === 'string'
    && row.leading_kind !== 'message.user'
  return {
    logicalSessionId: row.logical_session_id,
    installationId: row.installation_id,
    productId: row.product_id,
    sourceIds: decodeJson<string[]>(row.source_ids_json, []),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.project_name ? { projectName: row.project_name } : {}),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.first_user_payload == null
      ? {}
      : { firstUserPayload: decodeJson<JsonValue>(row.first_user_payload, null) }),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    observationCount: Number(row.observation_count),
    interactionCount: Number(row.user_message_count) + (leadingBackground ? 1 : 0),
    toolCount: Number(row.tool_count),
    errorCount: Number(row.error_count),
  }
}

function legacyQuerySql(observationFilter: string): string {
  return `
    WITH session_aggregates AS (
      SELECT
        logical_session_id,
        MIN(COALESCE(occurred_at, captured_at)) AS started_at,
        MAX(COALESCE(occurred_at, captured_at)) AS ended_at,
        COUNT(*) AS observation_count,
        SUM(CASE WHEN kind = 'message.user' THEN 1 ELSE 0 END) AS user_message_count,
        SUM(CASE WHEN kind = 'tool.call' THEN 1 ELSE 0 END) AS tool_count,
        SUM(CASE
          WHEN kind = 'tool.result' AND json_extract(payload_json, '$.success') = 0 THEN 1
          ELSE 0
        END) AS error_count
      FROM observations
      ${observationFilter}
      GROUP BY logical_session_id
      ORDER BY ended_at DESC, logical_session_id ASC
      LIMIT ?
    )
    SELECT
      aggregate.*,
      logical.installation_id,
      installation.product_id,
      logical.project_id,
      project.name AS project_name,
      logical.workspace_id,
      workspace.path AS workspace_path,
      logical.title,
      (
        SELECT payload_json
        FROM observations AS first_user
        WHERE first_user.logical_session_id = aggregate.logical_session_id
          AND first_user.kind = 'message.user'
        ORDER BY
          COALESCE(first_user.occurred_at, first_user.captured_at) ASC,
          COALESCE(first_user.canonical_sequence, first_user.source_sequence, ${MAX_SEQUENCE}) ASC,
          first_user.id ASC
        LIMIT 1
      ) AS first_user_payload,
      (
        SELECT kind
        FROM observations AS first_content
        WHERE first_content.logical_session_id = aggregate.logical_session_id
          AND first_content.kind <> 'session.lifecycle'
        ORDER BY
          COALESCE(first_content.occurred_at, first_content.captured_at) ASC,
          COALESCE(first_content.canonical_sequence, first_content.source_sequence, ${MAX_SEQUENCE}) ASC,
          first_content.id ASC
        LIMIT 1
      ) AS leading_kind,
      (
        SELECT json_group_array(source_id)
        FROM (
          SELECT DISTINCT source_session.source_id
          FROM observations AS source_observation
          JOIN source_sessions AS source_session
            ON source_session.id = source_observation.source_session_id
          WHERE source_observation.logical_session_id = aggregate.logical_session_id
          ORDER BY source_session.source_id
        )
      ) AS source_ids_json
    FROM session_aggregates AS aggregate
    JOIN logical_sessions AS logical ON logical.id = aggregate.logical_session_id
    JOIN agent_installations AS installation ON installation.id = logical.installation_id
    LEFT JOIN projects AS project ON project.id = logical.project_id
    LEFT JOIN workspaces AS workspace ON workspace.id = logical.workspace_id
    ORDER BY aggregate.ended_at DESC, aggregate.logical_session_id ASC
  `
}

export function sessionSummaryProjectionSelectSql(summaryFilter: string): string {
  return `
    SELECT
      summary.logical_session_id,
      summary.installation_id,
      summary.started_at,
      summary.ended_at,
      summary.observation_count,
      summary.user_message_count,
      summary.tool_count,
      summary.error_count,
      summary.first_user_payload,
      summary.leading_kind,
      summary.source_ids_json,
      installation.product_id,
      logical.project_id,
      project.name AS project_name,
      logical.workspace_id,
      workspace.path AS workspace_path,
      logical.title
    FROM session_summary_projection AS summary
    JOIN logical_sessions AS logical ON logical.id = summary.logical_session_id
    JOIN agent_installations AS installation ON installation.id = summary.installation_id
    LEFT JOIN projects AS project ON project.id = logical.project_id
    LEFT JOIN workspaces AS workspace ON workspace.id = logical.workspace_id
    ${summaryFilter}
    ORDER BY summary.ended_at DESC, summary.logical_session_id ASC
    LIMIT ?
  `
}

function rebuildInsertSql(sessionFilter: string): string {
  return `
    INSERT INTO session_summary_projection(
      logical_session_id,
      installation_id,
      started_at,
      ended_at,
      observation_count,
      user_message_count,
      tool_count,
      error_count,
      first_user_payload,
      leading_kind,
      source_ids_json,
      rebuilt_at
    )
    SELECT
      aggregate.logical_session_id,
      logical.installation_id,
      aggregate.started_at,
      aggregate.ended_at,
      aggregate.observation_count,
      aggregate.user_message_count,
      aggregate.tool_count,
      aggregate.error_count,
      (
        SELECT payload_json
        FROM observations AS first_user
        WHERE first_user.logical_session_id = aggregate.logical_session_id
          AND first_user.kind = 'message.user'
        ORDER BY
          COALESCE(first_user.occurred_at, first_user.captured_at) ASC,
          COALESCE(first_user.canonical_sequence, first_user.source_sequence, ${MAX_SEQUENCE}) ASC,
          first_user.id ASC
        LIMIT 1
      ) AS first_user_payload,
      (
        SELECT kind
        FROM observations AS first_content
        WHERE first_content.logical_session_id = aggregate.logical_session_id
          AND first_content.kind <> 'session.lifecycle'
        ORDER BY
          COALESCE(first_content.occurred_at, first_content.captured_at) ASC,
          COALESCE(first_content.canonical_sequence, first_content.source_sequence, ${MAX_SEQUENCE}) ASC,
          first_content.id ASC
        LIMIT 1
      ) AS leading_kind,
      (
        SELECT json_group_array(source_id)
        FROM (
          SELECT DISTINCT source_session.source_id
          FROM observations AS source_observation
          JOIN source_sessions AS source_session
            ON source_session.id = source_observation.source_session_id
          WHERE source_observation.logical_session_id = aggregate.logical_session_id
          ORDER BY source_session.source_id
        )
      ) AS source_ids_json,
      ? AS rebuilt_at
    FROM (
      SELECT
        logical_session_id,
        MIN(COALESCE(occurred_at, captured_at)) AS started_at,
        MAX(COALESCE(occurred_at, captured_at)) AS ended_at,
        COUNT(*) AS observation_count,
        SUM(CASE WHEN kind = 'message.user' THEN 1 ELSE 0 END) AS user_message_count,
        SUM(CASE WHEN kind = 'tool.call' THEN 1 ELSE 0 END) AS tool_count,
        SUM(CASE
          WHEN kind = 'tool.result' AND json_extract(payload_json, '$.success') = 0 THEN 1
          ELSE 0
        END) AS error_count
      FROM observations
      ${sessionFilter}
      GROUP BY logical_session_id
    ) AS aggregate
    JOIN logical_sessions AS logical ON logical.id = aggregate.logical_session_id
    ON CONFLICT(logical_session_id) DO UPDATE SET
      installation_id = excluded.installation_id,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      observation_count = excluded.observation_count,
      user_message_count = excluded.user_message_count,
      tool_count = excluded.tool_count,
      error_count = excluded.error_count,
      first_user_payload = excluded.first_user_payload,
      leading_kind = excluded.leading_kind,
      source_ids_json = excluded.source_ids_json,
      rebuilt_at = excluded.rebuilt_at
  `
}

function whereClause(conditions: string[]): string {
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
}

export class SqliteSessionSummaryReader implements SessionSummaryProjectionStore {
  constructor(private readonly executor: SqliteExecutor) {}

  query(input: {
    limit: number
    installationId?: string
    logicalSessionId?: string
  }): Promise<{ items: SessionSummaryRecord[]; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(input.limit, MAX_LIMIT))
    return this.executor.run(() => {
      const projectionExists = Boolean(this.executor.db.prepare(
        'SELECT 1 FROM session_summary_projection LIMIT 1',
      ).get())
      const observationExists = projectionExists
        ? true
        : Boolean(this.executor.db.prepare('SELECT 1 FROM observations LIMIT 1').get())

      if (projectionExists || !observationExists) {
        const conditions: string[] = []
        const params: unknown[] = []
        if (input.logicalSessionId) {
          conditions.push('summary.logical_session_id = ?')
          params.push(input.logicalSessionId)
        }
        if (input.installationId) {
          conditions.push('summary.installation_id = ?')
          params.push(input.installationId)
        }
        params.push(limit + 1)
        const rows = this.executor.db.prepare(
          sessionSummaryProjectionSelectSql(whereClause(conditions)),
        ).all(...params)

        if (rows.length || !input.logicalSessionId || !projectionExists) {
          return {
            items: rows.slice(0, limit).map(mapSummary),
            hasMore: rows.length > limit,
          }
        }

        const targetObservationExists = Boolean(this.executor.db.prepare(
          'SELECT 1 FROM observations WHERE logical_session_id = ? LIMIT 1',
        ).get(input.logicalSessionId))
        if (!targetObservationExists) {
          return { items: [], hasMore: false }
        }
        // The projection is globally available but this exact session can still be
        // inside the debounced refresh window. Fall through to an exact canonical
        // query for correctness; the steady-state path above remains indexed.
      }

      const conditions: string[] = []
      const params: unknown[] = []
      if (input.logicalSessionId) {
        conditions.push('logical_session_id = ?')
        params.push(input.logicalSessionId)
      }
      if (input.installationId) {
        conditions.push('installation_id = ?')
        params.push(input.installationId)
      }
      params.push(limit + 1)
      const rows = this.executor.db.prepare(legacyQuerySql(whereClause(conditions))).all(...params)
      return {
        items: rows.slice(0, limit).map(mapSummary),
        hasMore: rows.length > limit,
      }
    })
  }

  async rebuild(input: { logicalSessionId?: string } = {}): Promise<void> {
    await this.executor.transaction(async () => {
      const rebuiltAt = new Date().toISOString()
      if (input.logicalSessionId) {
        this.executor.db.prepare(
          'DELETE FROM session_summary_projection WHERE logical_session_id = ?',
        ).run(input.logicalSessionId)
        this.executor.db.prepare(rebuildInsertSql('WHERE logical_session_id = ?'))
          .run(rebuiltAt, input.logicalSessionId)
        return
      }

      this.executor.db.prepare('DELETE FROM session_summary_projection').run()
      this.executor.db.prepare(rebuildInsertSql('')).run(rebuiltAt)
    })
  }
}
