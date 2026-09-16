import type {
  SourceRawAuditReader,
  SourceRecordId,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import { mapSourceRecord } from './repository-row-mappers'

type AuditRow = {
  id: string
  canonicalStable: number
  evidenceStable: number
}

/**
 * Recovery audit reads SourceRecord metadata only.
 *
 * Raw payload may be large and gzip-compressed. Recovery capability and
 * fingerprint verification only need identity + locator metadata, so payload
 * hydration here would turn a safety audit into a second full Raw scan.
 * The selected payload_json is therefore an explicit null placeholder and
 * audit records must never be passed to Source normalization.
 */
export class SqliteSourceRawAuditReader implements SourceRawAuditReader {
  constructor(private readonly executor: SqliteExecutor) {}

  async list(afterId?: SourceRecordId, limit = 100) {
    const batchLimit = Math.max(1, Math.min(limit, 500))
    const rows = await this.executor.run(() => this.executor.db.prepare(`
      SELECT sr.id AS id,
             sr.source_id,
             sr.installation_id,
             sr.source_session_native_id,
             sr.native_type,
             sr.native_id,
             sr.source_sequence,
             sr.occurred_at,
             sr.captured_at,
             sr.locator_json,
             sr.fingerprint,
             'null' AS payload_json,
             sr.parser_version,
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
    const items = selected.map(row => ({
      record: mapSourceRecord(row),
      canonicalStable: row.canonicalStable === 1,
      evidenceStable: row.evidenceStable === 1,
      // AgentLens currently has no persisted Session pin state. Once that
      // feature exists this reader must surface it here before auto-reclaim
      // can consider pinned sessions.
      pinned: false as const,
    }))

    return {
      items,
      ...(selected.at(-1)?.id ? { cursor: selected.at(-1)!.id } : {}),
      hasMore: rows.length > batchLimit,
    }
  }
}
