import type {
  JsonValue,
  SessionSummaryProjectionStore,
  SessionSummaryQuery,
  SessionSummaryRecord,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import {
  SqliteSessionSummaryReader as BaseSessionSummaryReader,
  type SqliteSessionSummaryReaderOptions,
} from './session-summaries'

const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER

function relatedParent(executor: SqliteExecutor, logicalSessionId: string): string | undefined {
  const row = executor.db.prepare(`
    SELECT relation.from_session_id AS parent_session_id
    FROM session_relationships relation
    WHERE relation.to_session_id = ?
      AND relation.type IN ('task-root', 'internal-review', 'subagent', 'branch-task', 'fork', 'related')
    ORDER BY CASE relation.type
      WHEN 'task-root' THEN 0
      WHEN 'internal-review' THEN 1
      WHEN 'subagent' THEN 2
      WHEN 'branch-task' THEN 3
      WHEN 'fork' THEN 4
      ELSE 5 END,
      relation.id
    LIMIT 1
  `).get(logicalSessionId) as { parent_session_id?: string } | undefined
  return row?.parent_session_id
}

function internalReviewCount(executor: SqliteExecutor, logicalSessionId: string): number {
  const row = executor.db.prepare(`
    SELECT COUNT(DISTINCT relation.to_session_id) AS count
    FROM session_relationships relation
    WHERE relation.from_session_id = ?
      AND (
        relation.type = 'internal-review'
        OR EXISTS (
          SELECT 1
          FROM observations child_activity
          WHERE child_activity.logical_session_id = relation.to_session_id
            AND child_activity.kind = 'session.lifecycle'
            AND json_extract(child_activity.payload_json, '$.sessionActivity') = 'internal-review'
        )
      )
  `).get(logicalSessionId) as { count: number }
  return Number(row.count || 0)
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

function decodePayload(value: unknown): JsonValue | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return undefined
  }
}

function payloadText(value: JsonValue | undefined): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const text = (value as Record<string, JsonValue>).text
  return typeof text === 'string' && text.trim() ? text.trim() : undefined
}

function correctCodexSummaries(executor: SqliteExecutor, items: SessionSummaryRecord[]): SessionSummaryRecord[] {
  const codexItems = items.filter(item => item.sourceIds.includes('codex'))
  if (!codexItems.length) return items

  const placeholders = codexItems.map(() => '?').join(', ')
  const rows = executor.db.prepare(`
    SELECT
      logical.id AS logical_session_id,
      logical.title AS native_title,
      (
        SELECT COUNT(*)
        FROM observations AS user_observation
        JOIN source_sessions AS user_source ON user_source.id = user_observation.source_session_id
        WHERE user_observation.logical_session_id = logical.id
          AND user_source.source_id = 'codex'
          AND ${codexRealUserSql('user_observation')}
      ) AS user_turn_count,
      (
        SELECT first_user.payload_json
        FROM observations AS first_user
        JOIN source_sessions AS first_source ON first_source.id = first_user.source_session_id
        WHERE first_user.logical_session_id = logical.id
          AND first_source.source_id = 'codex'
          AND ${codexRealUserSql('first_user')}
        ORDER BY
          COALESCE(first_user.occurred_at, first_user.captured_at) ASC,
          COALESCE(first_user.canonical_sequence, first_user.source_sequence, ${MAX_SEQUENCE}) ASC,
          first_user.id ASC
        LIMIT 1
      ) AS first_user_payload
    FROM logical_sessions AS logical
    WHERE logical.id IN (${placeholders})
  `).all(...codexItems.map(item => item.logicalSessionId)) as Array<{
    logical_session_id: string
    native_title?: string | null
    user_turn_count: number
    first_user_payload?: string | null
  }>
  const byId = new Map(rows.map(row => [row.logical_session_id, row]))

  return items.map(item => {
    if (!item.sourceIds.includes('codex')) return item
    const row = byId.get(item.logicalSessionId)
    if (!row) return item
    const firstUserPayload = decodePayload(row.first_user_payload)
    const strictUserTurns = Number(row.user_turn_count || 0)
    const nativeTitle = typeof row.native_title === 'string' && row.native_title.trim() ? row.native_title.trim() : undefined
    const title = nativeTitle ?? payloadText(firstUserPayload)
    const { firstUserPayload: _legacyFirstUser, title: _legacyTitle, ...rest } = item
    const sessionActivity = item.sessionActivity && item.sessionActivity !== 'user-task'
      ? item.sessionActivity
      : strictUserTurns === 0 && (item.systemContextCount ?? 0) > 0
        ? 'system-activity'
        : item.sessionActivity

    return {
      ...rest,
      ...(title ? { title } : {}),
      ...(firstUserPayload === undefined ? {} : { firstUserPayload }),
      interactionCount: strictUserTurns,
      userTurnCount: strictUserTurns,
      ...(sessionActivity ? { sessionActivity } : {}),
    }
  })
}

/**
 * Session Summary V2 在旧物化结构之上补根任务关系语义，并用 SourceRecord / Evidence
 * 校正 Codex 旧数据里的真人消息身份。页面层不根据正文关键词猜测消息来源。
 */
export class SqliteSessionSummaryReader implements SessionSummaryProjectionStore {
  private readonly base: BaseSessionSummaryReader

  constructor(
    private readonly executor: SqliteExecutor,
    options: SqliteSessionSummaryReaderOptions = {},
  ) {
    this.base = new BaseSessionSummaryReader(executor, options)
  }

  async query(input: SessionSummaryQuery): Promise<{ items: SessionSummaryRecord[]; hasMore: boolean }> {
    const page = await this.base.query(input)
    const items = await this.executor.run(() => correctCodexSummaries(this.executor, page.items).map(item => {
      const parentSessionId = relatedParent(this.executor, item.logicalSessionId)
      return {
        ...item,
        internalReviewCount: internalReviewCount(this.executor, item.logicalSessionId),
        ...(parentSessionId ? { parentSessionId } : {}),
      }
    }))
    return { ...page, items }
  }

  isMaterialized(): Promise<boolean> {
    return this.base.isMaterialized()
  }

  rebuild(input?: {
    logicalSessionId?: string
    strategy?: 'atomic' | 'cooperative'
    signal?: AbortSignal
  }): Promise<void> {
    return this.base.rebuild(input)
  }
}

export const sessionSummaryV2Internals = {
  correctCodexSummaries,
}
