import type {
  SessionSummaryProjectionStore,
  SessionSummaryQuery,
  SessionSummaryRecord,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import { SqliteFacetScopeReader, type FacetScopeSnapshot } from './facet-scope'
import {
  SqliteSessionSummaryReader as BaseSessionSummaryReader,
  type SqliteSessionSummaryReaderOptions,
} from './session-summaries'

/**
 * Session Summary V2 treats the persisted projection as the authoritative read
 * model. Provenance/user-turn/tool/relationship corrections belong to the
 * incremental projection/rebuild path, never the foreground list query.
 */
export class SqliteSessionSummaryReader implements SessionSummaryProjectionStore {
  private readonly base: BaseSessionSummaryReader
  private readonly facets: SqliteFacetScopeReader

  constructor(
    executor: SqliteExecutor,
    options: SqliteSessionSummaryReaderOptions = {},
  ) {
    this.base = new BaseSessionSummaryReader(executor, options)
    this.facets = new SqliteFacetScopeReader(executor)
  }

  query(input: SessionSummaryQuery): Promise<{ items: SessionSummaryRecord[]; hasMore: boolean }> {
    return this.base.query(input)
  }

  facetScope(): Promise<FacetScopeSnapshot> {
    return this.facets.query()
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
