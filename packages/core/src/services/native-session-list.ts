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
