import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import type { SqliteExecutor } from './executor'

import {
  type NativeSessionCatalogEntry,
  type NativeSessionCatalogQuery,
  type NativeSessionLocationKind,
} from '@agent-lens/core'

/** Must exactly match projection-review native session identity (same SHA256 tuple). */
function nativeReviewSessionId(sourceId: string, installationId: string, nativeSessionId: string): string {
  return `native:${createHash('sha256').update(JSON.stringify([sourceId, installationId, nativeSessionId])).digest('hex').slice(0, 32)}`
}

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
          file_size=CASE
            WHEN excluded.file_identity != native_session_catalog.file_identity
              OR excluded.file_mtime_ms > native_session_catalog.file_mtime_ms
              THEN excluded.file_size
            ELSE MAX(native_session_catalog.file_size, excluded.file_size)
          END,
          file_mtime_ms=CASE
            WHEN excluded.file_identity != native_session_catalog.file_identity
              THEN excluded.file_mtime_ms
            ELSE MAX(native_session_catalog.file_mtime_ms, excluded.file_mtime_ms)
          END,
          last_activity_at=CASE
            WHEN excluded.file_identity != native_session_catalog.file_identity
              THEN excluded.last_activity_at
            ELSE MAX(native_session_catalog.last_activity_at, excluded.last_activity_at)
          END,
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

  async isNativeMetricsEligible(input: {
    sourceId: string; installationId: string; nativeSessionId: string
  }): Promise<boolean> {
    return this.executor.run(() => Boolean(this.executor.db.prepare(`
      SELECT 1 FROM native_session_catalog
      WHERE source_id=? AND installation_id=? AND native_session_id=?
        AND location_kind='native' AND review_session_id IS NOT NULL
    `).get(input.sourceId,input.installationId,input.nativeSessionId)))
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
      if (input.projectId) {
        if (!this.executor.slimSchema) {
          throw new Error('Project-filtered native Catalog requires slim SQLite')
        }
        predicates.push(`EXISTS (
          SELECT 1 FROM native_session_context AS ctx
          LEFT JOIN workspaces AS ws ON ws.id=ctx.workspace_id
          WHERE ctx.source_id=native_session_catalog.source_id
            AND ctx.installation_id=native_session_catalog.installation_id
            AND ctx.native_session_id=native_session_catalog.native_session_id
            AND COALESCE(ctx.project_id,ws.project_id)=?
        )`)
        values.push(input.projectId)
      }
      const search = input.search?.trim().slice(0, 256)
      if (search) {
        // Parametrized substring search: literal '%' and '_' are NOT SQL wildcards.
        // This only scans compact metadata, never the native event stream.
        predicates.push(`(instr(lower(COALESCE(title,'')), lower(?)) > 0
          OR instr(lower(native_session_id), lower(?)) > 0
          OR instr(lower(source_id), lower(?)) > 0)`)
        values.push(search, search, search)
      }
      if (input.onlyWithoutLegacyReview) {
        // Do not advertise pre-v35 metadata rows that cannot be opened by
        // their synthetic Review ID until their next incremental upsert.
        predicates.push('review_session_id IS NOT NULL')
        // Slim has no legacy SQL Review ownership; only indexed original files.
      }
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
