import type {
  JsonValue,
  SessionSummaryProjectionStore,
  SessionSummaryQuery,
  SessionSummaryRecord,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

const MAX_LIMIT = 500
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER
const DEFAULT_REBUILD_BATCH_SIZE = 25

export interface SqliteSessionSummaryReaderOptions {
  rebuildBatchSize?: number
  yieldControl?: () => Promise<void>
}

function decodeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return JSON.parse(value) as T
}

function payloadText(value: JsonValue | undefined): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const text = (value as Record<string, JsonValue>).text
  return typeof text === 'string' && text.trim() ? text.trim() : undefined
}

function mapSummary(row: any): SessionSummaryRecord {
  const firstUserPayload = row.first_user_payload == null
    ? undefined
    : decodeJson<JsonValue>(row.first_user_payload, null)
  const nativeTitle = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : undefined
  const fallbackTitle = payloadText(firstUserPayload)
  return {
    logicalSessionId: row.logical_session_id,
    installationId: row.installation_id,
    productId: row.product_id,
    sourceIds: decodeJson<string[]>(row.source_ids_json, []),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.project_name ? { projectName: row.project_name } : {}),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    ...(nativeTitle || fallbackTitle ? { title: nativeTitle ?? fallbackTitle } : {}),
    ...(firstUserPayload === undefined ? {} : { firstUserPayload }),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    observationCount: Number(row.observation_count),
    interactionCount: Number(row.user_turn_count ?? row.user_message_count ?? 0),
    userTurnCount: Number(row.user_turn_count ?? row.user_message_count ?? 0),
    systemContextCount: Number(row.system_context_count ?? 0),
    internalReviewCount: Number(row.internal_review_count ?? 0),
    otherEventCount: Number(row.other_event_count ?? 0),
    toolCount: Number(row.tool_count),
    errorCount: Number(row.error_count),
    sessionActivity: row.session_activity ?? 'user-task',
    ...(row.activity_source_label ? { activitySourceLabel: row.activity_source_label } : {}),
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
  }
}

const REAL_USER_SQL = `
  kind = 'message.user'
  AND COALESCE(json_extract(payload_json, '$.provenance.actualAuthor'), 'human-user') = 'human-user'
  AND COALESCE(json_extract(payload_json, '$.provenance.contentRole'), 'user-request') = 'user-request'
`

const SYSTEM_CONTEXT_SQL = `
  kind = 'context.injected'
  AND COALESCE(json_extract(payload_json, '$.provenance.activityType'), 'system-injection') = 'system-injection'
`

function firstUserPayloadSql(sessionIdSql: string): string {
  return `(
    SELECT payload_json
    FROM observations AS first_user
    WHERE first_user.logical_session_id = ${sessionIdSql}
      AND first_user.kind = 'message.user'
      AND COALESCE(json_extract(first_user.payload_json, '$.provenance.actualAuthor'), 'human-user') = 'human-user'
      AND COALESCE(json_extract(first_user.payload_json, '$.provenance.contentRole'), 'user-request') = 'user-request'
    ORDER BY
      COALESCE(first_user.occurred_at, first_user.captured_at) ASC,
      COALESCE(first_user.canonical_sequence, first_user.source_sequence, ${MAX_SEQUENCE}) ASC,
      first_user.id ASC
    LIMIT 1
  )`
}

function sessionActivitySql(sessionIdSql: string): string {
  return `COALESCE((
    SELECT json_extract(activity.payload_json, '$.sessionActivity')
    FROM observations AS activity
    WHERE activity.logical_session_id = ${sessionIdSql}
      AND activity.kind = 'session.lifecycle'
      AND json_extract(activity.payload_json, '$.sessionActivity') IS NOT NULL
    ORDER BY COALESCE(activity.occurred_at, activity.captured_at), activity.id
    LIMIT 1
  ), 'user-task')`
}

function activitySourceLabelSql(sessionIdSql: string): string {
  return `(
    SELECT json_extract(activity.payload_json, '$.activitySourceLabel')
    FROM observations AS activity
    WHERE activity.logical_session_id = ${sessionIdSql}
      AND activity.kind = 'session.lifecycle'
      AND json_extract(activity.payload_json, '$.activitySourceLabel') IS NOT NULL
    ORDER BY COALESCE(activity.occurred_at, activity.captured_at), activity.id
    LIMIT 1
  )`
}

