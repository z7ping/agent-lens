import type {
  CanonicalObservation,
  ObservationQuery,
  ObservationRepository,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import { mapObservation, sqliteRowId } from './repository-row-mappers'

const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER

type SqliteRow = Record<string, unknown>

function rowRecord(value: unknown): SqliteRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite observation pagination query returned a non-object row')
  }
  return value as SqliteRow
}

function stringField(value: unknown, key: string): string {
  const field = rowRecord(value)[key]
  if (typeof field !== 'string') throw new TypeError(`SQLite observation pagination field ${key} must be a string`)
  return field
}

function evidenceLink(value: unknown): { observationId: string; evidenceId: string } {
  const row = rowRecord(value)
  const observationId = row.observation_id
  const evidenceId = row.evidence_id
  if (typeof observationId !== 'string' || typeof evidenceId !== 'string') {
    throw new TypeError('SQLite observation evidence link must contain string ids')
  }
  return { observationId, evidenceId }
}

function reverseQuery(executor: SqliteExecutor, query: ObservationQuery): Promise<CanonicalObservation[]> {
  const { db } = executor
  return executor.run(() => {
    const conditions: string[] = []
    const params: unknown[] = []
    if (query.installationId) {
      conditions.push('installation_id = ?')
      params.push(query.installationId)
    }
    if (query.logicalSessionId) {
      conditions.push('logical_session_id = ?')
      params.push(query.logicalSessionId)
    }
    if (query.logicalSessionIds?.length) {
      const placeholders = query.logicalSessionIds.map(() => '?').join(', ')
      conditions.push(`logical_session_id IN (${placeholders})`)
      params.push(...query.logicalSessionIds)
    }
    if (query.kind) {
      conditions.push('kind = ?')
      params.push(query.kind)
    }
    if (query.from) {
      conditions.push('COALESCE(occurred_at, captured_at) >= ?')
      params.push(query.from)
    }
    if (query.to) {
      conditions.push('COALESCE(occurred_at, captured_at) <= ?')
      params.push(query.to)
    }
    if (query.before) {
      const sequence = query.before.sequence ?? MAX_SEQUENCE
      conditions.push(`(
        COALESCE(occurred_at, captured_at) < ?
        OR (
          COALESCE(occurred_at, captured_at) = ?
          AND (
            COALESCE(canonical_sequence, source_sequence, ${MAX_SEQUENCE}) < ?
            OR (
              COALESCE(canonical_sequence, source_sequence, ${MAX_SEQUENCE}) = ?
              AND id < ?
            )
          )
        )
      )`)
      params.push(query.before.effectiveAt, query.before.effectiveAt, sequence, sequence, query.before.id)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(query.limit ?? 500, 5000))
    const rows = db.prepare(`
      SELECT * FROM observations ${where}
      ORDER BY
        COALESCE(occurred_at, captured_at) DESC,
        COALESCE(canonical_sequence, source_sequence, ${MAX_SEQUENCE}) DESC,
        id DESC
      LIMIT ?
    `).all(...params, limit)
    if (!rows.length) return []

    const ids = rows.map(sqliteRowId)
    const placeholders = ids.map(() => '?').join(', ')
    const evidenceRows = db.prepare(`
      SELECT observation_id, evidence_id
      FROM observation_evidence
      WHERE observation_id IN (${placeholders})
      ORDER BY observation_id, evidence_id
    `).all(...ids).map(evidenceLink)
    const evidenceByObservation = new Map<string, string[]>()
    for (const row of evidenceRows) {
      const values = evidenceByObservation.get(row.observationId) ?? []
      values.push(row.evidenceId)
      evidenceByObservation.set(row.observationId, values)
    }
    return rows.map(row => {
      const id = sqliteRowId(row)
      return mapObservation(row, evidenceByObservation.get(id) ?? [])
    })
  })
}

