import type {
  SessionSummaryProjectionStore,
  SessionSummaryQuery,
  SessionSummaryRecord,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import {
  SqliteSessionSummaryReader as BaseSessionSummaryReader,
  type SqliteSessionSummaryReaderOptions,
} from './session-summaries'

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

/**
 * Session Summary V2 在旧物化结构之上补根任务关系语义。
 * 基础 summary 仍完全可从 Canonical Observation 重建；这里不引入页面私有清洗逻辑。
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
    const items = await this.executor.run(() => page.items.map(item => ({
      ...item,
      internalReviewCount: internalReviewCount(this.executor, item.logicalSessionId),
      ...(relatedParent(this.executor, item.logicalSessionId)
        ? { parentSessionId: relatedParent(this.executor, item.logicalSessionId) }
        : {}),
    })))
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
