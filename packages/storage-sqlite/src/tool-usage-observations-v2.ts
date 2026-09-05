import type {
  ToolUsageAggregateQuery,
  ToolUsageAggregateResult,
  ToolUsageAggregateSession,
  ToolUsageObservationQuery,
  ToolUsageObservationReader,
  ToolUsageObservationRecord,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import { SqliteToolUsageObservationReader as BaseToolUsageObservationReader } from './tool-usage-observations'

const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER
const METADATA_CHUNK = 300
const ERROR_DETAIL_CHUNK = 120

type SessionMetadata = Pick<ToolUsageAggregateSession, 'title' | 'projectName' | 'workspacePath' | 'endedAt'>

function toolNameSql(alias: string): string {
  return `COALESCE(
    CASE WHEN json_type(${alias}.payload_json, '$.nativeToolName') = 'text' THEN NULLIF(json_extract(${alias}.payload_json, '$.nativeToolName'), '') END,
    CASE WHEN json_type(${alias}.payload_json, '$.toolName') = 'text' THEN NULLIF(json_extract(${alias}.payload_json, '$.toolName'), '') END,
    CASE WHEN json_type(${alias}.payload_json, '$.tool_name') = 'text' THEN NULLIF(json_extract(${alias}.payload_json, '$.tool_name'), '') END,
    CASE WHEN json_type(${alias}.payload_json, '$.name') = 'text' THEN NULLIF(json_extract(${alias}.payload_json, '$.name'), '') END
  )`
}

function callIdSql(alias: string): string {
  return `COALESCE(
    CASE WHEN json_type(${alias}.payload_json, '$.callId') = 'text' THEN NULLIF(json_extract(${alias}.payload_json, '$.callId'), '') END,
    CASE WHEN json_type(${alias}.payload_json, '$.call_id') = 'text' THEN NULLIF(json_extract(${alias}.payload_json, '$.call_id'), '') END,
    CASE WHEN json_type(${alias}.payload_json, '$.toolUseId') = 'text' THEN NULLIF(json_extract(${alias}.payload_json, '$.toolUseId'), '') END,
    CASE WHEN json_type(${alias}.payload_json, '$.tool_use_id') = 'text' THEN NULLIF(json_extract(${alias}.payload_json, '$.tool_use_id'), '') END
  )`
}

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

interface WantedSession {
  sourceId: string
  toolName: string
  logicalSessionId: string
}

function sessionErrors(executor: SqliteExecutor, wanted: WantedSession[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const batch of chunks(wanted, ERROR_DETAIL_CHUNK)) {
    if (!batch.length) continue
    const values = batch.map(() => '(?, ?, ?)').join(', ')
    const params = batch.flatMap(item => [item.sourceId, item.toolName, item.logicalSessionId])
    const rows = executor.db.prepare(`
      WITH wanted(source_id, tool_name, logical_session_id) AS (VALUES ${values})
      SELECT
        wanted.source_id,
        wanted.tool_name,
        wanted.logical_session_id,
        (
          SELECT COUNT(*)
          FROM observations AS result
          JOIN source_sessions AS result_source ON result_source.id = result.source_session_id
          WHERE result.logical_session_id = wanted.logical_session_id
            AND result.kind = 'tool.result'
            AND json_extract(result.payload_json, '$.success') = 0
            AND (
              (${toolNameSql('result')} = wanted.tool_name AND result_source.source_id = wanted.source_id)
              OR (
                ${callIdSql('result')} IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM observations AS call
                  JOIN source_sessions AS call_source ON call_source.id = call.source_session_id
                  WHERE call.logical_session_id = result.logical_session_id
                    AND call.kind = 'tool.call'
                    AND call_source.source_id = wanted.source_id
                    AND ${callIdSql('call')} = ${callIdSql('result')}
                    AND ${toolNameSql('call')} = wanted.tool_name
                )
              )
            )
        ) AS error_count
      FROM wanted
    `).all(...params) as Array<{
      source_id: string
      tool_name: string
      logical_session_id: string
      error_count: number
    }>
    for (const row of rows) {
      result.set(`${row.source_id}\u0000${row.tool_name}\u0000${row.logical_session_id}`, Number(row.error_count || 0))
    }
  }
  return result
}

/**
 * 在已聚合、已限量的会话样本上补下钻元数据。
 * 聚合主体仍由 Base reader 在 SQLite 中完成，不把完整 tool.call/result 历史搬回 Node。
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
    const wanted: WantedSession[] = []
    const sessionIds: string[] = []
    for (const tool of aggregate.tools) {
      const sourceId = tool.sourceIds[0]
      if (!sourceId) continue
      for (const session of tool.sessions) {
        wanted.push({ sourceId, toolName: tool.nativeToolName, logicalSessionId: session.logicalSessionId })
        sessionIds.push(session.logicalSessionId)
      }
    }
    if (!wanted.length) return aggregate

    const metadata = await this.executor.run(() => sessionMetadata(this.executor, sessionIds))
    const errors = await this.executor.run(() => sessionErrors(this.executor, wanted))
    return {
      ...aggregate,
      tools: aggregate.tools.map(tool => {
        const sourceId = tool.sourceIds[0] ?? ''
        return {
          ...tool,
          sessions: tool.sessions.map(session => ({
            ...session,
            ...metadata.get(session.logicalSessionId),
            errorCount: errors.get(`${sourceId}\u0000${tool.nativeToolName}\u0000${session.logicalSessionId}`) ?? 0,
          })),
        }
      }),
    }
  }
}

export const toolUsageObservationV2Internals = {
  sessionMetadata,
  sessionErrors,
}
