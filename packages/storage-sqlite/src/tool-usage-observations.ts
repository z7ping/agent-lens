import type {
  ToolUsageAggregateAssetRecord,
  ToolUsageAggregateQuery,
  ToolUsageAggregateResult,
  ToolUsageAggregateToolRecord,
  ToolUsageObservationQuery,
  ToolUsageObservationReader,
  ToolUsageObservationRecord,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

const MAX_LIMIT = 5000
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER
const MAX_AGGREGATE_DETAIL_LIMIT = 500

function decodeJson(value: unknown): ToolUsageObservationRecord['payload'] {
  if (typeof value !== 'string' || value.length === 0) return null
  return JSON.parse(value) as ToolUsageObservationRecord['payload']
}

function decodeStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0).sort()
  } catch {
    return []
  }
}

function mapRow(row: any): ToolUsageObservationRecord {
  return {
    id: row.id,
    installationId: row.installation_id,
    logicalSessionId: row.logical_session_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    sourceId: row.source_id,
    productId: row.product_id,
    kind: row.kind,
    ...(row.source_sequence == null ? {} : { sourceSequence: Number(row.source_sequence) }),
    ...(row.canonical_sequence == null ? {} : { canonicalSequence: Number(row.canonical_sequence) }),
    ...(row.occurred_at == null ? {} : { occurredAt: row.occurred_at }),
    capturedAt: row.captured_at,
    payload: decodeJson(row.payload_json),
  }
}

function aggregateFilter(input: ToolUsageAggregateQuery): { conditions: string[]; params: unknown[] } {
  const conditions = ["o.kind IN ('tool.call', 'tool.result')"]
  const params: unknown[] = []
  if (input.installationId) {
    conditions.push('o.installation_id = ?')
    params.push(input.installationId)
  }
  if (input.logicalSessionId) {
    conditions.push('o.logical_session_id = ?')
    params.push(input.logicalSessionId)
  }
  if (input.projectId) {
    conditions.push('o.project_id = ?')
    params.push(input.projectId)
  }
  if (input.sourceId) {
    conditions.push('ss.source_id = ?')
    params.push(input.sourceId)
  }
  if (input.from) {
    conditions.push('COALESCE(o.occurred_at, o.captured_at) >= ?')
    params.push(input.from)
  }
  if (input.to) {
    conditions.push('COALESCE(o.occurred_at, o.captured_at) <= ?')
    params.push(input.to)
  }
  return { conditions, params }
}

