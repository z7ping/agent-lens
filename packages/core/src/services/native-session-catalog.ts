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
  /** Slim-only project filter through native_session_context (no Legacy Session SQL). */
  projectId?: string
  locationKind?: NativeSessionLocationKind
  /** Metadata-only title/source/native ID matching; never searches message bodies. */
  search?: string
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
  /** Numerically certified sessions are determined only by their original
   * Native Catalog location. Never infer Source evidence from persisted events.
   */
  isNativeMetricsEligible?(input: {
    sourceId: string; installationId: string; nativeSessionId: string
  }): Promise<boolean>
  query(input?: NativeSessionCatalogQuery): Promise<{ items: NativeSessionCatalogEntry[]; hasMore: boolean }>
}
