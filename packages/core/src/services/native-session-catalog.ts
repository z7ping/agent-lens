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
  query(input?: NativeSessionCatalogQuery): Promise<{ items: NativeSessionCatalogEntry[]; hasMore: boolean }>
}
