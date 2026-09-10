export type AgentRescanStatus = 'completed' | 'partial' | 'failed'

export interface AgentRescanFailureDto {
  sourceId: string
  stage: 'detect' | 'assets'
  message: string
}

export interface AgentRescanResponseDto {
  status: AgentRescanStatus
  startedAt: string
  completedAt: string
  sourcesDetected: number
  assetSourcesScanned: number
  assetsDiscovered: number
  assetsRemoved: number
  statesRecorded: number
  statesCleared: number
  failures: AgentRescanFailureDto[]
}