function cleanupStaleParserDerivations(executor: SqliteExecutor, evidenceRefs: readonly string[]): number {
  if (!evidenceRefs.length) return 0
  const placeholders = evidenceRefs.map(() => '?').join(', ')
  const sourceRecordIds = executor.db.prepare(`
    SELECT DISTINCT e.source_record_id AS sourceRecordId
    FROM evidence e
    WHERE e.id IN (${placeholders}) AND e.source_record_id IS NOT NULL
  `).all(...evidenceRefs).map(row => stringField(row, 'sourceRecordId'))
  let deleted = 0

  for (const sourceRecordId of sourceRecordIds) {
    const ids = executor.db.prepare(`
      SELECT DISTINCT oe.observation_id AS observationId
      FROM observation_evidence oe
      JOIN evidence e ON e.id = oe.evidence_id
      JOIN source_records sr ON sr.id = e.source_record_id
      WHERE e.source_record_id = ?
        AND COALESCE(e.parser_version, '') != COALESCE(sr.parser_version, '')
    `).all(sourceRecordId).map(row => stringField(row, 'observationId'))
    if (!ids.length) continue
    const stalePlaceholders = ids.map(() => '?').join(', ')

    executor.db.prepare(`
      DELETE FROM observation_evidence
      WHERE observation_id IN (${stalePlaceholders})
        AND evidence_id IN (
          SELECT e.id
          FROM evidence e
          JOIN source_records sr ON sr.id = e.source_record_id
          WHERE e.source_record_id = ?
            AND COALESCE(e.parser_version, '') != COALESCE(sr.parser_version, '')
        )
    `).run(...ids, sourceRecordId)

    executor.db.prepare(`
      UPDATE observations
      SET parent_observation_id = NULL
      WHERE parent_observation_id IN (${stalePlaceholders})
        AND NOT EXISTS (
          SELECT 1 FROM observation_evidence parent_oe
          WHERE parent_oe.observation_id = observations.parent_observation_id
        )
    `).run(...ids)
    const result = executor.db.prepare(`
      DELETE FROM observations
      WHERE id IN (${stalePlaceholders})
        AND NOT EXISTS (
          SELECT 1 FROM observation_evidence oe
          WHERE oe.observation_id = observations.id
        )
    `).run(...ids)
    deleted += Number(result.changes)
  }
  return deleted
}

export function withSqliteObservationPagination(
  executor: SqliteExecutor,
  base: ObservationRepository,
): ObservationRepository {
  return {
    ...base,
    async query(query) {
      if (query.order !== 'desc' && !query.before) return base.query(query)
      return reverseQuery(executor, query)
    },
    async put(observation) {
      await base.put(observation)
      // Parser Replay first advances source_records.parser_version, then writes new Evidence.
      // Drop only links created by older parser versions; raw SourceRecord/Evidence rows remain immutable.
      await executor.run(() => cleanupStaleParserDerivations(executor, observation.evidenceRefs))
    },
    async removeDerivationsForSourceRecord(sourceRecordId) {
      return executor.run(() => {
        const ids = executor.db.prepare(`
          SELECT DISTINCT oe.observation_id AS observationId
          FROM observation_evidence oe
          JOIN evidence e ON e.id = oe.evidence_id
          WHERE e.source_record_id = ?
        `).all(sourceRecordId).map(row => stringField(row, 'observationId'))
        if (!ids.length) return 0
        const placeholders = ids.map(() => '?').join(', ')
        executor.db.prepare(`
          DELETE FROM observation_evidence
          WHERE observation_id IN (${placeholders})
            AND evidence_id IN (SELECT id FROM evidence WHERE source_record_id = ?)
        `).run(...ids, sourceRecordId)
        executor.db.prepare(`
          UPDATE observations
          SET parent_observation_id = NULL
          WHERE parent_observation_id IN (${placeholders})
        `).run(...ids)
        const result = executor.db.prepare(`
          DELETE FROM observations
          WHERE id IN (${placeholders})
            AND NOT EXISTS (SELECT 1 FROM observation_evidence oe WHERE oe.observation_id = observations.id)
        `).run(...ids)
        return Number(result.changes)
      })
    },
  }
}
