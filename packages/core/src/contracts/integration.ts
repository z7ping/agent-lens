import type { AgentProductId } from '../domain/common'
import { AGENT_LENS_PLUGIN_API_VERSION } from './plugin'

export type AgentIntegrationCapability =
  | 'source'
  | 'hook'
  | 'runtime'
  | 'live'

export type AgentIntegrationCapabilityAvailability =
  | 'available'
  | 'unavailable'
  | 'error'

export type AgentIntegrationAvailability =
  | 'available'
  | 'partial'
  | 'unavailable'
  | 'error'

export interface AgentIntegrationCapabilityStatus {
  capability: AgentIntegrationCapability
  availability: AgentIntegrationCapabilityAvailability
  reason?: string
}

export interface AgentIntegrationRuntimeStatus {
  integrationId: string
  productId: AgentProductId
  enabled: boolean
  availability: AgentIntegrationAvailability
  capabilities: AgentIntegrationCapabilityStatus[]
}

export interface AgentIntegrationManifest {
  integrationId: string
  productId: AgentProductId
  displayName: string
  apiVersion: typeof AGENT_LENS_PLUGIN_API_VERSION
  capabilities: readonly AgentIntegrationCapability[]
  componentPluginIds: readonly string[]
}
