import type { AgentProductId } from '../domain/common'
import { AGENT_LENS_PLUGIN_API_VERSION } from './plugin'

export type AgentIntegrationCapability =
  | 'source'
  | 'hook'
  | 'runtime'
  | 'live'

export interface AgentIntegrationManifest {
  integrationId: string
  productId: AgentProductId
  displayName: string
  apiVersion: typeof AGENT_LENS_PLUGIN_API_VERSION
  capabilities: readonly AgentIntegrationCapability[]
  componentPluginIds: readonly string[]
}
