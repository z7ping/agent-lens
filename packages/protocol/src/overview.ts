import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export interface AgentInstallationOverviewDto {
  id: string
  version?: string
  executable?: string
  configRoot?: string
  dataRoot?: string
  firstSeenAt: string
  lastSeenAt: string
}

export interface AgentCapabilityDto {
  name: string
  status: 'available' | 'partial' | 'experimental' | 'unavailable' | 'not-applicable'
  captureModes: string[]
  reason?: string
}

export interface AgentUsedAssetDto {
  type: 'mcp' | 'skill'
  canonicalName: string
  callCount: number
  firstUsedAt: string
  lastUsedAt: string
  confidence: 'high' | 'medium' | 'low'
}

export interface AgentOverviewDto {
  sourceId: string
  productId: string
  displayName: string
  supported: boolean
  enabled: boolean
  detected: boolean
  installations: AgentInstallationOverviewDto[]
  capabilities: AgentCapabilityDto[]
  usedAssets: AgentUsedAssetDto[]
  assetInventoryStatus: 'usage-only'
}

export interface AgentOverviewResponseDto {
  items: AgentOverviewDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}