// 先物化轻量事件与调用查找表，避免 SQLite 展开 JSON 表达式后对每条结果重扫调用。
function aggregateCtes(conditions: string[]): string {
  return `
    WITH events AS MATERIALIZED (
      SELECT
        o.id,
        o.logical_session_id,
        o.kind,
        COALESCE(o.occurred_at, o.captured_at) AS effective_at,
        ss.source_id,
        ai.product_id,
        COALESCE(
          CASE WHEN json_type(o.payload_json, '$.nativeToolName') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.nativeToolName'), '') END,
          CASE WHEN json_type(o.payload_json, '$.toolName') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.toolName'), '') END,
          CASE WHEN json_type(o.payload_json, '$.tool_name') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.tool_name'), '') END,
          CASE WHEN json_type(o.payload_json, '$.name') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.name'), '') END
        ) AS tool_name,
        COALESCE(
          CASE WHEN json_type(o.payload_json, '$.callId') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.callId'), '') END,
          CASE WHEN json_type(o.payload_json, '$.call_id') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.call_id'), '') END,
          CASE WHEN json_type(o.payload_json, '$.toolUseId') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.toolUseId'), '') END,
          CASE WHEN json_type(o.payload_json, '$.tool_use_id') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.tool_use_id'), '') END
        ) AS call_id,
        COALESCE(
          CASE WHEN json_type(o.payload_json, '$.input.skill') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.input.skill'), '') END,
          CASE WHEN json_type(o.payload_json, '$.input.name') = 'text' THEN NULLIF(json_extract(o.payload_json, '$.input.name'), '') END
        ) AS skill_name,
        CASE
          WHEN json_type(o.payload_json, '$.success') IN ('true', 'false', 'integer')
            THEN json_extract(o.payload_json, '$.success')
        END AS success,
        COALESCE(
          CASE WHEN json_type(o.payload_json, '$.durationMs') IN ('integer', 'real') THEN json_extract(o.payload_json, '$.durationMs') END,
          CASE WHEN json_type(o.payload_json, '$.duration_ms') IN ('integer', 'real') THEN json_extract(o.payload_json, '$.duration_ms') END
        ) AS duration_ms
      FROM observations AS o
      JOIN source_sessions AS ss ON ss.id = o.source_session_id
      JOIN agent_installations AS ai ON ai.id = o.installation_id
      WHERE ${conditions.join(' AND ')}
    ),
    calls AS (
      SELECT * FROM events
      WHERE kind = 'tool.call' AND tool_name IS NOT NULL
    ),
    call_lookup AS MATERIALIZED (
      SELECT * FROM (
        SELECT
          calls.*,
          ROW_NUMBER() OVER (
            PARTITION BY logical_session_id, call_id
            ORDER BY effective_at DESC, id DESC
          ) AS identity_rank
        FROM calls
        WHERE call_id IS NOT NULL
      )
      WHERE identity_rank = 1
    ),
    results AS (
      SELECT
        result.id,
        result.logical_session_id,
        result.kind,
        result.effective_at,
        COALESCE(linked.source_id, result.source_id) AS source_id,
        COALESCE(linked.product_id, result.product_id) AS product_id,
        COALESCE(result.tool_name, linked.tool_name) AS tool_name,
        result.call_id,
        NULL AS skill_name,
        result.success,
        result.duration_ms
      FROM events AS result
      LEFT JOIN call_lookup AS linked
        ON linked.logical_session_id = result.logical_session_id
       AND linked.call_id = result.call_id
      WHERE result.kind = 'tool.result'
        AND COALESCE(result.tool_name, linked.tool_name) IS NOT NULL
    ),
    tool_events AS (
      SELECT id, logical_session_id, kind, effective_at, source_id, product_id, tool_name, success, duration_ms
      FROM calls
      UNION ALL
      SELECT id, logical_session_id, kind, effective_at, source_id, product_id, tool_name, success, duration_ms
      FROM results
    ),
    asset_calls AS (
      SELECT
        calls.*,
        CASE
          WHEN lower(substr(tool_name, 1, 5)) = 'mcp__'
            AND instr(substr(tool_name, 6), '__') > 1
            AND length(substr(substr(tool_name, 6), instr(substr(tool_name, 6), '__') + 2)) > 0
            THEN 'mcp'
          WHEN lower(tool_name) = 'skill' AND skill_name IS NOT NULL
            THEN 'skill'
        END AS asset_type,
        CASE
          WHEN lower(substr(tool_name, 1, 5)) = 'mcp__'
            AND instr(substr(tool_name, 6), '__') > 1
            AND length(substr(substr(tool_name, 6), instr(substr(tool_name, 6), '__') + 2)) > 0
            THEN substr(tool_name, 6, instr(substr(tool_name, 6), '__') - 1)
          WHEN lower(tool_name) = 'skill' AND skill_name IS NOT NULL
            THEN skill_name
        END AS canonical_name
      FROM calls
    )
  `
}

export class SqliteToolUsageObservationReader implements ToolUsageObservationReader {
  constructor(private readonly executor: SqliteExecutor) {}

