import type {
  ToolUsageObservationQuery,
  ToolUsageObservationReader,
  ToolUsageObservationRecord,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

const MAX_LIMIT = 5000
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER

function decodeJson(value: unknown): ToolUsageObservationRecord['payload'] {
  if (typeof value !== 'string' || value.length === 0) return null
  return JSON.parse(value) as ToolUsageObservationRecord['payload']
}

function mapRow(row: any): ToolUsageObservationRecord {
  return {
    id: row.id,
    installationId: row.installation_id,
    logicalSessionId: row.logical_session_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    sourceId: row.source_id,
    productId: row.product_id,
    kind: row.kind,
    ...(row.source_sequence == null ? {} : { sourceSequence: Number(row.source_sequence) }),
    ...(row.canonical_sequence == null ? {} : { canonicalSequence: Number(row.canonical_sequence) }),
    ...(row.occurred_at == null ? {} : { occurredAt: row.occurred_at }),
    capturedAt: row.captured_at,
    payload: decodeJson(row.payload_json),
  }
}

export class SqliteToolUsageObservationReader implements ToolUsageObservationReader {
  constructor(private readonly executor: SqliteExecutor) {}

  query(input: ToolUsageObservationQuery): Promise<ToolUsageObservationRecord[]> {
    return this.executor.run(() => {
      const conditions = ['o.kind = ?']
      const params: unknown[] = [input.kind]

      if (input.installationId) {
        conditions.push('o.installation_id = ?')
        params.push(input.installationId)
      }
      if (input.logicalSessionId) {
        conditions.push('o.logical_session_id = ?')
        params.push(input.logicalSessionId)
      }
      if (input.projectId) {
        conditions.push('o.project_id = ?')
        params.push(input.projectId)
      }
      if (input.sourceId) {
        conditions.push('ss.source_id = ?')
        params.push(input.sourceId)
      }
      if (input.from) {
        conditions.push('COALESCE(o.occurred_at, o.captured_at) >= ?')
        params.push(input.from)
      }
      if (input.to) {
        conditions.push('COALESCE(o.occurred_at, o.captured_at) <= ?')
        params.push(input.to)
      }
      if (input.after) {
        const sequence = input.after.sequence ?? MAX_SEQUENCE
        conditions.push(`(
          COALESCE(o.occurred_at, o.captured_at) > ?
          OR (
            COALESCE(o.occurred_at, o.captured_at) = ?
            AND (
              COALESCE(o.canonical_sequence, o.source_sequence, ${MAX_SEQUENCE}) > ?
              OR (
                COALESCE(o.canonical_sequence, o.source_sequence, ${MAX_SEQUENCE}) = ?
                AND o.id > ?
              )
            )
          )
        )`)
        params.push(input.after.effectiveAt, input.after.effectiveAt, sequence, sequence, input.after.id)
      }

      const limit = Math.max(1, Math.min(input.limit ?? 1000, MAX_LIMIT))
      const rows = this.executor.db.prepare(`
        SELECT
          o.id,
          o.installation_id,
          o.logical_session_id,
          o.project_id,
          o.kind,
          o.source_sequence,
          o.canonical_sequence,
          o.occurred_at,
          o.captured_at,
          o.payload_json,
          ss.source_id,
          ai.product_id
        FROM observations AS o
        JOIN source_sessions AS ss ON ss.id = o.source_session_id
        JOIN agent_installations AS ai ON ai.id = o.installation_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY
          COALESCE(o.occurred_at, o.captured_at) ASC,
          COALESCE(o.canonical_sequence, o.source_sequence, ${MAX_SEQUENCE}) ASC,
          o.id ASC
        LIMIT ?
      `).all(...params, limit)

      return rows.map(mapRow)
    })
  }
}
