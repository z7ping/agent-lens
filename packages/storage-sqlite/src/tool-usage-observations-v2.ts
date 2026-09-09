import type {
  ToolUsageAggregateQuery,
  ToolUsageAggregateResult,
  ToolUsageAggregateSession,
  ToolUsageObservationQuery,
  ToolUsageObservationReader,
  ToolUsageObservationRecord,
  ToolUsageWorkflowPatternQuery,
  ToolUsageWorkflowPatternRecord,
} from '@agent-lens/core'
import { toolUsageWorkflowCategory } from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import { SqliteToolUsageFactReader as BaseToolUsageObservationReader } from './tool-usage-facts'

const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER
const METADATA_CHUNK = 300

type SessionMetadata = Pick<ToolUsageAggregateSession, 'title' | 'projectName' | 'workspacePath' | 'endedAt'>
type SessionMetadataRow = Record<string, unknown>

function rowRecord(value: unknown): SessionMetadataRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite tool usage session metadata query returned a non-object row')
  }
  return value as SessionMetadataRow
}
function requiredString(row: SessionMetadataRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`SQLite tool usage session metadata field ${key} must be a string`)
  return value
}

function optionalString(row: SessionMetadataRow, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`SQLite tool usage session metadata field ${key} must be a string or null`)
  return value
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
    `).all(...batch).map(rowRecord)

    for (const row of rows) {
      const title = optionalString(row, 'title')
      const projectName = optionalString(row, 'project_name')
      const workspacePath = optionalString(row, 'workspace_path')
      const endedAt = optionalString(row, 'ended_at')
      result.set(requiredString(row, 'logical_session_id'), {
        ...(title === undefined ? {} : { title }),
        ...(projectName === undefined ? {} : { projectName }),
        ...(workspacePath === undefined ? {} : { workspacePath }),
        ...(endedAt === undefined ? {} : { endedAt }),
      })
    }
  }
  return result
}

interface WorkflowAccumulator {
  key: string
  steps: string[]
  sessionCount: number
  occurrenceCount: number
  sampleSessionIds: string[]
  observationIds: string[]
}

function workflowPatterns(executor: SqliteExecutor, input: ToolUsageWorkflowPatternQuery): ToolUsageWorkflowPatternRecord[] {
  const minimumSessions = Math.max(1, Math.floor(input.minimumSessions))
  const patternLimit = Math.max(0, Math.min(Math.floor(input.patternLimit), 100))
  const sessionSampleLimit = Math.max(0, Math.min(Math.floor(input.sessionSampleLimit), 100))
  const observationSampleLimit = Math.max(0, Math.min(Math.floor(input.observationSampleLimit), 500))
  if (patternLimit === 0) return []

  const conditions = ["fact.kind = 'tool.call'"]
  const params: unknown[] = []
  if (input.sourceIds?.length) {
    conditions.push(`fact.source_id IN (${input.sourceIds.map(() => '?').join(', ')})`)
    params.push(...input.sourceIds)
  } else if (input.sourceId) {
    conditions.push('fact.source_id = ?')
    params.push(input.sourceId)
  }
  if (input.projectId) {
    conditions.push('fact.project_id = ?')
    params.push(input.projectId)
  }
  if (input.from) {
    conditions.push('fact.effective_at >= ?')
    params.push(input.from)
  }
  if (input.to) {
    conditions.push('fact.effective_at <= ?')
    params.push(input.to)
  }

  const statement = executor.db.prepare(`
    SELECT
      fact.observation_id,
      fact.logical_session_id,
      fact.tool_name
    FROM tool_usage_fact_projection AS fact
    JOIN observations AS observation ON observation.id = fact.observation_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      fact.logical_session_id ASC,
      fact.effective_at ASC,
      COALESCE(observation.canonical_sequence, observation.source_sequence, ${MAX_SEQUENCE}) ASC,
      fact.observation_id ASC
  `)

  const patterns = new Map<string, WorkflowAccumulator>()
  let sessionId = ''
  let normalized: Array<{ category: string; observationId: string }> = []

  const flushSession = () => {
    if (!sessionId || normalized.length < 2) {
      normalized = []
      return
    }
    const seenInSession = new Set<string>()
    for (const length of [2, 3]) {
      for (let index = 0; index + length <= normalized.length; index += 1) {
        const window = normalized.slice(index, index + length)
        const steps = window.map(item => item.category)
        const key = steps.join(' → ')
        let pattern = patterns.get(key)
        if (!pattern) {
          pattern = {
            key,
            steps,
            sessionCount: 0,
            occurrenceCount: 0,
            sampleSessionIds: [],
            observationIds: [],
          }
          patterns.set(key, pattern)
        }
        pattern.occurrenceCount += 1
        if (!seenInSession.has(key)) {
          seenInSession.add(key)
          pattern.sessionCount += 1
          if (pattern.sampleSessionIds.length < sessionSampleLimit) pattern.sampleSessionIds.push(sessionId)
        }
        for (const item of window) {
          if (pattern.observationIds.length >= observationSampleLimit) break
          if (!pattern.observationIds.includes(item.observationId)) pattern.observationIds.push(item.observationId)
        }
      }
    }
    normalized = []
  }

  for (const value of statement.iterate(...params)) {
    const row = rowRecord(value)
    const rowSessionId = requiredString(row, 'logical_session_id')
    if (sessionId && rowSessionId !== sessionId) flushSession()
    sessionId = rowSessionId
    const category = toolUsageWorkflowCategory(optionalString(row, 'tool_name') ?? 'unknown')
    if (normalized.at(-1)?.category === category) continue
    normalized.push({ category, observationId: requiredString(row, 'observation_id') })
  }
  flushSession()

  return [...patterns.values()]
    .filter(item => item.sessionCount >= minimumSessions)
    .sort((a, b) => b.sessionCount - a.sessionCount
      || b.occurrenceCount - a.occurrenceCount
      || a.key.localeCompare(b.key))
    .slice(0, patternLimit)
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

  aggregateAssetsBySource(input: ToolUsageAggregateQuery) {
    return this.base.aggregateAssetsBySource(input)
  }

  workflowPatterns(input: ToolUsageWorkflowPatternQuery): Promise<ToolUsageWorkflowPatternRecord[]> {
    return this.executor.run(() => workflowPatterns(this.executor, input))
  }
}
