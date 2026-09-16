import type {
  SourceRawAuditReader,
  SourceRecord,
  SourceRecordId,
  SourceRecordRepository,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

type AuditRow = {
  id: string
  canonicalStable: number
  evidenceStable: number
}

export class SqliteSourceRawAuditReader implements SourceRawAuditReader {
  constructor(
    private readonly executor: SqliteExecutor,
    private readonly sourceRecords: SourceRecordRepository,
  ) {}

  async list(afterId?: SourceRecordId, limit = 100) {
    const batchLimit = Math.max(1, Math.min(limit, 500))
    const rows = await this.executor.run(() => this.executor.db.prepare(`
      SELECT sr.id AS id,
             EXISTS(
               SELECT 1
               FROM evidence e
               JOIN observation_evidence oe ON oe.evidence_id = e.id
               WHERE e.source_record_id = sr.id
             ) AS canonicalStable,
             EXISTS(
               SELECT 1
               FROM evidence e
               WHERE e.source_record_id = sr.id
             ) AS evidenceStable
      FROM source_records sr
      WHERE (? IS NULL OR sr.id > ?)
      ORDER BY sr.id ASC
      LIMIT ?
    `).all(afterId ?? null, afterId ?? null, batchLimit + 1) as AuditRow[])

    const selected = rows.slice(0, batchLimit)
    const ids = selected.map(row => row.id)
    const records = this.sourceRecords.getMany
      ? await this.sourceRecords.getMany(ids)
      : (await Promise.all(ids.map(id => this.sourceRecords.get(id))))
          .filter((item): item is SourceRecord => item != null)
    const byId = new Map(records.map(record => [record.id, record]))

    const items = selected.flatMap(row => {
      const record = byId.get(row.id)
      if (!record) return []
      return [{
        record,
        canonicalStable: row.canonicalStable === 1,
        evidenceStable: row.evidenceStable === 1,
        // AgentLens currently has no persisted Session pin state. Once that
        // feature exists this reader must surface it here before auto-reclaim
        // can consider pinned sessions.
        pinned: false as const,
      }]
    })

    return {
      items,
      ...(ids.at(-1) ? { cursor: ids.at(-1) } : {}),
      hasMore: rows.length > batchLimit,
    }
  }
}
