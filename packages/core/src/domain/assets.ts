import type {
  AgentInstallationId,
  AssetBindingId,
  AssetDefinitionId,
  EvidenceId,
  RuntimeProfileId,
  ToolDefinitionId,
} from './common'

export type AssetType =
  | 'skill'
  | 'mcp'
  | 'plugin'
  | 'extension'
  | 'hook'
  | 'memory'
  | 'rule'
  | 'builtin'
  | 'unknown'

export interface AssetDefinition {
  id: AssetDefinitionId
  type: AssetType
  canonicalName: string
  displayName?: string
  upstreamIdentity?: string
}

export interface AssetBinding {
  id: AssetBindingId
  assetId: AssetDefinitionId
  installationId: AgentInstallationId
  runtimeProfileId?: RuntimeProfileId
  path?: string
  source?: string
  version?: string
}

export type AssetState =
  | 'installed'
  | 'configured'
  | 'enabled'
  | 'discoverable'
  | 'exposed'
  | 'invoked'

export interface AssetStateObservation {
  id: string
  assetBindingId: AssetBindingId
  state: AssetState
  value: boolean | 'unknown'
  observedAt: string
  evidenceRefs: EvidenceId[]
}

export type ToolSourceType = 'builtin' | 'mcp' | 'plugin' | 'extension' | 'skill-runtime' | 'unknown'

export interface ToolDefinition {
  id: ToolDefinitionId
  canonicalName: string
  displayName?: string
  sourceType: ToolSourceType
  assetDefinitionId?: AssetDefinitionId
  installationId?: AgentInstallationId
  schemaHash?: string
}

export interface AssetDefinitionHint {
  type: AssetType
  canonicalName: string
  displayName?: string
  upstreamIdentity?: string
}

export interface AssetBindingHint {
  assetId: AssetDefinitionId
  installationId: AgentInstallationId
  runtimeProfileId?: RuntimeProfileId
  path?: string
  source?: string
  version?: string
}

export interface AssetStateInput {
  assetBindingId: AssetBindingId
  state: AssetState
  value: boolean | 'unknown'
  observedAt: string
  evidenceRefs: EvidenceId[]
}

export interface ToolDefinitionHint {
  canonicalName: string
  displayName?: string
  sourceType: ToolSourceType
  assetDefinitionId?: AssetDefinitionId
  installationId?: AgentInstallationId
  schemaHash?: string
}
