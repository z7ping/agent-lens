import { gunzipSync, gzipSync } from 'node:zlib'
import type { SourceRecord, SourceRecordRepository } from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

export const SOURCE_RECORD_COMPRESSION_THRESHOLD_BYTES = 1024

export interface EncodedSourceRecordPayload {
  payloadJson: string
  payloadBlob: Buffer | null
  payloadEncoding: 'plain-json' | 'gzip-json'
  rawBytes: number
  storedBytes: number
}

interface CompressionRow {
  id?: string
  payloadEncoding?: string
  payloadBlob?: Uint8Array
}

function compressionRow(value: unknown): CompressionRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite SourceRecord compression query returned a non-object row')
  }
  const row = value as Record<string, unknown>
  const id = row.id
  const payloadEncoding = row.payload_encoding
  const payloadBlob = row.payload_blob
  if (id != null && typeof id !== 'string') throw new TypeError('SQLite SourceRecord compression field id must be a string')
  if (payloadEncoding != null && typeof payloadEncoding !== 'string') {
    throw new TypeError('SQLite SourceRecord compression field payload_encoding must be a string or null')
  }
  if (payloadBlob != null && !(payloadBlob instanceof Uint8Array)) {
    throw new TypeError('SQLite SourceRecord compression field payload_blob must be binary or null')
  }
  return {
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof payloadEncoding === 'string' ? { payloadEncoding } : {}),
    ...(payloadBlob instanceof Uint8Array ? { payloadBlob } : {}),
  }
}

export function encodeSourceRecordPayloadJson(serialized: string): EncodedSourceRecordPayload {
  const raw = Buffer.from(serialized, 'utf8')
  if (raw.byteLength < SOURCE_RECORD_COMPRESSION_THRESHOLD_BYTES) {
    return {
      payloadJson: serialized,
      payloadBlob: null,
      payloadEncoding: 'plain-json',
      rawBytes: raw.byteLength,
      storedBytes: raw.byteLength,
    }
  }

  const compressed = gzipSync(raw, { level: 6 })
  if (compressed.byteLength + 32 >= raw.byteLength) {
    return {
      payloadJson: serialized,
      payloadBlob: null,
      payloadEncoding: 'plain-json',
      rawBytes: raw.byteLength,
      storedBytes: raw.byteLength,
    }
  }

  return {
    payloadJson: 'null',
    payloadBlob: compressed,
    payloadEncoding: 'gzip-json',
    rawBytes: raw.byteLength,
    storedBytes: compressed.byteLength,
  }
}

export function decodeCompressedSourceRecordPayload(blob: unknown): unknown {
  if (!(blob instanceof Uint8Array)) throw new Error('Compressed SourceRecord payload is missing')
  return JSON.parse(gunzipSync(Buffer.from(blob)).toString('utf8'))
}

async function restoreCompressedPayload(
  executor: SqliteExecutor,
  record: SourceRecord | null,
): Promise<SourceRecord | null> {
  if (!record) return null
  const rawRow = await executor.run(() => executor.db.prepare(`
    SELECT payload_encoding, payload_blob FROM source_records WHERE id = ?
  `).get(record.id))
  if (!rawRow) return record
  const row = compressionRow(rawRow)
  if (row.payloadEncoding !== 'gzip-json') return record
  return { ...record, payload: decodeCompressedSourceRecordPayload(row.payloadBlob) }
}

export function withSqliteSourceRecordCompression(
  executor: SqliteExecutor,
  sourceRecords: SourceRecordRepository,
): SourceRecordRepository {
  return {
    ...sourceRecords,
    async get(id) {
      return restoreCompressedPayload(executor, await sourceRecords.get(id))
    },
    async getMany(ids) {
      const records = sourceRecords.getMany
        ? await sourceRecords.getMany(ids)
        : (await Promise.all(ids.map(id => sourceRecords.get(id)))).filter((item): item is SourceRecord => item != null)
      if (!records.length) return []
      const uniqueIds = [...new Set(records.map(record => record.id))]
      const placeholders = uniqueIds.map(() => '?').join(', ')
      const rows = await executor.run(() => executor.db.prepare(`
        SELECT id, payload_encoding, payload_blob
        FROM source_records
        WHERE id IN (${placeholders})
      `).all(...uniqueIds).map(compressionRow))
      const compressed = new Map(rows.flatMap(row => row.id && row.payloadEncoding === 'gzip-json'
        ? [[row.id, row.payloadBlob] as const]
        : []))
      return records.map(record => compressed.has(record.id)
        ? { ...record, payload: decodeCompressedSourceRecordPayload(compressed.get(record.id)) }
        : record)
    },
    async findByNativeId(sourceId, installationId, nativeId) {
      const record = await sourceRecords.findByNativeId(sourceId, installationId, nativeId)
      return restoreCompressedPayload(executor, record)
    },
    async put(record) {
      await sourceRecords.put(record)
      const serialized = JSON.stringify(record.payload)
      if (serialized === undefined) throw new TypeError('SQLite persistence requires JSON-serializable SourceRecord payload')
      const encoded = encodeSourceRecordPayloadJson(serialized)
      await executor.run(() => {
        executor.db.prepare(`
          UPDATE source_records
          SET payload_json = ?, payload_blob = ?, payload_encoding = ?
          WHERE id = ?
        `).run(encoded.payloadJson, encoded.payloadBlob, encoded.payloadEncoding, record.id)
      })
    },
  }
}