  query(input: ToolUsageObservationQuery): Promise<ToolUsageObservationRecord[]> {
    return this.executor.run(() => {
      const conditions = ['o.kind = ?']
      const params: unknown[] = [input.kind]

      if (input.installationId) {
        conditions.push('o.installation_id = ?')
        params.push(input.installationId)
      }
      if (input.logicalSessionId) {
        conditions.push('o.logical_session_id = ?')
        params.push(input.logicalSessionId)
      }
      if (input.projectId) {
        conditions.push('o.project_id = ?')
        params.push(input.projectId)
      }
      if (input.sourceId) {
        conditions.push('ss.source_id = ?')
        params.push(input.sourceId)
      }
      if (input.from) {
        conditions.push('COALESCE(o.occurred_at, o.captured_at) >= ?')
        params.push(input.from)
      }
      if (input.to) {
        conditions.push('COALESCE(o.occurred_at, o.captured_at) <= ?')
        params.push(input.to)
      }
      if (input.after) {
        const sequence = input.after.sequence ?? MAX_SEQUENCE
        conditions.push(`(
          COALESCE(o.occurred_at, o.captured_at) > ?
          OR (
            COALESCE(o.occurred_at, o.captured_at) = ?
            AND (
              COALESCE(o.canonical_sequence, o.source_sequence, ${MAX_SEQUENCE}) > ?
              OR (
                COALESCE(o.canonical_sequence, o.source_sequence, ${MAX_SEQUENCE}) = ?
                AND o.id > ?
              )
            )
          )
        )`)
        params.push(input.after.effectiveAt, input.after.effectiveAt, sequence, sequence, input.after.id)
      }

      const limit = Math.max(1, Math.min(input.limit ?? 1000, MAX_LIMIT))
      const rows = this.executor.db.prepare(`
        SELECT
          o.id,
          o.installation_id,
          o.logical_session_id,
          o.project_id,
          o.kind,
          o.source_sequence,
          o.canonical_sequence,
          o.occurred_at,
          o.captured_at,
          o.payload_json,
          ss.source_id,
          ai.product_id
        FROM observations AS o
        JOIN source_sessions AS ss ON ss.id = o.source_session_id
        JOIN agent_installations AS ai ON ai.id = o.installation_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY
          COALESCE(o.occurred_at, o.captured_at) ASC,
          COALESCE(o.canonical_sequence, o.source_sequence, ${MAX_SEQUENCE}) ASC,
          o.id ASC
        LIMIT ?
      `).all(...params, limit)

      return rows.map(mapRow)
    })
  }

