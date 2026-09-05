import type {
  ToolUsageAggregateQuery,
  ToolUsageAggregateResult,
  ToolUsageAggregateSession,
  ToolUsageObservationQuery,
  ToolUsageObservationReader,
  ToolUsageObservationRecord,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import { SqliteToolUsageFactReader as BaseToolUsageObservationReader } from './tool-usage-facts'

const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER
const METADATA_CHUNK = 300

type SessionMetadata = Pick<ToolUsageAggregateSession, 'title' | 'projectName' | 'workspacePath' | 'endedAt'>

function codexRealUserSql(alias: string): string {
  return `
    ${alias}.kind = 'message.user'
    AND (
      (
        json_extract(${alias}.payload_json, '$.provenance.actualAuthor') IS NOT NULL
        OR json_extract(${alias}.payload_json, '$.provenance.contentRole') IS NOT NULL
      )
      AND json_extract(${alias}.payload_json, '$.provenance.actualAuthor') = 'human-user'
      AND json_extract(${alias}.payload_json, '$.provenance.contentRole') = 'user-request'
      OR (
        json_extract(${alias}.payload_json, '$.provenance.actualAuthor') IS NULL
        AND json_extract(${alias}.payload_json, '$.provenance.contentRole') IS NULL
        AND (
          NOT EXISTS (
            SELECT 1
            FROM observation_evidence legacy_link
            JOIN evidence legacy_evidence ON legacy_evidence.id = legacy_link.evidence_id
            JOIN source_records legacy_record ON legacy_record.id = legacy_evidence.source_record_id
            WHERE legacy_link.observation_id = ${alias}.id
              AND legacy_record.source_id = 'codex'
          )
          OR EXISTS (
            SELECT 1
            FROM observation_evidence authoritative_link
            JOIN evidence authoritative_evidence ON authoritative_evidence.id = authoritative_link.evidence_id
            JOIN source_records authoritative_record ON authoritative_record.id = authoritative_evidence.source_record_id
            WHERE authoritative_link.observation_id = ${alias}.id
              AND authoritative_record.source_id = 'codex'
              AND authoritative_record.native_type = 'event_msg/user_message'
          )
        )
      )
    )
  `
}

function legacyRealUserSql(alias: string): string {
  return `
    ${alias}.kind = 'message.user'
    AND COALESCE(json_extract(${alias}.payload_json, '$.provenance.actualAuthor'), 'human-user') = 'human-user'
    AND COALESCE(json_extract(${alias}.payload_json, '$.provenance.contentRole'), 'user-request') = 'user-request'
  `
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

function sessionMetadata(executor: SqliteExecutor, sessionIds: string[]): Map<string, SessionMetadata> {
  const result = new Map<string, SessionMetadata>()
  for (const batch of chunks([...new Set(sessionIds)], METADATA_CHUNK)) {
    if (!batch.length) continue
    const placeholders = batch.map(() => '?').join(', ')
    const rows = executor.db.prepare(`
      SELECT
        logical.id AS logical_session_id,
        project.name AS project_name,
        workspace.path AS workspace_path,
        COALESCE(summary.ended_at, logical.ended_at, logical.started_at) AS ended_at,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM source_sessions source
            WHERE source.logical_session_id = logical.id AND source.source_id = 'codex'
          ) THEN COALESCE(
            (
              SELECT json_extract(user.payload_json, '$.text')
              FROM observations AS user
              JOIN source_sessions AS user_source ON user_source.id = user.source_session_id
              WHERE user.logical_session_id = logical.id
                AND user_source.source_id = 'codex'
                AND ${codexRealUserSql('user')}
              ORDER BY
                COALESCE(user.occurred_at, user.captured_at) ASC,
                COALESCE(user.canonical_sequence, user.source_sequence, ${MAX_SEQUENCE}) ASC,
                user.id ASC
              LIMIT 1
            ),
            NULLIF(logical.title, '')
          )
          ELSE COALESCE(
            NULLIF(logical.title, ''),
            (
              SELECT json_extract(user.payload_json, '$.text')
              FROM observations AS user
              WHERE user.logical_session_id = logical.id
                AND ${legacyRealUserSql('user')}
              ORDER BY
                COALESCE(user.occurred_at, user.captured_at) ASC,
                COALESCE(user.canonical_sequence, user.source_sequence, ${MAX_SEQUENCE}) ASC,
                user.id ASC
              LIMIT 1
            )
          )
        END AS title
      FROM logical_sessions AS logical
      LEFT JOIN projects AS project ON project.id = logical.project_id
      LEFT JOIN workspaces AS workspace ON workspace.id = logical.workspace_id
      LEFT JOIN session_summary_projection AS summary ON summary.logical_session_id = logical.id
      WHERE logical.id IN (${placeholders})
    `).all(...batch) as Array<{
      logical_session_id: string
      title?: string | null
      project_name?: string | null
      workspace_path?: string | null
      ended_at?: string | null
    }>

    for (const row of rows) {
      result.set(row.logical_session_id, {
        ...(row.title ? { title: row.title } : {}),
        ...(row.project_name ? { projectName: row.project_name } : {}),
        ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
        ...(row.ended_at ? { endedAt: row.ended_at } : {}),
      })
    }
  }
  return result
}

/**
 * 聚合主体从 tool_usage_fact_projection 读取轻量字段；只有已限量的会话样本
 * 再回到 Canonical 数据补标题/项目等下钻元数据。
 */
export class SqliteToolUsageObservationReader implements ToolUsageObservationReader {
  private readonly base: BaseToolUsageObservationReader

  constructor(private readonly executor: SqliteExecutor) {
    this.base = new BaseToolUsageObservationReader(executor)
  }

  query(input: ToolUsageObservationQuery): Promise<ToolUsageObservationRecord[]> {
    return this.base.query(input)
  }

  async aggregate(input: ToolUsageAggregateQuery): Promise<ToolUsageAggregateResult> {
    const aggregate = await this.base.aggregate(input)
    const sessionIds: string[] = []
    for (const tool of aggregate.tools) {
      const sourceId = tool.sourceIds[0]
      if (!sourceId) continue
      for (const session of tool.sessions) sessionIds.push(session.logicalSessionId)
    }
    if (!sessionIds.length) return aggregate

    const metadata = await this.executor.run(() => sessionMetadata(this.executor, sessionIds))
    return {
      ...aggregate,
      tools: aggregate.tools.map(tool => ({
        ...tool,
        sessions: tool.sessions.map(session => ({
          ...session,
          ...metadata.get(session.logicalSessionId),
        })),
      })),
    }
  }
}

export const toolUsageObservationV2Internals = {
  sessionMetadata,
}
