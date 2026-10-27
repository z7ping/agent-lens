/**
 * Native-only session list, independent from the historical Canonical
 * Observation/SessionSummary table. Missing statistics must remain unknown,
 * never be interpreted as zero.
 */
export interface NativeSessionListQuery {
  limit: number
  sourceId?: string
  installationId?: string
  projectId?: string
  /** Narrow SQL point lookup for one native Review deep link. */
  reviewSessionId?: string
  search?: string
  before?: {
    lastActivityAt: string
    sourceId: string
    installationId: string
    nativeSessionId: string
  }
  /** True only when the Source's full history/Hook coverage is independently certified. */
  coverageCertified?: boolean
  /** Expected live parser version for this Source; omit to mark metrics partial. */
  parserVersion?: string
  /** Per-source live parser/coverage attestation for an unfiltered multi-Agent list. */
  sourceCertifications?: ReadonlyArray<{
    sourceId: string
    parserVersion: string
    coverageCertified: boolean
  }>
}

export interface NativeSessionListItem {
  sourceId: string
  installationId: string
  nativeSessionId: string
  reviewSessionId: string
  lastActivityAt: string
  title?: string
  titleProvenance: 'explicit' | 'generated' | 'native' | 'unknown'
  projectId?: string
  projectName?: string
  workspaceId?: string
  workspacePath?: string
  runtimeProfileId?: string
  metricsState: 'missing' | 'stale' | 'partial' | 'complete'
  /** Only included when an up-to-date native metrics snapshot exists. */
  metrics?: {
    interactionCount: number
    toolCallCount: number
    toolResultCount: number
    toolErrorCount: number
    errorCount: number
    inputTokens: number | null
    outputTokens: number | null
  }
}

export interface NativeSessionListReader {
  query(input: NativeSessionListQuery): Promise<{
    items: NativeSessionListItem[]
    hasMore: boolean
  }>
}
