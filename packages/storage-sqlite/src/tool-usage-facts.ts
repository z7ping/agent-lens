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
import { SqliteToolUsageObservationReader as LegacyToolUsageObservationReader } from './tool-usage-observations'

const MAX_AGGREGATE_DETAIL_LIMIT = 500

function aggregateFilter(input: ToolUsageAggregateQuery): { conditions: string[]; params: unknown[] } {
  const conditions = ["f.kind IN ('tool.call', 'tool.result')"]
  const params: unknown[] = []
  if (input.installationId) {
    conditions.push('f.installation_id = ?')
    params.push(input.installationId)
  }
  if (input.logicalSessionId) {
    conditions.push('f.logical_session_id = ?')
    params.push(input.logicalSessionId)
  }
  if (input.projectId) {
    conditions.push('f.project_id = ?')
    params.push(input.projectId)
  }
  if (input.sourceId) {
    conditions.push('f.source_id = ?')
    params.push(input.sourceId)
  }
  if (input.from) {
    conditions.push('f.effective_at >= ?')
    params.push(input.from)
  }
  if (input.to) {
    conditions.push('f.effective_at <= ?')
    params.push(input.to)
  }
  return { conditions, params }
}

function aggregateCtes(conditions: string[]): string {
  return `
    WITH events AS MATERIALIZED (
      SELECT
        f.observation_id AS id,
        f.logical_session_id,
        f.kind,
        f.effective_at,
        f.source_id,
        f.product_id,
        f.tool_name,
        f.call_id,
        f.skill_name,
        f.success,
        f.duration_ms
      FROM tool_usage_fact_projection AS f
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
    tool_events AS MATERIALIZED (
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

export class SqliteToolUsageFactReader implements ToolUsageObservationReader {
  private readonly legacy: LegacyToolUsageObservationReader

  constructor(private readonly executor: SqliteExecutor) {
    this.legacy = new LegacyToolUsageObservationReader(executor)
  }

  query(input: ToolUsageObservationQuery): Promise<ToolUsageObservationRecord[]> {
    return this.legacy.query(input)
  }

  aggregate(input: ToolUsageAggregateQuery): Promise<ToolUsageAggregateResult> {
    return this.executor.run(() => {
      const detailLimit = Math.max(1, Math.min(input.detailLimit, MAX_AGGREGATE_DETAIL_LIMIT))
      const { conditions, params } = aggregateFilter(input)
      const ctes = aggregateCtes(conditions)
      const rows = this.executor.db.prepare(`${ctes},
        tool_totals AS (
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
        ),
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
        ),
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
        ),
        asset_totals AS (
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
        ),
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
        ),
        aggregate_rows(category_rank, row_kind, group_key, item_key, detail_rank, payload_json) AS (
          SELECT 0, 'tool', source_id, tool_name, 0, json_object(
            'sourceId', source_id,
            'toolName', tool_name,
            'productIds', json(product_ids_json),
            'callCount', call_count,
            'resultCount', result_count,
            'successCount', success_count,
            'errorCount', error_count,
            'sessionCount', session_count,
            'totalDurationMs', total_duration_ms,
            'firstUsedAt', first_used_at,
            'lastUsedAt', last_used_at
          ) FROM tool_totals
          UNION ALL
          SELECT 1, 'session', source_id, tool_name, detail_rank, json_object(
            'sourceId', source_id,
            'toolName', tool_name,
            'logicalSessionId', logical_session_id,
            'callCount', call_count,
            'errorCount', error_count
          ) FROM ranked_sessions WHERE detail_rank <= ?
          UNION ALL
          SELECT 2, 'tool_observation', source_id, tool_name, detail_rank, json_object(
            'sourceId', source_id,
            'toolName', tool_name,
            'id', id
          ) FROM ranked_observations WHERE detail_rank <= ?
          UNION ALL
          SELECT 3, 'asset', asset_type, canonical_name, 0, json_object(
            'assetType', asset_type,
            'canonicalName', canonical_name,
            'sourceIds', json(source_ids_json),
            'callCount', call_count,
            'firstUsedAt', first_used_at,
            'lastUsedAt', last_used_at
          ) FROM asset_totals
          UNION ALL
          SELECT 4, 'asset_observation', asset_type, canonical_name, detail_rank, json_object(
            'assetType', asset_type,
            'canonicalName', canonical_name,
            'id', id
          ) FROM ranked_asset_observations WHERE detail_rank <= ?
          UNION ALL
          SELECT 5, 'unattributed', '', '', 0, json_object('count', COUNT(*))
          FROM asset_calls
          WHERE asset_type IS NULL OR canonical_name IS NULL
        )
        SELECT row_kind, payload_json
        FROM aggregate_rows
        ORDER BY category_rank, group_key, item_key, detail_rank
      `).all(...params, detailLimit, detailLimit, detailLimit) as Array<{
        row_kind: 'tool' | 'session' | 'tool_observation' | 'asset' | 'asset_observation' | 'unattributed'
        payload_json: string
      }>

      const tools = new Map<string, ToolUsageAggregateToolRecord>()
      const assets = new Map<string, ToolUsageAggregateAssetRecord>()
      let unattributedToolCalls = 0
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>
        if (row.row_kind === 'tool') {
          const sourceId = String(payload.sourceId)
          const toolName = String(payload.toolName)
          tools.set(`${sourceId}\u0000${toolName}`, {
            nativeToolName: toolName,
            sourceIds: [sourceId],
            productIds: Array.isArray(payload.productIds)
              ? payload.productIds.filter((item): item is string => typeof item === 'string').sort()
              : [],
            callCount: Number(payload.callCount ?? 0),
            resultCount: Number(payload.resultCount ?? 0),
            successCount: Number(payload.successCount ?? 0),
            errorCount: Number(payload.errorCount ?? 0),
            sessionCount: Number(payload.sessionCount ?? 0),
            sessions: [],
            totalDurationMs: Number(payload.totalDurationMs ?? 0),
            firstUsedAt: String(payload.firstUsedAt),
            lastUsedAt: String(payload.lastUsedAt),
            observationIds: [],
          })
        } else if (row.row_kind === 'session') {
          tools.get(`${payload.sourceId}\u0000${payload.toolName}`)?.sessions.push({
            logicalSessionId: String(payload.logicalSessionId),
            callCount: Number(payload.callCount ?? 0),
            errorCount: Number(payload.errorCount ?? 0),
          })
        } else if (row.row_kind === 'tool_observation') {
          tools.get(`${payload.sourceId}\u0000${payload.toolName}`)?.observationIds.push(String(payload.id))
        } else if (row.row_kind === 'asset') {
          const assetType = String(payload.assetType)
          const canonicalName = String(payload.canonicalName)
          assets.set(`${assetType}\u0000${canonicalName}`, {
            type: assetType === 'skill' ? 'skill' : 'mcp',
            canonicalName,
            sourceIds: Array.isArray(payload.sourceIds)
              ? payload.sourceIds.filter((item): item is string => typeof item === 'string').sort()
              : [],
            callCount: Number(payload.callCount ?? 0),
            firstUsedAt: String(payload.firstUsedAt),
            lastUsedAt: String(payload.lastUsedAt),
            observationIds: [],
          })
        } else if (row.row_kind === 'asset_observation') {
          assets.get(`${payload.assetType}\u0000${payload.canonicalName}`)?.observationIds.push(String(payload.id))
        } else {
          unattributedToolCalls = Number(payload.count ?? 0)
        }
      }

      return {
        tools: [...tools.values()],
        assets: [...assets.values()],
        unattributedToolCalls,
      }
    })
  }
}

export const toolUsageFactInternals = {
  aggregateFilter,
  aggregateCtes,
}
