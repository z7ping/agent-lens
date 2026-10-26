import type { SourceLocator, SourceRecord } from '@agent-lens/core'

type SqliteRow = Record<string, unknown>
const LOCATOR_KIND = ['file', 'database', 'runtime-hook', 'external'] as const

function rowRecord(value: unknown): SqliteRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite persistence returned a non-object row')
  }
  return value as SqliteRow
}
function requiredString(row: SqliteRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`SQLite row field ${key} must be a string`)
  return value
}

function optionalString(row: SqliteRow, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`SQLite row field ${key} must be a string or null`)
  return value
}

function optionalNumber(row: SqliteRow, key: string): number | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`SQLite row field ${key} must be a finite number or null`)
  }
  return value
}

function enumString<const T extends readonly string[]>(
  row: SqliteRow,
  key: string,
  allowed: T,
): T[number] {
  const value = requiredString(row, key)
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`SQLite row field ${key} has unsupported value: ${value}`)
  }
  return value as T[number]
}

function parseJson(value: unknown, key: string): unknown {
  if (typeof value !== 'string') throw new TypeError(`SQLite row field ${key} must contain JSON text`)
  try {
    return JSON.parse(value)
  } catch {
    throw new TypeError(`SQLite row field ${key} contains invalid JSON`)
  }
}

function sourceLocator(value: unknown, key: string): SourceLocator {
  const locator = rowRecord(parseJson(value, key))
  const kind = enumString(locator, 'kind', LOCATOR_KIND)
  const path = optionalString(locator, 'path')
  const offset = optionalNumber(locator, 'offset')
  const rowId = optionalString(locator, 'rowId')
  const table = optionalString(locator, 'table')
  const hookEventId = optionalString(locator, 'hookEventId')
  return {
    kind,
    ...(path === undefined ? {} : { path }),
    ...(offset === undefined ? {} : { offset }),
    ...(rowId === undefined ? {} : { rowId }),
    ...(table === undefined ? {} : { table }),
    ...(hookEventId === undefined ? {} : { hookEventId }),
  }
}

export function mapSourceRecord(value: unknown): SourceRecord {
  const row = rowRecord(value)
  const sourceSessionNativeId = optionalString(row, 'source_session_native_id')
  const nativeId = optionalString(row, 'native_id')
  const sourceSequence = optionalNumber(row, 'source_sequence')
  const occurredAt = optionalString(row, 'occurred_at')
  const fingerprint = optionalString(row, 'fingerprint')
  return {
    id: requiredString(row, 'id'),
    sourceId: requiredString(row, 'source_id'),
    installationId: requiredString(row, 'installation_id'),
    ...(sourceSessionNativeId === undefined ? {} : { sourceSessionNativeId }),
    nativeType: requiredString(row, 'native_type'),
    ...(nativeId === undefined ? {} : { nativeId }),
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    capturedAt: requiredString(row, 'captured_at'),
    locator: sourceLocator(row.locator_json, 'locator_json'),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    payload: parseJson(row.payload_json, 'payload_json'),
    parserVersion: requiredString(row, 'parser_version'),
  }
}