function parentSessionSql(sessionIdSql: string): string {
  return `(
    SELECT relation.from_session_id
    FROM session_relationships AS relation
    WHERE relation.to_session_id = ${sessionIdSql}
      AND relation.type IN ('internal-review', 'subagent', 'branch-task', 'fork', 'related')
    ORDER BY CASE relation.type
      WHEN 'internal-review' THEN 0
      WHEN 'subagent' THEN 1
      WHEN 'branch-task' THEN 2
      WHEN 'fork' THEN 3
      ELSE 4 END,
      relation.id
    LIMIT 1
  )`
}

function internalReviewCountSql(sessionIdSql: string): string {
  return `(
    SELECT COUNT(*)
    FROM session_relationships AS review_relation
    WHERE review_relation.from_session_id = ${sessionIdSql}
      AND review_relation.type = 'internal-review'
  )`
}

function legacyQuerySql(observationFilter: string, summaryFilter: string): string {
  return `
    WITH session_aggregates AS (
      SELECT
        logical_session_id,
        COALESCE(MIN(occurred_at), MIN(captured_at)) AS started_at,
        COALESCE(MAX(occurred_at), MAX(captured_at)) AS ended_at,
        COUNT(*) AS observation_count,
        SUM(CASE WHEN ${REAL_USER_SQL} THEN 1 ELSE 0 END) AS user_turn_count,
        SUM(CASE WHEN ${SYSTEM_CONTEXT_SQL} THEN 1 ELSE 0 END) AS system_context_count,
        SUM(CASE WHEN kind = 'tool.call' THEN 1 ELSE 0 END) AS tool_count,
        SUM(CASE WHEN kind LIKE 'tool.%' THEN 1 ELSE 0 END) AS tool_event_count,
        SUM(CASE
          WHEN kind = 'tool.result' AND json_extract(payload_json, '$.success') = 0 THEN 1
          ELSE 0
        END) AS error_count
      FROM observations
      ${observationFilter}
      GROUP BY logical_session_id
    ),
    legacy_summary AS (
      SELECT
        aggregate.*,
        aggregate.user_turn_count AS user_message_count,
        MAX(0, aggregate.observation_count - aggregate.user_turn_count - aggregate.system_context_count - aggregate.tool_event_count) AS other_event_count,
        ${internalReviewCountSql('aggregate.logical_session_id')} AS internal_review_count,
        ${sessionActivitySql('aggregate.logical_session_id')} AS session_activity,
        ${activitySourceLabelSql('aggregate.logical_session_id')} AS activity_source_label,
        ${parentSessionSql('aggregate.logical_session_id')} AS parent_session_id,
        logical.installation_id,
        installation.product_id,
        logical.project_id,
        project.name AS project_name,
        logical.workspace_id,
        workspace.path AS workspace_path,
        logical.title,
        ${firstUserPayloadSql('aggregate.logical_session_id')} AS first_user_payload,
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
    )
    SELECT *
    FROM legacy_summary AS summary
    ${summaryFilter}
    ORDER BY summary.started_at DESC, summary.logical_session_id ASC
    LIMIT ?
  `
}