  aggregate(input: ToolUsageAggregateQuery): Promise<ToolUsageAggregateResult> {
    return this.executor.run(() => {
      const detailLimit = Math.max(1, Math.min(input.detailLimit, MAX_AGGREGATE_DETAIL_LIMIT))
      const { conditions, params } = aggregateFilter(input)
      const ctes = aggregateCtes(conditions)

      const toolRows = this.executor.db.prepare(`${ctes}
        SELECT
          source_id,
          tool_name,
          json_group_array(DISTINCT product_id) AS product_ids_json,
          SUM(CASE WHEN kind = 'tool.call' THEN 1 ELSE 0 END) AS call_count,
          SUM(CASE WHEN kind = 'tool.result' THEN 1 ELSE 0 END) AS result_count,
          SUM(CASE WHEN kind = 'tool.result' AND success = 1 THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN kind = 'tool.result' AND success = 0 THEN 1 ELSE 0 END) AS error_count,
          COUNT(DISTINCT CASE WHEN kind = 'tool.call' THEN logical_session_id END) AS session_count,
          SUM(CASE WHEN kind = 'tool.result' AND duration_ms >= 0 THEN duration_ms ELSE 0 END) AS total_duration_ms,
          MIN(effective_at) AS first_used_at,
          MAX(effective_at) AS last_used_at
        FROM tool_events
        GROUP BY source_id, tool_name
      `).all(...params) as any[]

      const tools = new Map<string, ToolUsageAggregateToolRecord>()
      for (const row of toolRows) {
        const key = `${row.source_id}\u0000${row.tool_name}`
        tools.set(key, {
          nativeToolName: String(row.tool_name),
          sourceIds: [String(row.source_id)],
          productIds: decodeStringArray(row.product_ids_json),
          callCount: Number(row.call_count ?? 0),
          resultCount: Number(row.result_count ?? 0),
          successCount: Number(row.success_count ?? 0),
          errorCount: Number(row.error_count ?? 0),
          sessionCount: Number(row.session_count ?? 0),
          sessions: [],
          totalDurationMs: Number(row.total_duration_ms ?? 0),
          firstUsedAt: String(row.first_used_at),
          lastUsedAt: String(row.last_used_at),
          observationIds: [],
        })
      }

      const sessionRows = this.executor.db.prepare(`${ctes},
        session_counts AS (
          SELECT source_id, tool_name, logical_session_id,
            SUM(CASE WHEN kind = 'tool.call' THEN 1 ELSE 0 END) AS call_count,
            SUM(CASE WHEN kind = 'tool.result' AND success = 0 THEN 1 ELSE 0 END) AS error_count
          FROM tool_events
          GROUP BY source_id, tool_name, logical_session_id
          HAVING SUM(CASE WHEN kind = 'tool.call' THEN 1 ELSE 0 END) > 0
        ),
        ranked_sessions AS (
          SELECT
            session_counts.*,
            ROW_NUMBER() OVER (
              PARTITION BY source_id, tool_name
              ORDER BY call_count DESC, logical_session_id ASC
            ) AS detail_rank
          FROM session_counts
        )
        SELECT source_id, tool_name, logical_session_id, call_count, error_count
        FROM ranked_sessions
        WHERE detail_rank <= ?
        ORDER BY source_id, tool_name, detail_rank
      `).all(...params, detailLimit) as any[]
      for (const row of sessionRows) {
        tools.get(`${row.source_id}\u0000${row.tool_name}`)?.sessions.push({
          logicalSessionId: String(row.logical_session_id),
          callCount: Number(row.call_count ?? 0),
          errorCount: Number(row.error_count ?? 0),
        })
      }

      const toolObservationRows = this.executor.db.prepare(`${ctes},
        ranked_observations AS (
          SELECT
            source_id,
            tool_name,
            id,
            ROW_NUMBER() OVER (
              PARTITION BY source_id, tool_name
              ORDER BY CASE WHEN kind = 'tool.call' THEN 0 ELSE 1 END, effective_at ASC, id ASC
            ) AS detail_rank
          FROM tool_events
        )
        SELECT source_id, tool_name, id
        FROM ranked_observations
        WHERE detail_rank <= ?
        ORDER BY source_id, tool_name, detail_rank
      `).all(...params, detailLimit) as any[]
      for (const row of toolObservationRows) {
        tools.get(`${row.source_id}\u0000${row.tool_name}`)?.observationIds.push(String(row.id))
      }

      const assetRows = this.executor.db.prepare(`${ctes}
        SELECT
          asset_type,
          canonical_name,
          json_group_array(DISTINCT source_id) AS source_ids_json,
          COUNT(*) AS call_count,
          MIN(effective_at) AS first_used_at,
          MAX(effective_at) AS last_used_at
        FROM asset_calls
        WHERE asset_type IS NOT NULL AND canonical_name IS NOT NULL
        GROUP BY asset_type, canonical_name
      `).all(...params) as any[]

      const assets = new Map<string, ToolUsageAggregateAssetRecord>()
      for (const row of assetRows) {
        const key = `${row.asset_type}\u0000${row.canonical_name}`
        assets.set(key, {
          type: row.asset_type === 'skill' ? 'skill' : 'mcp',
          canonicalName: String(row.canonical_name),
          sourceIds: decodeStringArray(row.source_ids_json),
          callCount: Number(row.call_count ?? 0),
          firstUsedAt: String(row.first_used_at),
          lastUsedAt: String(row.last_used_at),
          observationIds: [],
        })
      }

      const assetObservationRows = this.executor.db.prepare(`${ctes},
        ranked_asset_observations AS (
          SELECT
            asset_type,
            canonical_name,
            id,
            ROW_NUMBER() OVER (
              PARTITION BY asset_type, canonical_name
              ORDER BY effective_at ASC, id ASC
            ) AS detail_rank
          FROM asset_calls
          WHERE asset_type IS NOT NULL AND canonical_name IS NOT NULL
        )
        SELECT asset_type, canonical_name, id
        FROM ranked_asset_observations
        WHERE detail_rank <= ?
        ORDER BY asset_type, canonical_name, detail_rank
      `).all(...params, detailLimit) as any[]
      for (const row of assetObservationRows) {
        assets.get(`${row.asset_type}\u0000${row.canonical_name}`)?.observationIds.push(String(row.id))
      }

      const unattributed = this.executor.db.prepare(`${ctes}
        SELECT COUNT(*) AS count
        FROM asset_calls
        WHERE asset_type IS NULL OR canonical_name IS NULL
      `).get(...params) as { count?: number } | undefined

      return {
        tools: [...tools.values()],
        assets: [...assets.values()],
        unattributedToolCalls: Number(unattributed?.count ?? 0),
      }
    })
  }
}
