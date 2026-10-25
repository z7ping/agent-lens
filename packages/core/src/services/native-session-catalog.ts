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
  /** A read-only status check used by both history and runtime writers.
   * A claimed native session must NEVER silently fall back to event persistence.
   */
  hasNativeOnlyWriteClaim(input: {
    sourceId: string; installationId: string; nativeSessionId: string
  }): Promise<boolean>
  /** Durable single-owner write mode; null means unclaimed. */
  getSessionWriteMode(input: {
    sourceId: string; installationId: string; nativeSessionId: string
  }): Promise<'legacy' | 'native-only' | null>
  /** Atomic fallback: legacy wins unless a native-only claim already exists.
   * MUST be called before starting a legacy record transaction.
   */
  claimLegacyWrite(input: {
    sourceId: string; installationId: string; nativeSessionId: string
  }): Promise<'legacy' | 'native-only'>
  /** Atomic, non-destructive claim for a VERIFIED original Source location.
   * Refuses sessions with any legacy SourceRecord or SQL Observation.
   * The caller must separately prove record fingerprint and Source authorization.
   */
  claimNativeOnlyWrite(input: {
    sourceId: string; installationId: string; nativeSessionId: string
    filePath: string; fileIdentity: string
  }): Promise<boolean>
  query(input?: NativeSessionCatalogQuery): Promise<{ items: NativeSessionCatalogEntry[]; hasMore: boolean }>
}
