import { createHash } from 'node:crypto'

/** Stable source-native session identity, independent of temporary Catalog row IDs. */
export function nativeReviewSessionId(sourceId: string, installationId: string, nativeSessionId: string): string {
  return `native:${createHash('sha256').update(
    JSON.stringify([sourceId, installationId, nativeSessionId]),
  ).digest('hex').slice(0, 32)}`
}

/** ADR-0024 B: durable metadata only. No event payloads or Evidence graphs. */
export type NativeSessionLocationKind = 'native' | 'archive'

export interface NativeSessionCatalogEntry {
  sourceId: string
  installationId: string
  nativeSessionId: string
  locationKind: NativeSessionLocationKind
  filePath: string
  fileIdentity: string
  fileSize: number
  fileMtimeMs: number
  lastActivityAt: string
  title?: string
  updatedAt: string
}

export interface NativeSessionCatalogQuery {
  sourceId?: string
  installationId?: string
  locationKind?: NativeSessionLocationKind
  /** Only Catalog sessions without any historical SQL Review observations.
   * Filter in SQL before pagination, not in the client after LIMIT.
   */
  onlyWithoutLegacyReview?: boolean
  limit?: number
  before?: {
    lastActivityAt: string
    sourceId: string
    installationId: string
    nativeSessionId: string
    locationKind: NativeSessionLocationKind
  }
}

export interface NativeSessionCatalogStore {
  upsert(input: NativeSessionCatalogEntry): Promise<void>
  get(input: {
    sourceId: string
    installationId: string
    nativeSessionId: string
    locationKind?: NativeSessionLocationKind
  }): Promise<NativeSessionCatalogEntry | null>
  /** Resolve a deep-link ID by index, without enumerating the native catalog. */
  getByReviewSessionId(id: string): Promise<NativeSessionCatalogEntry | null>
  query(input?: NativeSessionCatalogQuery): Promise<{ items: NativeSessionCatalogEntry[]; hasMore: boolean }>
}