export function sessionSummaryProjectionSelectSql(summaryFilter: string): string {
  return `
    SELECT *
    FROM (
      SELECT
        summary.logical_session_id,
        summary.installation_id,
        summary.started_at,
        summary.ended_at,
        summary.observation_count,
        summary.user_message_count,
        summary.user_turn_count,
        summary.system_context_count,
        summary.internal_review_count,
        summary.other_event_count,
        summary.tool_count,
        summary.error_count,
        summary.first_user_payload,
        summary.leading_kind,
        summary.source_ids_json,
        summary.session_activity,
        summary.activity_source_label,
        summary.parent_session_id,
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
    ) AS summary
    ${summaryFilter}
    ORDER BY summary.started_at DESC, summary.logical_session_id ASC
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
      user_turn_count,
      system_context_count,
      internal_review_count,
      other_event_count,
      tool_count,
      error_count,
      first_user_payload,
      leading_kind,
      source_ids_json,
      session_activity,
      activity_source_label,
      parent_session_id,
      rebuilt_at
    )
    SELECT
      aggregate.logical_session_id,
      logical.installation_id,
      aggregate.started_at,
      aggregate.ended_at,
      aggregate.observation_count,
      aggregate.user_turn_count,
      aggregate.user_turn_count,
      aggregate.system_context_count,
      ${internalReviewCountSql('aggregate.logical_session_id')},
      MAX(0, aggregate.observation_count - aggregate.user_turn_count - aggregate.system_context_count - aggregate.tool_event_count),
      aggregate.tool_count,
      aggregate.error_count,
      ${firstUserPayloadSql('aggregate.logical_session_id')},
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
      ),
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
      ),
      ${sessionActivitySql('aggregate.logical_session_id')},
      ${activitySourceLabelSql('aggregate.logical_session_id')},
      ${parentSessionSql('aggregate.logical_session_id')},
      ? AS rebuilt_at
    FROM (
      SELECT
        logical_session_id,
        COALESCE(MIN(occurred_at), MIN(captured_at)) AS started_at,
        COALESCE(MAX(occurred_at), MAX(captured_at)) AS ended_at,
        COUNT(*) AS observation_count,
        SUM(CASE WHEN ${REAL_USER_SQL} THEN 1 ELSE 0 END) AS user_turn_count,
        SUM(CASE WHEN ${SYSTEM_CONTEXT_SQL} THEN 1 ELSE 0 END) AS system_context_count,
        SUM(CASE WHEN kind = 'tool.call' THEN 1 ELSE 0 END) AS tool_count,
        SUM(CASE WHEN kind LIKE 'tool.%' THEN 1 ELSE 0 END) AS tool_event_count,
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
      user_turn_count = excluded.user_turn_count,
      system_context_count = excluded.system_context_count,
      internal_review_count = excluded.internal_review_count,
      other_event_count = excluded.other_event_count,
      tool_count = excluded.tool_count,
      error_count = excluded.error_count,
      first_user_payload = excluded.first_user_payload,
      leading_kind = excluded.leading_kind,
      source_ids_json = excluded.source_ids_json,
      session_activity = excluded.session_activity,
      activity_source_label = excluded.activity_source_label,
      parent_session_id = excluded.parent_session_id,
      rebuilt_at = excluded.rebuilt_at
  `
}

function whereClause(conditions: string[]): string {
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
}

function summaryQueryWhere(input: SessionSummaryQuery): { sql: string; params: unknown[] } {
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
  if (input.sourceId) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(COALESCE(summary.source_ids_json, '[]')) AS source WHERE source.value = ?)")
    params.push(input.sourceId)
  }
  if (input.projectId) {
    conditions.push('summary.project_id = ?')
    params.push(input.projectId)
  }
  if (input.from) {
    conditions.push('summary.started_at >= ?')
    params.push(input.from)
  }
  if (input.to) {
    conditions.push('summary.started_at <= ?')
    params.push(input.to)
  }
  if (input.hasErrors === true) conditions.push('summary.error_count > 0')
  if (input.hasErrors === false) conditions.push('summary.error_count = 0')
  const search = input.search?.trim().toLowerCase()
  if (search) {
    conditions.push(`(
      LOWER(
        COALESCE(summary.title, '') || '\n' ||
        COALESCE(summary.project_name, '') || '\n' ||
        COALESCE(summary.workspace_path, '') || '\n' ||
        COALESCE(summary.first_user_payload, '') || '\n' ||
        COALESCE(summary.source_ids_json, '') || '\n' ||
        COALESCE(summary.activity_source_label, '')
      ) LIKE ?
      OR EXISTS (
        SELECT 1 FROM observations AS search_event
        WHERE search_event.logical_session_id = summary.logical_session_id
          AND LOWER(COALESCE(search_event.payload_json, '')) LIKE ?
      )
    )`)
    params.push(`%${search}%`, `%${search}%`)
  }
  if (input.after) {
    conditions.push('(summary.started_at < ? OR (summary.started_at = ? AND summary.logical_session_id > ?))')
    params.push(input.after.startedAt, input.after.startedAt, input.after.logicalSessionId)
  }
  return { sql: whereClause(conditions), params }
}

export class SqliteSessionSummaryReader implements SessionSummaryProjectionStore {
  private readonly rebuildBatchSize: number
  private readonly yieldControl: () => Promise<void>

  constructor(
    private readonly executor: SqliteExecutor,
    options: SqliteSessionSummaryReaderOptions = {},
  ) {
    this.rebuildBatchSize = Math.max(1, Math.floor(
      options.rebuildBatchSize ?? DEFAULT_REBUILD_BATCH_SIZE,
    ))
    this.yieldControl = options.yieldControl
      ?? (() => new Promise<void>(resolve => setImmediate(resolve)))
  }

