export interface HermesRow {
  row_id: number
  id: string | number | null
  session_id: string | null
  role: string | null
  content: string | null
  timestamp: number | string | null
  tool_calls: string | null
  tool_call_id: string | null
  tool_name: string | null
  cwd: string | null
  session_title: string | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (value == null) return null
  if (typeof value !== 'string') throw new TypeError(`Hermes SQLite field ${key} must be a string or null`)
  return value
}

function nullableId(record: Record<string, unknown>, key: string): string | number | null {
  const value = record[key]
  if (value == null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new TypeError(`Hermes SQLite field ${key} must be a string, finite number, or null`)
}

function nullableTimestamp(record: Record<string, unknown>, key: string): number | string | null {
  const value = record[key]
  if (value == null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new TypeError(`Hermes SQLite field ${key} must be a string, finite number, or null`)
}

export function hermesRow(value: unknown): HermesRow {
  const row = asRecord(value)
  const rowId = row.row_id
  if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId)) {
    throw new TypeError('Hermes SQLite field row_id must be a safe integer')
  }
  return {
    row_id: rowId,
    id: nullableId(row, 'id'),
    session_id: nullableString(row, 'session_id'),
    role: nullableString(row, 'role'),
    content: nullableString(row, 'content'),
    timestamp: nullableTimestamp(row, 'timestamp'),
    tool_calls: nullableString(row, 'tool_calls'),
    tool_call_id: nullableString(row, 'tool_call_id'),
    tool_name: nullableString(row, 'tool_name'),
    cwd: nullableString(row, 'cwd'),
    session_title: nullableString(row, 'session_title'),
  }
}

export function tableColumnName(value: unknown): string | undefined {
  const row = asRecord(value)
  return typeof row.name === 'string' && row.name ? row.name : undefined
}
