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
  scope?: 'installation' | 'user' | 'project' | 'workspace'
  scopeRoot?: string
  path?: string
  source?: string
  version?: string
  states: AgentAssetStateDto[]
}

export interface AgentAssetInventoryDto {
  id: string
  type: 'skill' | 'mcp' | 'plugin' | 'extension' | 'hook' | 'memory' | 'model' | 'prompt' | 'theme' | 'context' | 'rule' | 'builtin' | 'unknown'
  canonicalName: string
  displayName?: string
  upstreamIdentity?: string
  bindings: AgentAssetBindingDto[]
}

export interface AgentIntegrationCapabilityStatusDto {
  capability: 'source' | 'hook' | 'runtime' | 'live' | 'assets'
  availability: 'available' | 'unavailable' | 'error'
  authorization?: 'required' | 'granted'
  reasonCode?:
    | 'authorization-required'
    | 'authorization-restart-required'
    | 'component-start-failed'
    | 'dependency-start-failed'
    | 'live-adapter-missing'
    | 'live-availability-failed'
  reason?: string
}

export interface AgentIntegrationStatusDto {
  availability: 'available' | 'partial' | 'unavailable' | 'error'
  capabilities: AgentIntegrationCapabilityStatusDto[]
}

export interface AgentSummaryDto {
  sourceId: string
  productId: string
  displayName: string
  supported: boolean
  enabled: boolean
  detected: boolean
  installationIds: string[]
  installationCount: number
}

export interface AgentSummaryResponseDto {
  items: AgentSummaryDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface AgentOverviewDto {
  sourceId: string
  productId: string
  displayName: string
  supported: boolean
  enabled: boolean
  detected: boolean
  integration?: AgentIntegrationStatusDto
  installations: AgentInstallationOverviewDto[]
  capabilities: AgentCapabilityDto[]
  assetInventory: AgentAssetInventoryDto[]
  usedAssets: AgentUsedAssetDto[]
  assetInventoryStatus: 'available' | 'unavailable'
}

export interface AgentOverviewResponseDto {
  items: AgentOverviewDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface AgentDetailResponseDto {
  item: AgentOverviewDto
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface AgentEnrichmentResponseDto {
  sourceId: string
  integration?: AgentIntegrationStatusDto
  capabilities: AgentCapabilityDto[]
  usedAssets: AgentUsedAssetDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}
