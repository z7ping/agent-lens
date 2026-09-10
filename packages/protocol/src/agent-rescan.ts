import type { FacetResponseDto } from './facets'
import type { AgentOverviewResponseDto } from './overview'

export type AgentRescanStatus = 'completed' | 'partial' | 'failed'

export interface AgentRescanFailureDto {
  sourceId: string
  stage: 'detect' | 'assets'
  message: string
}

export interface AgentRescanSummaryDto {
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

export interface AgentRescanResponseDto extends AgentRescanSummaryDto {
  agents: AgentOverviewResponseDto
  facets: FacetResponseDto
}
