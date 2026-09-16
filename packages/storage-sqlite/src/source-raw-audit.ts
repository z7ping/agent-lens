import type {
  SourceRawAuditReader,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import { mapSourceRecord } from './repository-row-mappers'

type AuditRow = {
  id: string
  auditRowId: number
  canonicalStable: number
  evidenceStable: number
} & Record<string, unknown>

interface AuditCursor {
  throughRowId: number
  afterRowId: number
}

function safeRowId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`SQLite Raw audit ${label} must be a non-negative safe integer`)
  }
  return value
}

function encodeCursor(cursor: AuditCursor): string {
  return `v1:${cursor.throughRowId}:${cursor.afterRowId}`
}

function decodeCursor(value: string | undefined): AuditCursor | null {
  if (!value) return null
  const match = /^v1:(\d+):(\d+)$/.exec(value)
  if (!match) throw new Error('Invalid Source Raw audit cursor')
  const throughRowId = safeRowId(Number(match[1]), 'throughRowId')
  const afterRowId = safeRowId(Number(match[2]), 'afterRowId')
  if (afterRowId > throughRowId) throw new Error('Invalid Source Raw audit cursor range')
  return { throughRowId, afterRowId }
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

  async list(cursorValue?: string, limit = 100) {
    const batchLimit = Math.max(1, Math.min(limit, 500))
    const cursor = decodeCursor(cursorValue)
    const throughRowId = cursor?.throughRowId ?? await this.executor.run(() => {
      const row = this.executor.db.prepare(
        'SELECT COALESCE(MAX(rowid), 0) AS maxRowId FROM source_records',
      ).get() as { maxRowId: unknown }
      return safeRowId(row.maxRowId, 'maxRowId')
    })
    const afterRowId = cursor?.afterRowId ?? 0
    const rows = await this.executor.run(() => this.executor.db.prepare(`
      SELECT sr.id AS id,
             sr.rowid AS auditRowId,
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
               WHERE e.source_record_id = sr.id
                 AND EXISTS(
                   SELECT 1
                   FROM observation_evidence oe
                   WHERE oe.evidence_id = e.id
                 )
             ) AS canonicalStable,
             EXISTS(
               SELECT 1
               FROM evidence e
               WHERE e.source_record_id = sr.id
             ) AS evidenceStable
      FROM source_records sr
      WHERE sr.rowid > ?
        AND sr.rowid <= ?
      ORDER BY sr.rowid ASC
      LIMIT ?
    `).all(afterRowId, throughRowId, batchLimit + 1) as AuditRow[])

    const selected = rows.slice(0, batchLimit)
    for (const row of selected) safeRowId(row.auditRowId, 'rowid')
    const items = selected.map(row => ({
      record: mapSourceRecord(row),
      canonicalStable: row.canonicalStable === 1,
      evidenceStable: row.evidenceStable === 1,
      // AgentLens currently has no persisted Session pin state. Once that
      // feature exists this reader must surface it here before auto-reclaim
      // can consider pinned sessions.
      pinned: false as const,
    }))

    const hasMore = rows.length > batchLimit
    const lastRowId = selected.at(-1)?.auditRowId
    return {
      items,
      ...(hasMore && lastRowId !== undefined
        ? { cursor: encodeCursor({ throughRowId, afterRowId: lastRowId }) }
        : {}),
      hasMore,
    }
  }
}
