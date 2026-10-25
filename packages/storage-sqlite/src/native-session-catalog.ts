import { isAbsolute } from 'node:path'
import type { SqliteExecutor } from './executor'

import {
  nativeReviewSessionId,
  type NativeSessionCatalogEntry,
  type NativeSessionCatalogQuery,
  type NativeSessionLocationKind,
} from '@agent-lens/core'

function row(row: {
  source_id: string
  installation_id: string
  native_session_id: string
  location_kind: NativeSessionLocationKind
  file_path: string
  file_identity: string
  file_size: number
  file_mtime_ms: number
  last_activity_at: string
  title: string | null
  updated_at: string
}): NativeSessionCatalogEntry {
  return {
    sourceId: row.source_id,
    installationId: row.installation_id,
    nativeSessionId: row.native_session_id,
    locationKind: row.location_kind,
    filePath: row.file_path,
    fileIdentity: row.file_identity,
    fileSize: row.file_size,
    fileMtimeMs: row.file_mtime_ms,
    lastActivityAt: row.last_activity_at,
    ...(row.title === null ? {} : { title: row.title }),
    updatedAt: row.updated_at,
  }
}

function checkEntry(value: NativeSessionCatalogEntry): void {
  for (const field of ['sourceId','installationId','nativeSessionId','fileIdentity','lastActivityAt','updatedAt'] as const) {
    if (!value[field]?.trim()) throw new Error(`NativeSessionCatalog requires ${field}`)
  }
  if (value.locationKind !== 'native' && value.locationKind !== 'archive') {
    throw new Error('NativeSessionCatalog invalid location kind')
  }
  if (!isAbsolute(value.filePath)) throw new Error('NativeSessionCatalog requires an absolute source-owned path')
  if (!Number.isSafeInteger(value.fileSize) || value.fileSize < 0 || !Number.isFinite(value.fileMtimeMs)) {
    throw new Error('NativeSessionCatalog invalid file stat')
  }
  if (value.title !== undefined && value.title.length > 512) {
    throw new Error('NativeSessionCatalog title exceeds 512 characters')
  }
}

/** One row per source-native location, never a duplicate of the native event stream. */
export class SqliteNativeSessionCatalog {
  constructor(private readonly executor: SqliteExecutor) {}

  async upsert(input: NativeSessionCatalogEntry): Promise<void> {
    checkEntry(input)
    await this.executor.run(() => {
      this.executor.db.prepare(`
        INSERT INTO native_session_catalog
          (source_id,installation_id,native_session_id,location_kind,file_path,
           file_identity,file_size,file_mtime_ms,last_activity_at,title,updated_at,review_session_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (source_id,installation_id,native_session_id,location_kind) DO UPDATE SET
          file_path=excluded.file_path,
          file_identity=excluded.file_identity,
          file_size=excluded.file_size,
          file_mtime_ms=excluded.file_mtime_ms,
          last_activity_at=MAX(native_session_catalog.last_activity_at, excluded.last_activity_at),
          title=COALESCE(excluded.title,native_session_catalog.title),
          updated_at=excluded.updated_at,
          review_session_id=excluded.review_session_id
      `).run(input.sourceId,input.installationId,input.nativeSessionId,input.locationKind,
        input.filePath,input.fileIdentity,input.fileSize,input.fileMtimeMs,
        input.lastActivityAt,input.title ?? null,input.updatedAt,
        nativeReviewSessionId(input.sourceId,input.installationId,input.nativeSessionId))
    })
  }

  async get(input: {
    sourceId: string
    installationId: string
    nativeSessionId: string
    locationKind?: NativeSessionLocationKind
  }): Promise<NativeSessionCatalogEntry | null> {
    return this.executor.run(() => {
      const value = this.executor.db.prepare(`
        SELECT * FROM native_session_catalog
        WHERE source_id=? AND installation_id=? AND native_session_id=?
          AND (? IS NULL OR location_kind=?)
        ORDER BY CASE location_kind WHEN 'native' THEN 0 ELSE 1 END
        LIMIT 1
      `).get(input.sourceId,input.installationId,input.nativeSessionId,
        input.locationKind ?? null,input.locationKind ?? null)
      return value ? row(value as Parameters<typeof row>[0]) : null
    })
  }

  async getByReviewSessionId(id: string): Promise<NativeSessionCatalogEntry | null> {
    if (!/^native:[0-9a-f]{32}$/.test(id)) return null
    return this.executor.run(() => {
      const value = this.executor.db.prepare(`
        SELECT * FROM native_session_catalog WHERE review_session_id = ?
        ORDER BY CASE location_kind WHEN 'native' THEN 0 ELSE 1 END
        LIMIT 1
      `).get(id)
      return value ? row(value as Parameters<typeof row>[0]) : null
    })
  }

  async query(input: NativeSessionCatalogQuery = {}): Promise<{
    items: NativeSessionCatalogEntry[]
    hasMore: boolean
  }> {
    const limit = input.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError('NativeSessionCatalog query limit must be between 1 and 200')
    }
    return this.executor.run(() => {
      const predicates: string[] = []
      const values: Array<string | number> = []
      if (input.sourceId) { predicates.push('source_id=?'); values.push(input.sourceId) }
      if (input.installationId) { predicates.push('installation_id=?'); values.push(input.installationId) }
      if (input.locationKind) { predicates.push('location_kind=?'); values.push(input.locationKind) }
      if (input.onlyWithoutLegacyReview) {
        // The existing SourceSession unique triple is the authoritative
        // association between source-native and legacy logical identities.
        // EXISTS uses the existing observations logical-session index, with
        // no payload reads and no scan of unbounded Source records.
        predicates.push(`NOT EXISTS (
          SELECT 1 FROM source_sessions AS linked
          WHERE linked.source_id = native_session_catalog.source_id
            AND linked.installation_id = native_session_catalog.installation_id
            AND linked.native_session_id = native_session_catalog.native_session_id
            AND EXISTS (
              SELECT 1 FROM observations AS stored
              WHERE stored.logical_session_id = linked.logical_session_id
            )
        )`)
      }
      if (input.before) {
        predicates.push(`(last_activity_at,source_id,installation_id,native_session_id,location_kind) < (?,?,?,?,?)`)
        values.push(input.before.lastActivityAt,input.before.sourceId,input.before.installationId,
          input.before.nativeSessionId,input.before.locationKind)
      }
      const result = this.executor.db.prepare(`
        SELECT * FROM native_session_catalog
        ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
        ORDER BY last_activity_at DESC,source_id DESC,installation_id DESC,native_session_id DESC,location_kind DESC
        LIMIT ?
      `).all(...values,limit+1) as Array<Parameters<typeof row>[0]>
      return { items: result.slice(0,limit).map(row), hasMore: result.length > limit }
    })
  }
}
