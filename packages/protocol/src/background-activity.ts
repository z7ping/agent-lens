export type BackgroundActivityKindDto =
  | 'source-detect'
  | 'source-history'
  | 'source-runtime'
  | 'source-assets'
  | 'deferred-indexes'
  | 'projection-rebuild'
  | 'parser-replay'
  | 'source-record-compression'
  | 'retention-purge'
  | 'vacuum'

export type BackgroundActivityStateDto =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'degraded'
  | 'failed'

export interface BackgroundActivityItemDto {
  id: string
  kind: BackgroundActivityKindDto
  state: BackgroundActivityStateDto
  sourceId?: string
  scope?: string
  errorSummary?: string
  startedAt?: string
  updatedAt: string
  completedAt?: string
}

export interface BackgroundActivityResponseDto {
  generatedAt: string
  active: BackgroundActivityItemDto[]
  recent: BackgroundActivityItemDto[]
}
