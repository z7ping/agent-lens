import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export interface AgentFacetDto {
  sourceId: string
  productId: string
  displayName: string
  supported: boolean
  enabled: boolean
  detected: boolean
  installationIds: string[]
}

export interface ProjectFacetDto {
  id: string
  name?: string
  repositoryIdentity?: string
  /** Most recent activity of any indexed session for this project, across all time ranges. */
  lastActivityAt?: string
}

export interface FacetResponseDto {
  agents: AgentFacetDto[]
  projects: ProjectFacetDto[]
  dateRange: { from?: string; to?: string }
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}
