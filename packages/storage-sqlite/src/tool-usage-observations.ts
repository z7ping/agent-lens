import type {
  JsonValue,
  ToolUsageObservationQuery,
  ToolUsageObservationReader,
  ToolUsageObservationRecord,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

const MAX_LIMIT = 5000
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER
const TOOL_KINDS = ['tool.call', 'tool.result'] as const

type ToolUsageRow = Record<string, unknown>

function rowRecord(value: unknown): ToolUsageRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite tool usage query returned a non-object row')
  }
  return value as ToolUsageRow
}

function requiredString(row: ToolUsageRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`SQLite tool usage field ${key} must be a string`)
  return value
}

function optionalString(row: ToolUsageRow, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`SQLite tool usage field ${key} must be a string or null`)
  return value
}

function optionalNumber(row: ToolUsageRow, key: string): number | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`SQLite tool usage field ${key} must be a finite number or null`)
  }
  return value
}

function jsonValue(value: unknown, key: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(item => jsonValue(item, key))
  if (typeof value === 'object') {
    const output: { [key: string]: JsonValue } = {}
    for (const [entryKey, entryValue] of Object.entries(value)) output[entryKey] = jsonValue(entryValue, key)
    return output
  }
  throw new TypeError(`SQLite tool usage field ${key} must contain JSON data`)
}

function decodeJson(value: unknown): JsonValue {
  if (typeof value !== 'string' || value.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new TypeError('SQLite tool usage field payload_json contains invalid JSON')
  }
  return jsonValue(parsed, 'payload_json')
}

function mapRow(value: unknown): ToolUsageObservationRecord {
  const row = rowRecord(value)
  const projectId = optionalString(row, 'project_id')
  const sourceSequence = optionalNumber(row, 'source_sequence')
  const canonicalSequence = optionalNumber(row, 'canonical_sequence')
  const occurredAt = optionalString(row, 'occurred_at')
  const kind = requiredString(row, 'kind')
  if (!(TOOL_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError(`SQLite tool usage field kind has unsupported value: ${kind}`)
  }
  return {
    id: requiredString(row, 'id'),
    installationId: requiredString(row, 'installation_id'),
    logicalSessionId: requiredString(row, 'logical_session_id'),
    ...(projectId === undefined ? {} : { projectId }),
    sourceId: requiredString(row, 'source_id'),
    productId: requiredString(row, 'product_id'),
    kind: kind as ToolUsageObservationRecord['kind'],
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
    ...(canonicalSequence === undefined ? {} : { canonicalSequence }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    capturedAt: requiredString(row, 'captured_at'),
    payload: decodeJson(row.payload_json),
  }
}

/**
 * Portable lightweight Tool Observation reader.
 *
 * Aggregate analytics intentionally do not live here anymore: SQLite's formal
 * aggregate path is Tool Usage Fact Projection (`tool-usage-facts.ts`). Keeping
 * this reader query-only prevents the old Observation JSON aggregate from
 * becoming an accidental production fallback again.
 */
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
      return this.executor.db.prepare(`
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
      `).all(...params, limit).map(mapRow)
    })
  }
}
