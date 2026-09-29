export type BackgroundActivityKindDto =
  | 'source-detect'
  | 'source-history'
  | 'source-runtime'
  | 'runtime-startup-audit'
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
  | 'cancelled'
  | 'interrupted'

export interface SourceSyncProgressDto {
  runId: string
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  updatedAt: string
  heartbeatAt: string
  steps: Array<{
    id: 'detected' | 'waiting' | 'scanning' | 'processing' | 'checkpoint' | 'finished'
    state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
    startedAt?: string
    completedAt?: string
  }>
  records: number
  created: number
  merged: number
  unchanged: number
  discoveredUnits?: number
  processedUnits?: number
  currentUnit?: string
}

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
  sync?: SourceSyncProgressDto
}

export interface BackgroundActivityResponseDto {
  generatedAt: string
  active: BackgroundActivityItemDto[]
  recent: BackgroundActivityItemDto[]
  /** 每个参与来源的本轮执行，历史结果不会挤掉等待中的智能体。 */
  sources?: BackgroundActivityItemDto[]
}
