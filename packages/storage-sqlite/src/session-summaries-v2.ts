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

/**
 * Session Summary V2 now treats the persisted projection as the authoritative
 * read model. Provenance/user-turn/tool/relationship corrections belong to the
 * incremental projection/rebuild path, never the foreground list query.
 *
 * The former implementation re-scanned observations + evidence + source_records
 * for every Codex session returned by a list request and then executed per-row
 * relationship queries. On large stores that defeated the purpose of the
 * materialized projection and made Task Center latency proportional to raw
 * history size.
 */
export class SqliteSessionSummaryReader implements SessionSummaryProjectionStore {
  private readonly base: BaseSessionSummaryReader

  constructor(
    _executor: SqliteExecutor,
    options: SqliteSessionSummaryReaderOptions = {},
  ) {
    this.base = new BaseSessionSummaryReader(_executor, options)
  }

  query(input: SessionSummaryQuery): Promise<{ items: SessionSummaryRecord[]; hasMore: boolean }> {
    return this.base.query(input)
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
