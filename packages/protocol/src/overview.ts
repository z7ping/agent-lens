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

export interface AgentAssetStateDto {
  state: 'installed' | 'configured' | 'enabled' | 'discoverable' | 'exposed' | 'invoked'
  value: boolean | 'unknown'
  observedAt: string
  evidenceCount: number
}

export interface AgentAssetBindingDto {
  id: string
  installationId: string
  path?: string
  source?: string
  version?: string
  states: AgentAssetStateDto[]
}

export interface AgentAssetInventoryDto {
  id: string
  type: 'skill' | 'mcp' | 'plugin' | 'extension' | 'hook' | 'memory' | 'rule' | 'builtin' | 'unknown'
  canonicalName: string
  displayName?: string
  upstreamIdentity?: string
  bindings: AgentAssetBindingDto[]
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
  assetInventory: AgentAssetInventoryDto[]
  usedAssets: AgentUsedAssetDto[]
  assetInventoryStatus: 'complete' | 'unavailable'
}

export interface AgentOverviewResponseDto {
  items: AgentOverviewDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}
