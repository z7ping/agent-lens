import type { SqliteExecutor } from './executor'

export interface UnknownObservationGroup {
  sourceId: string
  nativeType: string
  count: number
  lastSeenAt: string | null
}

export interface UnknownObservationSummary {
  total: number
  groups: UnknownObservationGroup[]
}

function mapGroup(value: unknown): UnknownObservationGroup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite unknown observation summary returned a non-object row')
  }
  const row = value as Record<string, unknown>
  if (typeof row.sourceId !== 'string' || typeof row.nativeType !== 'string') {
    throw new TypeError('SQLite unknown observation summary ids must be strings')
  }
  if (typeof row.count !== 'number' || !Number.isFinite(row.count)) {
    throw new TypeError('SQLite unknown observation summary count must be a finite number')
  }
  if (row.lastSeenAt != null && typeof row.lastSeenAt !== 'string') {
    throw new TypeError('SQLite unknown observation summary lastSeenAt must be a string or null')
  }
  return {
    sourceId: row.sourceId,
    nativeType: row.nativeType,
    count: row.count,
    lastSeenAt: row.lastSeenAt ?? null,
  }
}

export class SqliteUnknownObservationProjection {
  constructor(private readonly executor: SqliteExecutor) {}

  async summary(limit = 100): Promise<UnknownObservationSummary> {
    return this.executor.run(() => {
      const groups = this.executor.db.prepare(`
        SELECT source_id AS sourceId,
               native_type AS nativeType,
               COUNT(*) AS count,
               MAX(last_seen_at) AS lastSeenAt
        FROM unknown_observation_projection
        GROUP BY source_id, native_type
        ORDER BY count DESC, source_id, native_type
        LIMIT ?
      `).all(Math.max(1, Math.min(limit, 1000))).map(mapGroup)
      return {
        total: groups.reduce((sum, item) => sum + item.count, 0),
        groups,
      }
    })
  }

  async rebuild(): Promise<void> {
    await this.executor.transaction(async () => {
      this.executor.db.prepare('DELETE FROM unknown_observation_projection').run()
      this.executor.db.prepare(`
        INSERT OR REPLACE INTO unknown_observation_projection(
          observation_id, source_id, native_type, last_seen_at
        )
        SELECT DISTINCT
          o.id,
          sr.source_id,
          sr.native_type,
          COALESCE(o.occurred_at, o.captured_at)
        FROM observations o
        JOIN observation_evidence oe ON oe.observation_id = o.id
        JOIN evidence e ON e.id = oe.evidence_id
        JOIN source_records sr ON sr.id = e.source_record_id
        WHERE o.kind = 'unknown'
      `).run()
    })
  }
}
