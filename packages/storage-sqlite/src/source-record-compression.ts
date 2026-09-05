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
  return JSON.parse(gunzipSync(Buffer.from(blob)).toString('utf8')) as unknown
}

interface CompressionRow {
  payload_encoding?: string | null
  payload_blob?: Uint8Array | null
}

async function restoreCompressedPayload(
  executor: SqliteExecutor,
  record: SourceRecord | null,
): Promise<SourceRecord | null> {
  if (!record) return null
  const row = await executor.run(() => executor.db.prepare(`
    SELECT payload_encoding, payload_blob FROM source_records WHERE id = ?
  `).get(record.id) as CompressionRow | undefined)
  if (row?.payload_encoding !== 'gzip-json') return record
  return { ...record, payload: decodeCompressedSourceRecordPayload(row.payload_blob) }
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
      `).all(...uniqueIds) as Array<CompressionRow & { id: string }>)
      const compressed = new Map(rows
        .filter(row => row.payload_encoding === 'gzip-json')
        .map(row => [row.id, row.payload_blob]))
      return records.map(record => compressed.has(record.id)
        ? { ...record, payload: decodeCompressedSourceRecordPayload(compressed.get(record.id)) }
        : record)
    },
    async findByNativeId(sourceId, installationId, nativeId) {
      const record = await sourceRecords.findByNativeId(sourceId, installationId, nativeId)
      return record ? this.get(record.id) : null
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
