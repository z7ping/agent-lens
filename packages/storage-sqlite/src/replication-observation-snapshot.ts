import type { CanonicalObservation } from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import { mapObservation, sqliteRowId } from './repository-row-mappers'

export interface CanonicalObservationSnapshotPage {
  items: CanonicalObservation[]
  nextCursor?: string
  done: boolean
}

export interface CanonicalObservationSnapshotScanInput {
  afterId?: string
  capturedAtOnOrAfter?: string
  limit?: number
}

/**
 * Stable current-state root scan for Replication Snapshot Bootstrap.
 *
 * Ordering is deliberately only by immutable Observation primary key. Rows
 * inserted/updated after baselineRevision are also discoverable through the
 * change journal, so this scan does not need to freeze the Canonical store.
 */
export class SqliteCanonicalObservationSnapshotReader {
  constructor(private readonly executor: SqliteExecutor) {}

  async scan(input: CanonicalObservationSnapshotScanInput = {}): Promise<CanonicalObservationSnapshotPage> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 5000))
    return this.executor.run(() => {
      const conditions: string[] = []
      const params: unknown[] = []
      if (input.afterId) {
        conditions.push('id > ?')
        params.push(input.afterId)
      }
      if (input.capturedAtOnOrAfter) {
        conditions.push('captured_at >= ?')
        params.push(input.capturedAtOnOrAfter)
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      const rows = this.executor.db.prepare(`
        SELECT *
        FROM observations
        ${where}
        ORDER BY id ASC
        LIMIT ?
      `).all(...params, limit + 1)

      const done = rows.length <= limit
      const selected = rows.slice(0, limit)
      if (!selected.length) return { items: [], done: true }

      const ids = selected.map(sqliteRowId)
      const placeholders = ids.map(() => '?').join(', ')
      const evidenceRows = this.executor.db.prepare(`
        SELECT observation_id AS observationId, evidence_id AS evidenceId
        FROM observation_evidence
        WHERE observation_id IN (${placeholders})
        ORDER BY observation_id, evidence_id
      `).all(...ids) as Array<{ observationId: string; evidenceId: string }>
      const evidenceByObservation = new Map<string, string[]>()
      for (const row of evidenceRows) {
        const values = evidenceByObservation.get(row.observationId) ?? []
        values.push(row.evidenceId)
        evidenceByObservation.set(row.observationId, values)
      }

      const items = selected.map(row => {
        const id = sqliteRowId(row)
        return mapObservation(row, evidenceByObservation.get(id) ?? [])
      })
      return {
        items,
        nextCursor: ids.at(-1)!,
        done,
      }
    })
  }
}