  query(input: SessionSummaryQuery): Promise<{ items: SessionSummaryRecord[]; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(input.limit, MAX_LIMIT))
    return this.executor.run(() => {
      const projectionExists = Boolean(this.executor.db.prepare(
        'SELECT 1 FROM session_summary_projection LIMIT 1',
      ).get())
      const observationExists = projectionExists
        ? true
        : Boolean(this.executor.db.prepare('SELECT 1 FROM observations LIMIT 1').get())

      const summaryWhere = summaryQueryWhere(input)
      if (projectionExists || !observationExists) {
        const rows = this.executor.db.prepare(
          sessionSummaryProjectionSelectSql(summaryWhere.sql),
        ).all(...summaryWhere.params, limit + 1)

        if (rows.length || !input.logicalSessionId || !projectionExists) {
          return {
            items: rows.slice(0, limit).map(mapSummary),
            hasMore: rows.length > limit,
          }
        }

        const targetObservationExists = Boolean(this.executor.db.prepare(
          'SELECT 1 FROM observations WHERE logical_session_id = ? LIMIT 1',
        ).get(input.logicalSessionId))
        if (!targetObservationExists) return { items: [], hasMore: false }
      }

      const observationConditions: string[] = []
      const observationParams: unknown[] = []
      if (input.logicalSessionId) {
        observationConditions.push('logical_session_id = ?')
        observationParams.push(input.logicalSessionId)
      }
      if (input.installationId) {
        observationConditions.push('installation_id = ?')
        observationParams.push(input.installationId)
      }
      const rows = this.executor.db.prepare(
        legacyQuerySql(whereClause(observationConditions), summaryWhere.sql),
      ).all(...observationParams, ...summaryWhere.params, limit + 1)
      return {
        items: rows.slice(0, limit).map(mapSummary),
        hasMore: rows.length > limit,
      }
    })
  }

  async isMaterialized(): Promise<boolean> {
    return this.executor.run(() => {
      const observationExists = Boolean(this.executor.db.prepare(
        'SELECT 1 FROM observations LIMIT 1',
      ).get())
      if (!observationExists) return true
      return Boolean(this.executor.db.prepare(
        'SELECT 1 FROM session_summary_projection LIMIT 1',
      ).get())
    })
  }

  async rebuild(input: {
    logicalSessionId?: string
    strategy?: 'atomic' | 'cooperative'
    signal?: AbortSignal
  } = {}): Promise<void> {
    input.signal?.throwIfAborted()
    if (!input.logicalSessionId && input.strategy === 'cooperative') {
      await this.rebuildCooperatively(input.signal)
      return
    }

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

  private async rebuildCooperatively(signal?: AbortSignal): Promise<void> {
    const logicalSessionIds = await this.executor.run(() => (
      this.executor.db.prepare(`
        SELECT id
        FROM logical_sessions
        ORDER BY COALESCE(ended_at, started_at, '') DESC, id ASC
      `).all() as Array<{ id: string }>
    ).map(row => row.id))

    signal?.throwIfAborted()
    for (let offset = 0; offset < logicalSessionIds.length; offset += this.rebuildBatchSize) {
      const batch = logicalSessionIds.slice(offset, offset + this.rebuildBatchSize)
      await this.executor.transaction(async () => {
        const rebuiltAt = new Date().toISOString()
        const remove = this.executor.db.prepare(
          'DELETE FROM session_summary_projection WHERE logical_session_id = ?',
        )
        const insert = this.executor.db.prepare(rebuildInsertSql('WHERE logical_session_id = ?'))
        for (const logicalSessionId of batch) {
          remove.run(logicalSessionId)
          insert.run(rebuiltAt, logicalSessionId)
        }
      })

      signal?.throwIfAborted()
      if (offset + batch.length < logicalSessionIds.length) {
        await this.yieldControl()
        signal?.throwIfAborted()
      }
    }

    await this.executor.run(() => {
      this.executor.db.prepare(`
        DELETE FROM session_summary_projection
        WHERE NOT EXISTS (
          SELECT 1
          FROM logical_sessions
          WHERE logical_sessions.id = session_summary_projection.logical_session_id
        )
      `).run()
    })
  }
}

export const sessionSummaryInternals = {
  DEFAULT_REBUILD_BATCH_SIZE,
}
