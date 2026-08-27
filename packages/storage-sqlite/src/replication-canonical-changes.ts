import type { KnownReplicationEntityType } from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'

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
    return this.executor.run(() => Number((this.executor.db.prepare(`
      SELECT COALESCE(MAX(revision), 0) AS revision
      FROM replication_canonical_changes
    `).get() as { revision: number }).revision))
  }

  async scan(input: {
    afterRevision?: number
    throughRevision: number
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
      const rows = this.executor.db.prepare(`
        SELECT revision,
               entity_type AS entityType,
               origin_entity_id AS originEntityId,
               changed_at AS changedAt
        FROM replication_canonical_changes
        WHERE revision > ? AND revision <= ?
        ORDER BY revision ASC
        LIMIT ?
      `).all(afterRevision, input.throughRevision, limit) as CanonicalChangeEntry[]

      const nextRevision = rows.at(-1)?.revision ?? afterRevision
      return {
        items: rows,
        nextRevision,
        done: nextRevision >= input.throughRevision || rows.length === 0,
      }
    })
  }
}
