import type { KnownReplicationEntityType } from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'
import { canonicalChangeRow, revisionRow } from './replication-state-rows'

export interface CanonicalChangeEntry {
  revision: number
  entityType: KnownReplicationEntityType
  originEntityId: string
  changedAt: string
}

export interface CanonicalChangePage {
  items: readonly CanonicalChangeEntry[]
  nextRevision: number
  done: boolean
}

/**
 * Replication-control-plane change index. It never stores Canonical payloads;
 * callers must re-read current Canonical state before generating wire entities.
 */
export class SqliteReplicationCanonicalChangeReader {
  constructor(private readonly executor: SqliteExecutor) {}

  async highWaterRevision(): Promise<number> {
    return this.executor.run(() => {
      const stateTable = this.executor.db.prepare(`
        SELECT 1 AS found
        FROM sqlite_master
        WHERE type = 'table' AND name = 'replication_journal_state'
      `).get()
      if (stateTable) {
        const state = this.executor.db.prepare(`
          SELECT high_water_revision AS revision
          FROM replication_journal_state
          WHERE singleton = 1
        `).get()
        if (state) return revisionRow(state)
      }
      return revisionRow(this.executor.db.prepare(`
        SELECT COALESCE(MAX(revision), 0) AS revision
        FROM replication_canonical_changes
      `).get())
    })
  }

  async scan(input: {
    afterRevision?: number
    throughRevision: number
    entityType?: KnownReplicationEntityType
    limit?: number
  }): Promise<CanonicalChangePage> {
    const afterRevision = input.afterRevision ?? 0
    if (!Number.isInteger(afterRevision) || afterRevision < 0) {
      throw new TypeError('afterRevision must be a non-negative integer')
    }
    if (!Number.isInteger(input.throughRevision) || input.throughRevision < afterRevision) {
      throw new TypeError('throughRevision must be an integer greater than or equal to afterRevision')
    }
    const limit = Math.max(1, Math.min(input.limit ?? 100, 5000))

    return this.executor.run(() => {
      const params: unknown[] = [afterRevision, input.throughRevision]
      const entityFilter = input.entityType ? 'AND entity_type = ?' : ''
      if (input.entityType) params.push(input.entityType)
      params.push(limit)

      const rows = this.executor.db.prepare(`
        SELECT revision,
               entity_type AS entityType,
               origin_entity_id AS originEntityId,
               changed_at AS changedAt
        FROM replication_canonical_changes
        WHERE revision > ? AND revision <= ?
        ${entityFilter}
        ORDER BY revision ASC
        LIMIT ?
      `).all(...params).map(canonicalChangeRow)

      const done = rows.length < limit
      // When this filtered scan is exhausted, every matching change through
      // throughRevision has been considered even if the global journal also
      // contains other entity types. Advancing to the fixed boundary gives the
      // caller a continuous per-root capture watermark instead of pinning it to
      // the last matching row forever.
      const nextRevision = done
        ? input.throughRevision
        : rows.at(-1)?.revision ?? afterRevision
      return {
        items: rows,
        nextRevision,
        done,
      }
    })
  }
}
